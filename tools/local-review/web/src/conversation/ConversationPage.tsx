import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Label, Link, Spinner } from '@primer/react';
import { Blankslate } from '@primer/react/experimental';
import { AlertIcon, CommentIcon, LinkExternalIcon } from '@primer/octicons-react';
import type { Comment, CommentRef, ConversationMeta, ConversationRemark, ConversationThread } from '../api/types';
import { CommentsPanel } from '../comments/CommentsPanel';
import { CommentCard, CommentForm } from '../diff/CommentCard';
import { renderMarkdown } from '../diff/renderMarkdown';
import { formatDate } from '../lib/format';
import { viewHash } from '../lib/hash';
import { editDraftKey } from '../review/drafts';
import { useReview, type RemarkAnchor } from '../review/ReviewContext';
import { loadMoreIndex, remarkRef, threadAnchor, threadLines, threadRef, type FeedItem } from './feed';
import type { Conversation } from './useConversation';
import '../diff/markdown.css';
import './conversation.css';

// The PR's conversation as GitHub has it, read-only: nothing here writes to
// GitHub. What the reviewer can write is a comment for the agent under a
// remark — a local comment like any other, which carries the remark along.
// Loaded with React.lazy: the markdown parser stays out of the main bundle.

type LabelVariant = 'success' | 'danger' | 'attention' | 'secondary' | 'accent' | 'done';

const REVIEW_STATE: Record<string, { text: string; variant: LabelVariant }> = {
  APPROVED: { text: 'одобрено', variant: 'success' },
  CHANGES_REQUESTED: { text: 'нужны правки', variant: 'danger' },
  COMMENTED: { text: 'комментарий', variant: 'secondary' },
  DISMISSED: { text: 'отклонено', variant: 'secondary' },
};

const CHECK_STATE: Record<string, { text: string; variant: LabelVariant }> = {
  SUCCESS: { text: 'прошла', variant: 'success' },
  FAILURE: { text: 'упала', variant: 'danger' },
  ERROR: { text: 'ошибка', variant: 'danger' },
  TIMED_OUT: { text: 'таймаут', variant: 'danger' },
  STARTUP_FAILURE: { text: 'не запустилась', variant: 'danger' },
  ACTION_REQUIRED: { text: 'ждёт действия', variant: 'attention' },
  CANCELLED: { text: 'отменена', variant: 'secondary' },
  SKIPPED: { text: 'пропущена', variant: 'secondary' },
  NEUTRAL: { text: 'нейтрально', variant: 'secondary' },
  STALE: { text: 'устарела', variant: 'secondary' },
  PENDING: { text: 'ждёт', variant: 'attention' },
  EXPECTED: { text: 'ждёт', variant: 'attention' },
  QUEUED: { text: 'в очереди', variant: 'attention' },
  IN_PROGRESS: { text: 'идёт', variant: 'attention' },
  WAITING: { text: 'ждёт', variant: 'attention' },
  REQUESTED: { text: 'ждёт', variant: 'attention' },
};

function StateLabel({ map, state }: { map: Record<string, { text: string; variant: LabelVariant }>; state: string }) {
  const known = map[state];
  return <Label variant={known?.variant ?? 'secondary'}>{known?.text ?? state.toLowerCase()}</Label>;
}

/** A remark's markdown, sanitized (renderMarkdown); remote images stay placeholders. */
function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text).html, [text]);
  if (!text.trim()) return null;
  return <div className="rv-markdown rv-conv__md" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** The comments for the agent written under one remark, and the form for a new one. */
function AgentNotes({ refOf, anchor, open, onClose }: { refOf: () => CommentRef; anchor: RemarkAnchor | null; open: boolean; onClose: () => void }) {
  const review = useReview();
  const { drafts } = review;
  const id = refOf().id;
  const notes = review.comments.filter((c: Comment) => c.ref?.id === id);
  const draftKey = `remark:${id}`;
  if (!notes.length && !open) return null;
  return (
    <div className="rv-conv__notes">
      {notes.map((c) => (
        <CommentCard
          key={c.id}
          comment={c}
          editing={review.editingId === c.id}
          draft={drafts.get(editDraftKey(c.id))}
          onDraftChange={(text) => drafts.set(editDraftKey(c.id), text)}
          onEdit={() => review.startEdit(c.id)}
          onCancelEdit={() => {
            drafts.clear(editDraftKey(c.id));
            review.cancelEdit();
          }}
          onSave={async (text) => {
            const saved = await review.updateComment(c.id, text);
            if (saved) drafts.clear(editDraftKey(c.id));
            return saved;
          }}
          onDelete={() => {
            drafts.clear(editDraftKey(c.id));
            void review.deleteComment(c.id);
          }}
        />
      ))}
      {open && (
        <CommentForm
          label={anchor && anchor.startLine === null ? 'Агенту · строки треда уже нет в диффе, комментарий будет к файлу' : 'Агенту · только локально, уйдёт в экспорт с цитатой'}
          submitLabel="Добавить"
          initial={drafts.get(draftKey)}
          onChange={(text) => drafts.set(draftKey, text)}
          onSubmit={async (text) => {
            const saved = await review.createRemarkComment(anchor, text, refOf());
            if (saved) {
              drafts.clear(draftKey);
              onClose();
            }
            return saved;
          }}
          onCancel={onClose}
        />
      )}
    </div>
  );
}

function AgentButton({ onClick }: { onClick: () => void }) {
  return (
    <Button size="small" variant="invisible" leadingVisual={CommentIcon} onClick={onClick}>
      Агенту
    </Button>
  );
}

function RemarkHead({ remark, children }: { remark: ConversationRemark; children?: ReactNode }) {
  return (
    <div className="rv-conv__head">
      <strong>{remark.author}</strong>
      <span className="rv-conv__when">{formatDate(remark.at)}</span>
      {children}
    </div>
  );
}

function GitHubLink({ url }: { url: string }) {
  return (
    <Link href={url} target="_blank" rel="noreferrer" className="rv-conv__gh" aria-label="Открыть на GitHub">
      <LinkExternalIcon size={12} />
    </Link>
  );
}

/** The PR's description, a comment under it, or a review that says something. */
function RemarkCard({ kind, remark, state, lead }: { kind: 'comment' | 'review' | 'description'; remark: ConversationRemark; state?: string; lead?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <article className="rv-conv__card">
      <RemarkHead remark={remark}>
        {lead && <span className="rv-conv__when">{lead}</span>}
        {state && <StateLabel map={REVIEW_STATE} state={state} />}
        <span className="rv-conv__spacer" />
        {/* A review with no words has nothing to quote, so nothing to answer. */}
        {remark.body.trim() && <AgentButton onClick={() => setOpen(true)} />}
        <GitHubLink url={remark.url} />
      </RemarkHead>
      <Markdown text={remark.body} />
      {kind === 'description' && !remark.body.trim() && <div className="rv-conv__empty">Описания нет.</div>}
      <AgentNotes refOf={() => remarkRef(kind, remark)} anchor={null} open={open} onClose={() => setOpen(false)} />
    </article>
  );
}

function hunkClass(line: string): string {
  if (line.startsWith('+')) return 'rv-conv__code-line is-add';
  if (line.startsWith('-')) return 'rv-conv__code-line is-del';
  return 'rv-conv__code-line';
}

function ThreadCard({ thread }: { thread: ConversationThread }) {
  const review = useReview();
  const [open, setOpen] = useState(false);
  // A resolved thread is settled: one line until asked for.
  const [expanded, setExpanded] = useState(!thread.resolved);
  const lines = threadLines(thread);
  const first = thread.comments[0];
  return (
    <article className="rv-conv__card">
      <div className="rv-conv__head">
        <span className="rv-conv__path">{thread.path}</span>
        {lines && <span className="rv-conv__when">{lines}</span>}
        {thread.outdated && <Label variant="attention">устарел</Label>}
        {thread.resolved && <Label variant="done">решён</Label>}
        <span className="rv-conv__spacer" />
        {thread.resolved && (
          <Button size="small" variant="invisible" aria-expanded={expanded} onClick={() => setExpanded((on) => !on)}>
            {expanded ? 'Свернуть' : `Показать · ${first.author}`}
          </Button>
        )}
        {expanded && <AgentButton onClick={() => setOpen(true)} />}
        {/* A plain link: a middle click opens the diff in another tab. */}
        <Link href={viewHash(review.descriptor, thread.path, thread.line)}>Открыть в диффе</Link>
      </div>
      {expanded && (
        <>
          {thread.hunk.length > 0 && (
            <pre className="rv-conv__code">
              {thread.hunk.map((line, i) => (
                <div key={i} className={hunkClass(line)}>
                  {line || ' '}
                </div>
              ))}
            </pre>
          )}
          {thread.comments.map((c) => (
            <div key={c.id} className="rv-conv__reply">
              <RemarkHead remark={c}>
                <span className="rv-conv__spacer" />
                <GitHubLink url={c.url} />
              </RemarkHead>
              <Markdown text={c.body} />
            </div>
          ))}
          {thread.more > 0 && (
            <div className="rv-conv__empty">
              Ещё {thread.more} в этом треде —{' '}
              <Link href={first.url} target="_blank" rel="noreferrer">
                на GitHub
              </Link>
            </div>
          )}
        </>
      )}
      <AgentNotes refOf={() => threadRef(thread)} anchor={threadAnchor(thread)} open={open} onClose={() => setOpen(false)} />
    </article>
  );
}

function FeedEntry({ entry }: { entry: FeedItem }) {
  if (entry.kind === 'thread') return <ThreadCard thread={entry.thread} />;
  const { item } = entry;
  return <RemarkCard kind={item.kind} remark={item} state={item.kind === 'review' ? item.state : undefined} />;
}

function Side({ meta }: { meta: ConversationMeta }) {
  const { checks } = meta;
  return (
    <aside className="rv-conv__side" aria-label="Сведения о PR-е">
      <section>
        <h2 className="rv-conv__side-title">Ревьюеры</h2>
        {meta.reviewers.length + meta.requested.length === 0 && <div className="rv-conv__empty">Никто не назначен.</div>}
        {meta.reviewers.map((r) => (
          <div key={r.login} className="rv-conv__row">
            <span>{r.login}</span>
            <StateLabel map={REVIEW_STATE} state={r.state} />
          </div>
        ))}
        {meta.requested.map((name) => (
          <div key={name} className="rv-conv__row">
            <span>{name}</span>
            <Label variant="attention">ждём ревью</Label>
          </div>
        ))}
      </section>
      <section>
        <h2 className="rv-conv__side-title">Проверки</h2>
        {checks.items.length === 0 && <div className="rv-conv__empty">Проверок нет.</div>}
        {checks.items.map((c, i) => (
          <div key={`${c.name}-${i}`} className="rv-conv__row">
            {c.url ? (
              <Link href={c.url} target="_blank" rel="noreferrer">
                {c.name}
              </Link>
            ) : (
              <span>{c.name}</span>
            )}
            <StateLabel map={CHECK_STATE} state={c.state} />
          </div>
        ))}
        {checks.more > 0 && <div className="rv-conv__empty">И ещё {checks.more} — на GitHub.</div>}
      </section>
      {meta.labels.length > 0 && (
        <section>
          <h2 className="rv-conv__side-title">Метки</h2>
          <div className="rv-conv__labels">
            {meta.labels.map((l) => (
              <Label key={l.name}>{l.name}</Label>
            ))}
          </div>
        </section>
      )}
    </aside>
  );
}

type Props = {
  conversation: Conversation;
  commentsPanel: boolean;
  onCommentsPanel: (open: boolean) => void;
};

export default function ConversationPage({ conversation, commentsPanel, onCommentsPanel }: Props) {
  const { status, meta, feed, error, loadingMore, moreError, loadMore, reload } = conversation;
  const scroller = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const count = feed.items.length;
  const moreAt = feed.done ? -1 : loadMoreIndex(count);

  // The next page is asked for when the entry at 90% of the feed comes on
  // screen (or is already above it). With nothing shown there is nothing to
  // scroll to: everything loaded is being held back, so ask at once.
  useEffect(() => {
    if (status !== 'ready' || feed.done || loadingMore || moreError) return;
    if (count === 0) {
      loadMore();
      return;
    }
    const target = sentinel.current;
    const root = scroller.current;
    if (!target || !root) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        const passed = entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0);
        if (entry.isIntersecting || passed) loadMore();
      },
      { root },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [status, feed.done, count, moreAt, loadingMore, moreError, loadMore]);

  if (status === 'idle' || status === 'loading') {
    return (
      <div className="rv-center">
        <Spinner size="large" />
      </div>
    );
  }

  if (status === 'error' || !meta) {
    return (
      <div className="rv-center">
        <Blankslate spacious>
          <Blankslate.Visual>
            <AlertIcon size={24} />
          </Blankslate.Visual>
          <Blankslate.Heading>Не удалось загрузить обсуждение</Blankslate.Heading>
          <Blankslate.Description>{error}</Blankslate.Description>
          <Blankslate.PrimaryAction onClick={() => reload(true)}>Повторить</Blankslate.PrimaryAction>
        </Blankslate>
      </div>
    );
  }

  const description: ConversationRemark = { id: meta.url, url: meta.url, author: meta.author, body: meta.body, at: meta.createdAt };

  return (
    <div className="rv-conv">
      <div className="rv-conv__scroll" ref={scroller}>
        <div className="rv-conv__inner">
          <div className="rv-conv__feed">
            <RemarkCard kind="description" remark={description} lead="открыл PR" />
            {feed.items.map((entry, i) => (
              <div key={entry.key} ref={i === moreAt ? sentinel : undefined}>
                <FeedEntry entry={entry} />
              </div>
            ))}
            {feed.done && count === 0 && <div className="rv-conv__empty">Комментариев и ревью пока нет.</div>}
            {loadingMore && (
              <div className="rv-conv__more" role="status">
                <Spinner size="small" /> Загружаю дальше…
              </div>
            )}
            {moreError && (
              <div className="rv-conv__more" role="alert">
                <span>Не удалось загрузить дальше: {moreError}</span>
                <Button size="small" onClick={loadMore}>
                  Повторить
                </Button>
              </div>
            )}
            <div className="rv-hint">В GitHub отсюда ничего не отправляется. Комментарии агенту хранятся локально и попадают в экспорт вместе с цитатой замечания.</div>
          </div>
          {!commentsPanel && <Side meta={meta} />}
        </div>
      </div>
      {commentsPanel && <CommentsPanel onClose={() => onCommentsPanel(false)} />}
    </div>
  );
}
