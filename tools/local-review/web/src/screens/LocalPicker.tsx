import { useCallback, useEffect, useState } from 'react';
import { Banner, Button, FormControl, Heading, Spinner, TextInput } from '@primer/react';
import { ArrowUpIcon, FileDirectoryIcon, HistoryIcon, RepoIcon } from '@primer/octicons-react';
import { api } from '../api/client';
import type { BrowseEntry, BrowseResponse, RecentRepo } from '../api/types';
import { hashFor } from '../lib/hash';
import { useToast } from '../lib/toast';
import { useConfirm } from '../lib/confirm';
import './picker.css';

function Row({ entry, onDescend, onOpen }: { entry: BrowseEntry; onDescend?: () => void; onOpen: () => void }) {
  const Icon = entry.isRepo ? RepoIcon : FileDirectoryIcon;
  return (
    <li className={`rv-row${entry.isRepo ? ' rv-row--repo' : ''}`}>
      <button
        type="button"
        className="rv-row__main"
        onClick={onDescend ?? onOpen}
        title={onDescend ? `Зайти в ${entry.path}` : `Открыть ${entry.path}`}
      >
        <Icon className="rv-row__icon" />
        <span className="rv-row__name">{entry.name}</span>
        {entry.isRepo && <span className="rv-row__tag">репозиторий</span>}
      </button>
      <Button size="small" variant={entry.isRepo ? 'primary' : 'default'} onClick={onOpen}>
        Открыть
      </Button>
    </li>
  );
}

export function LocalPicker() {
  const toast = useToast();
  const confirm = useConfirm();
  const [data, setData] = useState<BrowseResponse | null>(null);
  const [recent, setRecent] = useState<RecentRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState('');

  const browse = useCallback(
    async (path?: string) => {
      setLoading(true);
      try {
        const [next, session] = await Promise.all([api.browse(path), api.session()]);
        setData(next);
        // Recents come from the home config, not from the directory being browsed.
        setRecent(session.recent || []);
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), true);
      } finally {
        setLoading(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    void browse();
  }, [browse]);

  const openFolder = async (value: string) => {
    const path = value.trim();
    if (!path) return;
    try {
      const v = await api.validateRoot(path);
      if (!v.ok || !v.repoRoot) {
        setError(v.error || `${path} — не git-репозиторий.`);
        return; // stay on the picker
      }
      if (!v.sameAsRequested) {
        const ok = await confirm({
          title: 'Открыть корень репозитория?',
          body: `Выбран ${v.requested}. Это подкаталог репозитория ${v.repoRoot}. Дифф будем читать из корня ${v.repoRoot}. Открыть?`,
          confirmLabel: 'Открыть корень',
        });
        if (!ok) {
          toast('Отменено — ничего не открыто');
          return;
        }
      }
      setError(null);
      // Empty base: the server resolves the repository's default branch.
      const descriptor = { source: 'local' as const, root: v.repoRoot, mode: 'working' as const, base: '' };
      const saved = await api.saveSession(descriptor);
      if (saved.gitignore && saved.gitignore.changed) {
        toast(
          saved.gitignore.target === 'global'
            ? `В глобальный игнор (${saved.gitignore.file}) добавлено .local-review/`
            : 'В .gitignore репозитория добавлено .local-review/',
        );
      }
      window.location.hash = hashFor(descriptor);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    }
  };

  return (
    <div className="rv-page">
      <div className="rv-page__head">
        <Heading as="h1" className="rv-page__title">
          Локальная папка
        </Heading>
        <p className="rv-page__hint">
          Выбери корень git-репозитория. Клик по строке — зайти внутрь, «Открыть» — открыть эту папку.
        </p>
      </div>

      {error && (
        <Banner variant="critical" title="Не получилось открыть" onDismiss={() => setError(null)} className="rv-page__banner">
          {error}
        </Banner>
      )}

      <section className="rv-box">
        <div className="rv-box__head">
          {data?.parent && (
            <Button size="small" leadingVisual={ArrowUpIcon} onClick={() => void browse(data.parent ?? undefined)}>
              Вверх
            </Button>
          )}
          {data?.path ? (
            <span className="rv-box__path">{data.path}</span>
          ) : (
            <span className="rv-box__title">Начни с домашней папки или недавних</span>
          )}
          {loading && <Spinner size="small" />}
        </div>
        <ul className="rv-list">
          {data?.entries.map((entry) => (
            <Row
              key={entry.path}
              entry={entry}
              onDescend={() => void browse(entry.path)}
              onOpen={() => void openFolder(entry.path)}
            />
          ))}
          {data && data.entries.length === 0 && <li className="rv-list__empty">Подкаталогов нет</li>}
        </ul>
      </section>

      <section className="rv-box">
        <div className="rv-box__head">
          <HistoryIcon />
          <span className="rv-box__title">Недавние</span>
        </div>
        <ul className="rv-list">
          {recent.map((r) => (
            <Row key={r.root} entry={{ name: r.root, path: r.root, isRepo: true }} onOpen={() => void openFolder(r.root)} />
          ))}
          {recent.length === 0 && <li className="rv-list__empty">Пока пусто</li>}
        </ul>
      </section>

      <form
        className="rv-manual"
        onSubmit={(e) => {
          e.preventDefault();
          void openFolder(manual);
        }}
      >
        <FormControl className="rv-manual__field">
          <FormControl.Label>Или вставь путь целиком</FormControl.Label>
          <TextInput
            block
            spellCheck={false}
            placeholder="C:\projects\my-repo"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            className="rv-mono"
          />
        </FormControl>
        <Button type="submit" variant="primary">
          Открыть
        </Button>
      </form>
    </div>
  );
}
