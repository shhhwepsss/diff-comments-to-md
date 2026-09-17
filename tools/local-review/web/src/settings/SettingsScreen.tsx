import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button, Heading, Spinner } from '@primer/react';
import { ArrowLeftIcon } from '@primer/octicons-react';
import { api } from '../api/client';
import type { Settings } from '../api/types';
import { useConfirm } from '../lib/confirm';
import { useToast } from '../lib/toast';
import { CopyPromptSection } from './CopyPromptSection';
import { GitignoreSection } from './GitignoreSection';
import './settings.css';

/**
 * One block of the settings page: a title, a line about what it does and the
 * controls. A section renders the value it is given and reports edits upward —
 * it never talks to the server, so the page can save everything at once.
 */
export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="rv-settings__section">
      <Heading as="h2" className="rv-settings__title">
        {title}
      </Heading>
      <p className="rv-hint rv-settings__description">{description}</p>
      {children}
    </section>
  );
}

/** The keys of `draft` that differ from what the server has. */
function changedKeys(draft: Settings, saved: Settings): (keyof Settings)[] {
  return (Object.keys(draft) as (keyof Settings)[]).filter((key) => draft[key] !== saved[key]);
}

/**
 * The settings page, `#/settings`. It owns the whole of /api/settings: it
 * loads once, hands each section its value and an onChange, and keeps the
 * edits in one draft. «Сохранить» sends a single PUT with only the keys that
 * actually changed (the route patches, so untouched keys keep their value)
 * and there is one toast for the result.
 *
 * Adding a setting is adding a key to the draft and a controlled section that
 * renders it — the save logic below does not change.
 *
 * `back` is the hash the page was opened from (lib/hash.ts), so «Назад»
 * returns to that screen even after a reload or when the address was opened
 * directly.
 */
export function SettingsScreen({ back }: { back: string }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .settings()
      .then((s) => {
        if (!alive) return;
        setSaved(s);
        setDraft(s);
      })
      .catch((e) => alive && toast(e instanceof Error ? e.message : String(e), true));
    return () => {
      alive = false;
    };
  }, [toast]);

  const dirty = draft !== null && saved !== null && changedKeys(draft, saved).length > 0;

  const save = useCallback(async () => {
    if (!draft || !saved || busy) return;
    const keys = changedKeys(draft, saved);
    if (keys.length === 0) return;
    const patch: Partial<Settings> = {};
    for (const key of keys) Object.assign(patch, { [key]: draft[key] });
    setBusy(true);
    try {
      const next = await api.saveSettings(patch);
      setSaved(next);
      setDraft(next);
      toast(keys.length > 1 ? 'Настройки сохранены' : 'Настройка сохранена');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  }, [busy, draft, saved, toast]);

  // Closing or reloading the tab with unsaved edits gets the browser's own
  // warning; leaving the page inside the app is caught by «Назад» below.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const leave = async () => {
    if (dirty) {
      const ok = await confirm({
        title: 'Уйти без сохранения?',
        body: 'Изменения на этой странице не сохранены. Если уйти, они пропадут.',
        confirmLabel: 'Уйти без сохранения',
        danger: true,
      });
      if (!ok) return;
    }
    window.location.hash = back;
  };

  return (
    <div
      className="rv-settings"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          void save();
        }
      }}
    >
      <div className="rv-settings__head">
        <Button leadingVisual={ArrowLeftIcon} onClick={() => void leave()}>
          Назад
        </Button>
        <Heading as="h1" className="rv-settings__heading">
          Настройки
        </Heading>
      </div>

      {draft === null ? (
        <Spinner size="small" />
      ) : (
        <>
          <CopyPromptSection value={draft.copyPrompt} onChange={(copyPrompt) => setDraft({ ...draft, copyPrompt })} />
          <GitignoreSection
            value={draft.gitignoreTarget}
            onChange={(gitignoreTarget) => setDraft({ ...draft, gitignoreTarget })}
          />
          {/* Следующая настройка — ещё одна управляемая секция здесь. */}

          <div className="rv-settings__actions rv-settings__actions--page">
            <span className="rv-hint">{dirty ? 'Есть несохранённые изменения. Ctrl+Enter — сохранить' : 'Всё сохранено'}</span>
            <Button onClick={() => saved && setDraft(saved)} disabled={busy || !dirty}>
              Отменить правки
            </Button>
            <Button variant="primary" onClick={() => void save()} disabled={busy || !dirty}>
              Сохранить
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
