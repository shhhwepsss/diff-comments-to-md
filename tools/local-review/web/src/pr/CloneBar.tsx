import { useCallback, useEffect, useRef, useState } from 'react';
import { ActionList, ActionMenu, Button, Checkbox, Dialog, FormControl, IconButton, Spinner, TextInput } from '@primer/react';
import { AlertIcon, CheckIcon, CircleIcon, KebabHorizontalIcon, RepoCloneIcon, XCircleIcon } from '@primer/octicons-react';
import { api, errorMessage, failureMessage } from '../api/client';
import type { CloneJob, PrDescriptor } from '../api/types';
import { useReview } from '../review/ReviewContext';
import { useToast } from '../lib/toast';
import { cloneCommands, headWarning, linkCommands, repoArg } from './cloneText';
import './clone.css';

// The bar above a PR's diff about its local clone (lib/pr-clone.js), and the
// dialog that makes one: «Клонировать…» (gh repo clone + gh pr checkout into
// a folder of the reviewer's choosing) or «Указать свой клон». The reviewer
// stays on the PR page all along: the diff and the comments are the PR's,
// only code navigation moves from the search by text to the language server.

const POLL_MS = 700;

/** Follows a clone/checkout job until it ends; `onEnd` gets its last state. */
function useJob(onEnd: (job: CloneJob) => void) {
  const [job, setJob] = useState<CloneJob | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const end = useRef(onEnd);
  end.current = onEnd;
  const follow = useCallback((first: CloneJob) => {
    window.clearTimeout(timer.current);
    setJob(first);
    if (first.status !== 'running') {
      end.current(first);
      return;
    }
    const tick = async () => {
      try {
        const { job: next } = await api.prCloneJob(first.id);
        setJob(next);
        if (next.status === 'running') timer.current = window.setTimeout(tick, POLL_MS);
        else end.current(next);
      } catch (e) {
        const failed: CloneJob = { ...first, status: 'failed', error: errorMessage(e) };
        setJob(failed);
        end.current(failed);
      }
    };
    timer.current = window.setTimeout(tick, POLL_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { job, follow, reset: () => setJob(null) };
}

function JobSteps({ job }: { job: CloneJob }) {
  return (
    <ol className="rv-clone-steps" aria-label="Шаги">
      {job.steps.map((label, i) => {
        const state = i < job.step ? 'done' : i === job.step ? (job.status === 'failed' ? 'failed' : job.status === 'done' ? 'done' : 'running') : 'pending';
        return (
          <li key={label} className={`rv-clone-steps__item is-${state}`}>
            <span className="rv-clone-steps__icon" aria-hidden="true">
              {state === 'done' ? <CheckIcon /> : state === 'failed' ? <XCircleIcon /> : state === 'running' ? <Spinner size="small" /> : <CircleIcon />}
            </span>
            <code>{label}</code>
          </li>
        );
      })}
    </ol>
  );
}

type DialogKind = 'clone' | 'link';

function CloneDialog({ kind, pr, initialDir, onClose }: { kind: DialogKind; pr: PrDescriptor; initialDir: string; onClose: () => void }) {
  const review = useReview();
  const toast = useToast();
  const [dir, setDir] = useState(initialDir);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { job, follow } = useJob((last) => {
    setBusy(false);
    // The clone is bound as soon as it exists, so a failed checkout still leaves one.
    void review.refreshClone().then((status) => {
      if (last.status === 'done') {
        toast(`Клон готов: ${status?.path ?? dir} — LSP работает по клону`);
        onClose();
      }
    });
    if (last.status === 'failed') setError(last.error || 'Команда не выполнилась');
  });
  // A clone started before a reload is still running: show it.
  const running = review.clone?.job?.status === 'running' ? review.clone.job : null;
  useEffect(() => {
    if (running && kind === 'clone' && !job) {
      setBusy(true);
      follow(running);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      if (kind === 'clone') {
        const res = await api.prCloneStart(pr, { action: 'clone', dir });
        follow(res.job);
        return;
      }
      const status = await api.prCloneSet(pr, { action: 'link', dir });
      review.setCloneStatus(status);
      setBusy(false);
      toast(
        status.onHead === false
          ? `Клон указан: ${status.path}. Он не на коммите PR — переключить можно кнопкой над диффом`
          : `Клон указан: ${status.path} — LSP работает по клону`,
      );
      onClose();
    } catch (e) {
      setBusy(false);
      setError(errorMessage(e));
    }
  };

  const clone = kind === 'clone';
  return (
    <Dialog
      title={clone ? 'Клонировать репозиторий PR' : 'Указать существующий клон'}
      width="large"
      onClose={() => onClose()}
      footerButtons={[
        { buttonType: 'default', content: busy ? 'Скрыть' : 'Отмена', onClick: onClose },
        {
          buttonType: 'primary',
          content: clone ? 'Клонировать' : 'Использовать',
          onClick: () => void submit(),
          disabled: busy || !dir.trim(),
          loading: busy,
        },
      ]}
    >
      <div className="rv-clone-dialog">
        <p className="rv-clone-dialog__text">
          {clone
            ? 'Клон останется у вас в выбранной папке. Дифф и комментарии PR не изменятся, LSP будет работать по клону.'
            : `Папка должна быть корнем клона ${repoArg(pr)}. Ничего в ней не меняется; если клон не на коммите PR, над диффом появится кнопка переключения.`}
        </p>
        <FormControl disabled={busy}>
          <FormControl.Label>Папка</FormControl.Label>
          <TextInput
            block
            monospace
            value={dir}
            placeholder={`~/projects/${pr.repo}`}
            onChange={(e) => setDir(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy && dir.trim()) void submit();
            }}
            aria-describedby="rv-clone-cmd"
          />
          <FormControl.Caption>
            {clone ? 'Папки не должно быть, или она должна быть пустой.' : 'Абсолютный путь или ~/…'}
          </FormControl.Caption>
        </FormControl>
        <div className="rv-clone-dialog__label">{clone ? 'Сервер выполнит (без shell):' : 'Сервер проверит:'}</div>
        <pre className="rv-clone-dialog__cmd" id="rv-clone-cmd">
          {clone ? cloneCommands(pr, dir) : linkCommands(pr, dir)}
        </pre>
        {job && <JobSteps job={job} />}
        {busy && job?.status === 'running' && <div className="rv-clone-progress" role="progressbar" aria-label="Клонирование" />}
        {error && (
          <div className="rv-clone-dialog__error" role="alert">
            <AlertIcon /> {error}
          </div>
        )}
        {job?.status === 'failed' && job.log.trim() && <pre className="rv-clone-dialog__log">{job.log.trim()}</pre>}
      </div>
    </Dialog>
  );
}

/** The bar itself: nothing to show for a folder, or until the clone's status is known. */
export function CloneBar() {
  const review = useReview();
  const toast = useToast();
  const { descriptor, clone } = review;
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [trustBusy, setTrustBusy] = useState(false);
  const checkout = useJob((last) => {
    void review.refreshClone();
    if (last.status === 'done') toast('Клон переключён на PR');
    else toast(`gh pr checkout не выполнен: ${last.error ?? ''}`, true);
  });

  if (descriptor.source !== 'pr' || !clone) return null;
  const pr = descriptor;

  const set = async (body: Parameters<typeof api.prCloneSet>[1], what: string) => {
    try {
      review.setCloneStatus(await api.prCloneSet(pr, body));
    } catch (e) {
      toast(failureMessage(what, e), true);
    }
  };

  const startCheckout = async () => {
    try {
      const res = await api.prCloneStart(pr, { action: 'checkout' });
      checkout.follow(res.job);
    } catch (e) {
      toast(failureMessage('Не удалось переключить клон', e), true);
    }
  };

  const dialogEl = dialog && (
    <CloneDialog
      kind={dialog}
      pr={pr}
      initialDir={dialog === 'clone' ? clone.suggested : clone.path ?? ''}
      onClose={() => setDialog(null)}
    />
  );

  const ready = clone.bound && clone.valid;
  if (!ready) {
    const running = clone.job?.status === 'running' && clone.job.kind === 'clone';
    return (
      <>
        <div className="rv-clonebar is-text" role="region" aria-label="Локальный клон PR">
          <RepoCloneIcon className="rv-clonebar__icon" />
          <div className="rv-clonebar__body">
            {clone.bound && clone.problem ? <strong>{clone.problem}. </strong> : <strong>Нет локального клона — </strong>}
            навигация по тексту: Ctrl+клик и F12 ищут объявления в файлах диффа, Shift+F12 — слово целиком. Подсказки, реализации и
            иерархия вызовов выключены.
          </div>
          {running ? (
            <Button size="small" leadingVisual={Spinner} onClick={() => setDialog('clone')}>
              Клонирую…
            </Button>
          ) : (
            <>
              <Button size="small" variant="primary" onClick={() => setDialog('clone')}>
                Клонировать…
              </Button>
              <Button size="small" onClick={() => setDialog('link')}>
                Указать свой клон
              </Button>
            </>
          )}
        </div>
        {dialogEl}
      </>
    );
  }

  const warning = headWarning(clone, pr.number);
  const switching = checkout.job?.status === 'running';
  return (
    <>
      <div className={`rv-clonebar${warning ? ' is-warning' : ''}`} role="region" aria-label="Локальный клон PR">
        {warning ? <AlertIcon className="rv-clonebar__icon" /> : <RepoCloneIcon className="rv-clonebar__icon" />}
        <div className="rv-clonebar__body">
          {warning ?? (
            <>
              LSP работает по клону <code title={clone.path}>{clone.path}</code>
            </>
          )}
        </div>
        {warning && (
          <Button
            size="small"
            disabled={switching || clone.dirty}
            leadingVisual={switching ? Spinner : undefined}
            title={clone.dirty ? 'В клоне есть незакоммиченные изменения — переключение отменится' : `Выполнить в ${clone.path}`}
            onClick={() => void startCheckout()}
          >
            {switching ? 'Переключаю…' : `gh pr checkout ${pr.number}`}
          </Button>
        )}
        {clone.repoBin && (
          <label
            className="rv-clonebar__trust"
            title="Это чужой код: language server из node_modules/.bin клона запускается, только если вы доверяете репозиторию. Иначе — только из PATH."
          >
            <Checkbox
              checked={Boolean(clone.trusted)}
              disabled={trustBusy}
              onChange={(e) => {
                setTrustBusy(true);
                void set({ action: 'trust', trusted: e.target.checked }, 'Не удалось сохранить доверие').finally(() => setTrustBusy(false));
              }}
            />
            Доверять этому репозиторию (запускать серверы из node_modules/.bin)
          </label>
        )}
        <ActionMenu>
          <ActionMenu.Anchor>
            <IconButton icon={KebabHorizontalIcon} aria-label="Клон: действия" size="small" variant="invisible" />
          </ActionMenu.Anchor>
          <ActionMenu.Overlay width="medium" align="end">
            <ActionList>
              <ActionList.Item onSelect={() => setDialog('link')}>Указать другой клон…</ActionList.Item>
              <ActionList.Item onSelect={() => setDialog('clone')}>Клонировать заново…</ActionList.Item>
              <ActionList.Divider />
              <ActionList.Item variant="danger" onSelect={() => void set({ action: 'unlink' }, 'Не удалось отвязать клон')}>
                Отвязать клон (папка останется)
              </ActionList.Item>
            </ActionList>
          </ActionMenu.Overlay>
        </ActionMenu>
      </div>
      {dialogEl}
    </>
  );
}
