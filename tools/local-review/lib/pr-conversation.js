'use strict';

const { ghJson } = require('./gh');

// What people wrote on the PR at GitHub: its description, the comments under
// it, the reviews and their threads. Read-only, and only ever through gh.
//
// GitHub keeps this in two lists with a cursor each: the timeline (comments
// and reviews, by creation time) and the review threads (by the creation time
// of their first comment — measured on cli/cli#13541). One gh run brings the
// next page of whichever lists are asked for; the browser merges them.

const PAGE_SIZE = 50;
// GitHub's own maximum for one connection. A thread with more replies than
// this says how many it left out (`more`).
const THREAD_COMMENTS = 100;
// How many lines of a thread's diff hunk are shown above it, like GitHub does.
const HUNK_LINES = 4;

const TTL_MS = 120000;
// "<owner>/<repo>#<number>|<timeline cursor>|<threads cursor>" -> { at, page }
const CACHE = new Map();
const CACHE_LIMIT = 200;

const QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $meta: Boolean!, $timeline: Boolean!, $threads: Boolean!, $timelineAfter: String, $threadsAfter: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      url @include(if: $meta)
      body @include(if: $meta)
      createdAt @include(if: $meta)
      author @include(if: $meta) { login }
      labels(first: 30) @include(if: $meta) { nodes { name color } }
      latestOpinionatedReviews(first: 30) @include(if: $meta) { nodes { state author { login } } }
      reviewRequests(first: 30) @include(if: $meta) {
        nodes { requestedReviewer { __typename ... on User { login } ... on Mannequin { login } ... on Team { name } } }
      }
      commits(last: 1) @include(if: $meta) {
        nodes { commit { statusCheckRollup { state contexts(first: 100) {
          totalCount
          nodes {
            __typename
            ... on CheckRun { name status conclusion detailsUrl }
            ... on StatusContext { context state targetUrl }
          }
        } } } }
      }
      timelineItems(first: ${PAGE_SIZE}, after: $timelineAfter, itemTypes: [ISSUE_COMMENT, PULL_REQUEST_REVIEW]) @include(if: $timeline) {
        pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on IssueComment { id url body createdAt author { login } }
          ... on PullRequestReview { id url body state createdAt author { login } }
        }
      }
      reviewThreads(first: ${PAGE_SIZE}, after: $threadsAfter) @include(if: $threads) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line startLine originalLine
          head: comments(first: 1) { nodes { diffHunk } }
          comments(first: ${THREAD_COMMENTS}) {
            totalCount
            nodes { id url body createdAt author { login } }
          }
        }
      }
    }
  }
}`
  .replace(/\s+/g, ' ')
  .trim();

/**
 * The argv of the one gh run a page costs. `cursors` names the lists to
 * continue: `{ timelineAfter, threadsAfter }`; with neither it is the first
 * page, which also brings the PR's description and its side column.
 */
function conversationArgs(descriptor, cursors) {
  const { timelineAfter, threadsAfter } = cursors || {};
  const first = !timelineAfter && !threadsAfter;
  const args = [
    'api',
    'graphql',
    '-f',
    `owner=${descriptor.owner}`,
    '-f',
    `repo=${descriptor.repo}`,
    '-F',
    `number=${descriptor.number}`,
    '-F',
    `meta=${first}`,
    '-F',
    `timeline=${first || Boolean(timelineAfter)}`,
    '-F',
    `threads=${first || Boolean(threadsAfter)}`,
  ];
  if (timelineAfter) args.push('-f', `timelineAfter=${timelineAfter}`);
  if (threadsAfter) args.push('-f', `threadsAfter=${threadsAfter}`);
  args.push('-f', `query=${QUERY}`);
  return args;
}

/** A deleted account has no author; GitHub shows it as «ghost». */
function loginOf(author) {
  return (author && author.login) || 'ghost';
}

function nodesOf(connection) {
  return ((connection && connection.nodes) || []).filter(Boolean);
}

/** The lines of a diff hunk the thread hangs under: its last few, without the `@@` header. */
function hunkTail(diffHunk) {
  const lines = String(diffHunk || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => !line.startsWith('@@'));
  return lines.slice(-HUNK_LINES);
}

/**
 * A review is worth a row of its own when it says something: a verdict or a
 * body. A bare COMMENTED review is only the envelope of its threads, which
 * are listed themselves; a PENDING one is the reviewer's own unsent draft.
 */
function reviewSaysSomething(review) {
  if (review.state === 'PENDING') return false;
  return Boolean(String(review.body || '').trim()) || review.state !== 'COMMENTED';
}

function mapTimelineItem(node) {
  if (node.__typename === 'IssueComment') {
    return { kind: 'comment', id: node.id, url: node.url, author: loginOf(node.author), body: node.body || '', at: node.createdAt };
  }
  if (node.__typename === 'PullRequestReview' && reviewSaysSomething(node)) {
    return {
      kind: 'review',
      id: node.id,
      url: node.url,
      author: loginOf(node.author),
      body: node.body || '',
      at: node.createdAt,
      state: node.state,
    };
  }
  return null;
}

function mapThread(node) {
  const comments = nodesOf(node.comments).map((c) => ({
    id: c.id,
    url: c.url,
    author: loginOf(c.author),
    body: c.body || '',
    at: c.createdAt,
  }));
  // A thread always has its first comment; one without is not shown at all.
  if (!comments.length) return null;
  const head = nodesOf(node.head)[0];
  const total = (node.comments && node.comments.totalCount) || comments.length;
  return {
    id: node.id,
    path: node.path,
    // null: the line is not in the PR's current diff any more (outdated).
    line: node.line === undefined ? null : node.line,
    startLine: node.startLine === undefined ? null : node.startLine,
    originalLine: node.originalLine === undefined ? null : node.originalLine,
    resolved: Boolean(node.isResolved),
    outdated: Boolean(node.isOutdated),
    hunk: hunkTail(head && head.diffHunk),
    at: comments[0].at,
    comments,
    more: Math.max(0, total - comments.length),
  };
}

/**
 * `through` is when the last entry GitHub sent on this page was created —
 * counted before anything is left out, so a page of bare reviews still says
 * how far the list has been read. The browser shows nothing of the other
 * list past that moment until this one catches up.
 */
function mapList(connection, mapNode, createdAtOf) {
  if (!connection) return undefined;
  const info = connection.pageInfo || {};
  const nodes = nodesOf(connection);
  const dates = nodes.map(createdAtOf).filter(Boolean);
  return {
    items: nodes.map(mapNode).filter(Boolean),
    cursor: info.endCursor || null,
    done: !info.hasNextPage,
    through: dates.length ? dates[dates.length - 1] : null,
  };
}

function threadCreatedAt(node) {
  const first = nodesOf(node.comments)[0];
  return first ? first.createdAt : null;
}

/** One check or commit status in GitHub's two shapes -> { name, state, url }. */
function mapCheck(node) {
  if (node.__typename === 'CheckRun') {
    // Still running: there is no conclusion yet, the status says where it is.
    const state = node.status === 'COMPLETED' ? node.conclusion || 'NEUTRAL' : node.status || 'PENDING';
    return { name: node.name, state, url: node.detailsUrl || null };
  }
  if (node.__typename === 'StatusContext') return { name: node.context, state: node.state, url: node.targetUrl || null };
  return null;
}

function mapMeta(pr) {
  const commit = nodesOf(pr.commits)[0];
  const rollup = commit && commit.commit && commit.commit.statusCheckRollup;
  const checks = rollup ? nodesOf(rollup.contexts).map(mapCheck).filter(Boolean) : [];
  return {
    url: pr.url,
    body: pr.body || '',
    author: loginOf(pr.author),
    createdAt: pr.createdAt,
    labels: nodesOf(pr.labels).map((l) => ({ name: l.name, color: l.color || null })),
    reviewers: nodesOf(pr.latestOpinionatedReviews).map((r) => ({ login: loginOf(r.author), state: r.state })),
    requested: nodesOf(pr.reviewRequests)
      .map((r) => r.requestedReviewer && (r.requestedReviewer.login || r.requestedReviewer.name))
      .filter(Boolean),
    checks: {
      // null: the head commit has no checks at all.
      state: rollup ? rollup.state : null,
      items: checks,
      more: rollup ? Math.max(0, ((rollup.contexts && rollup.contexts.totalCount) || 0) - checks.length) : 0,
    },
  };
}

/** gh's answer -> the page the browser gets: `meta` only on the first one, a list only when asked for. */
function mapConversation(payload) {
  const pr = payload && payload.data && payload.data.repository && payload.data.repository.pullRequest;
  if (!pr) {
    const err = new Error('PR не найден, либо нет доступа.');
    err.userFacing = true;
    err.status = 404;
    throw err;
  }
  const page = {};
  if (pr.url !== undefined) page.meta = mapMeta(pr);
  const timeline = mapList(pr.timelineItems, mapTimelineItem, (node) => node.createdAt);
  if (timeline) page.timeline = timeline;
  const threads = mapList(pr.reviewThreads, mapThread, threadCreatedAt);
  if (threads) page.threads = threads;
  return page;
}

function prKey(descriptor) {
  return `${descriptor.owner}/${descriptor.repo}#${descriptor.number}`;
}

function forget(descriptor) {
  const prefix = `${prKey(descriptor)}|`;
  for (const key of CACHE.keys()) if (key.startsWith(prefix)) CACHE.delete(key);
}

/**
 * One page of the conversation. `fresh` drops everything cached for this PR
 * first («Перечитать PR»): a page cached under an old cursor would otherwise
 * be stitched to a new first page.
 */
async function loadConversation(descriptor, cursors, fresh) {
  const { timelineAfter = '', threadsAfter = '' } = cursors || {};
  if (fresh) forget(descriptor);
  const key = `${prKey(descriptor)}|${timelineAfter}|${threadsAfter}`;
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.page;
  const page = mapConversation(await ghJson(conversationArgs(descriptor, { timelineAfter, threadsAfter })));
  CACHE.set(key, { at: Date.now(), page });
  if (CACHE.size > CACHE_LIMIT) CACHE.delete(CACHE.keys().next().value);
  return page;
}

module.exports = { loadConversation, conversationArgs, mapConversation, hunkTail, PAGE_SIZE };
