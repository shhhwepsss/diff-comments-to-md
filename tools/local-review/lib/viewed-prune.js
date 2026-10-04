'use strict';

const { findRepoRoot, revExists, localOnly } = require('./git');
const { listFiles } = require('./diff');
const { listCommitFiles } = require('./commits');
const { withLocalFingerprints, localViewOf, modeKeyOf } = require('./viewed');
const { storeFor } = require('./stores/factory');

/**
 * Sweeping stale "viewed" marks out of a review file.
 *
 * A mark stops counting the moment its file's diff changes (lib/viewed.js
 * isViewed) but nothing deletes it, so a review file collects one dead record
 * per version of every file in every view. The sweep deletes exactly the marks
 * isViewed would already refuse — it never changes what the UI shows at the
 * moment it runs. What it does change: a file put back into exactly the state
 * it was marked in used to read as viewed again, and after the sweep it does
 * not (README, "Устаревшие отметки «просмотрено» удаляются сами").
 *
 * When it runs, and on what:
 *  - once per server start, over every local view of the repository the
 *    server was started in (pruneLocalViewed) — git only, never the network
 *    (not even the on-demand fetch of a partial clone: lib/git.js localOnly);
 *    each view is judged by its diff at that moment, so a file that is in
 *    another state just then loses its mark like any other changed file;
 *  - for a PR, on the first /api/state of each of its views per server run
 *    (pruneOpenedPrView), with the diff that request fetched anyway.
 * There is no timer: the tool is started on demand, and that is often enough.
 *
 * Marks that are never swept, because nothing here can tell that they are dead:
 *  - ANY_MODE ('*', the pre-modes format): it counts in whichever view its
 *    fingerprint matches, including every base and commit range nobody listed;
 *  - any key localViewOf does not recognise;
 *  - a view that failed to build for a reason other than a missing revision,
 *    or during whose building git could not be run at all;
 *  - a PR view whose diff came back with no files at all;
 *  - a file whose fingerprint could only be approximated (fingerprintApprox).
 */

// ------------------------------------------------- diff side (git, read-only)

/**
 * True when the view names a revision this repository no longer has: a commit
 * range whose commits were rebased away and collected, a base branch that was
 * deleted. revExists says "no" on any git failure, so a "no" only counts while
 * git still answers for this repository at all.
 */
async function hasMissingRevision(root, view) {
  const revs = view.mode === 'commits' ? [view.from, view.to] : view.mode === 'base' ? [view.base] : [];
  for (const rev of revs) {
    if (!(await revExists(rev, root))) return (await findRepoRoot(root)) !== null;
  }
  return false;
}

/**
 * path -> { fingerprint, fingerprintApprox } of one local view as it is now,
 * through the same functions /api/state lists it with (lib/sources/local-source.js),
 * minus the line counts. Null when the view cannot exist any more (see
 * hasMissingRevision); throws when git simply failed. Both listing functions
 * refuse a revision they cannot find, so the reason is only asked for after
 * a failure — a view that builds costs no extra git call.
 */
async function currentLocalView(root, view) {
  try {
    const { files } =
      view.mode === 'commits'
        ? await listCommitFiles(root, view.from, view.to)
        : await listFiles(root, view.mode, view.base);
    const marked = await withLocalFingerprints(root, view.mode, files);
    return new Map(marked.map((f) => [f.path, f]));
  } catch (err) {
    if (await hasMissingRevision(root, view)) return null;
    throw err;
  }
}

// ------------------------------------------------------ the rule (pure)

/**
 * The marks of one view that no longer hold: [{ file, modeKey, fingerprint }].
 * `current` is the view's file list by path, or null for a view that is gone.
 *
 * A view that is gone loses all its marks. The alternative — keeping them in
 * case the revision comes back — keeps them forever in practice: a commit that
 * was rebased away does not return, the UI cannot open such a view (it answers
 * 404), and these are precisely the records that pile up. If the revision does
 * come back (a re-fetched branch), the files are simply unviewed again.
 */
function deadMarks(viewed, modeKey, current) {
  const dead = [];
  for (const [file, bucket] of Object.entries(viewed)) {
    const record = bucket && Object.prototype.hasOwnProperty.call(bucket, modeKey) ? bucket[modeKey] : null;
    if (!record || typeof record.fingerprint !== 'string') continue;
    const now = current ? current.get(file) : null;
    const live = Boolean(now) && (now.fingerprintApprox === true || now.fingerprint === record.fingerprint);
    if (!live) dead.push({ file, modeKey, fingerprint: record.fingerprint });
  }
  return dead;
}

function modeKeysOf(viewed) {
  const keys = new Set();
  for (const bucket of Object.values(viewed)) {
    if (bucket && typeof bucket === 'object') Object.keys(bucket).forEach((k) => keys.add(k));
  }
  return [...keys];
}

// ------------------------------------------------------------ entry points

/**
 * Drops the stale marks of every local view of `root`; resolves with how many
 * went and never rejects — a sweep that failed is a sweep that did not happen.
 *
 * Meant to run in the background next to a server that is already answering,
 * so the two halves are kept apart: the diffs are built from a snapshot of the
 * marks (slow, asynchronous), and the deletion is one synchronous
 * load-delete-save on a freshly read store that only removes a mark still
 * carrying the fingerprint judged dead (CommentStore.dropViewed). A mark made
 * in between is therefore never lost, whatever the sweep concluded.
 */
async function pruneLocalViewed(root) {
  try {
    const descriptor = { source: 'local', root };
    const viewed = storeFor(descriptor).viewedFiles();
    const dead = [];
    for (const modeKey of modeKeysOf(viewed)) {
      const view = localViewOf(modeKey);
      if (!view) continue;
      let current;
      try {
        current = await localOnly(() => currentLocalView(root, view));
      } catch {
        continue; // could not be built this time: says nothing about its marks
      }
      dead.push(...deadMarks(viewed, modeKey, current));
    }
    return dead.length ? storeFor(descriptor).dropViewed(dead) : 0;
  } catch {
    return 0;
  }
}

// Per server (its request context), the PR views already swept in this run.
const sweptPrViews = new WeakMap();

/**
 * The PR half: `files` is the list /api/state has just fetched for this
 * descriptor, so the sweep costs no request of its own. Only the view that was
 * opened is swept — the diff of any other is not at hand — and only on its
 * first opening per server run, which is the PR's counterpart of "once per
 * start". Never throws: /api/state must answer whether or not this worked.
 */
function pruneOpenedPrView(ctx, descriptor, files) {
  try {
    const store = storeFor(descriptor, ctx.homeDir);
    const modeKey = modeKeyOf(descriptor);
    const swept = sweptPrViews.get(ctx) || new Set();
    sweptPrViews.set(ctx, swept);
    const id = `${store.file}\n${modeKey}`;
    if (swept.has(id)) return 0;
    swept.add(id);
    // A PR with no changed files is far more likely a diff that did not
    // arrive than a diff that emptied; nothing is lost by not deciding.
    if (files.length === 0) return 0;
    const current = new Map(files.map((f) => [f.path, f]));
    const dead = deadMarks(store.viewedFiles(), modeKey, current);
    return dead.length ? store.dropViewed(dead) : 0;
  } catch {
    return 0;
  }
}

module.exports = { pruneLocalViewed, pruneOpenedPrView, deadMarks };
