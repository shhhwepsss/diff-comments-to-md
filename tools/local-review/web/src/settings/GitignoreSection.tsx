import { useEffect, useState } from 'react';
import { Button, SegmentedControl, Spinner } from '@primer/react';
import { api } from '../api/client';
import type { Settings } from '../api/types';
import { useToast } from '../lib/toast';
import { SettingsSection } from './SettingsScreen';

type Target = Settings['gitignoreTarget'];

const TARGETS: { value: Target; label: string; hint: string }[] = [
  {
    value: 'project',
    label: '.gitignore репозитория',
    hint: 'Строка `.local-review/` дописывается в корневой .gitignore открытой папки — даже если выбран подкаталог. Её видно в git status, и она уедет в коммит, если её закоммитить.',
  },
  {
    value: 'global',
    label: 'Глобальный игнор',
    hint: 'Строка дописывается в общий для машины файл: core.excludesFile, а если он не задан — ~/.config/git/ignore, и тогда же этот путь прописывается в глобальный git-конфиг. Репозитории при этом не меняются вообще.',
  },
];

/**
 * Where the `.local-review/` ignore line goes. Like every setting here it
 * lives in ~/.local-review/settings.json, so it is one for every folder and
 * PR; the server applies it when a folder is confirmed (POST /api/session).
 */
export function GitignoreSection() {
  const toast = useToast();
  const [target, setTarget] = useState<Target>('project');
  const [saved, setSaved] = useState<Target>('project');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .settings()
      .then((s) => {
        if (!alive) return;
        setTarget(s.gitignoreTarget);
        setSaved(s.gitignoreTarget);
      })
      .catch((e) => alive && toast(e instanceof Error ? e.message : String(e), true))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [toast]);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await api.saveSettings({ gitignoreTarget: target });
      setTarget(next.gitignoreTarget);
      setSaved(next.gitignoreTarget);
      toast(
        next.gitignoreTarget === 'global'
          ? 'Игнор будет писаться в глобальный файл git'
          : 'Игнор будет писаться в .gitignore репозитория',
      );
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  };

  const current = TARGETS.find((t) => t.value === target);

  return (
    <SettingsSection
      title="Игнорирование .local-review/"
      description="Где прописывать, что папку с комментариями не нужно коммитить. Применяется при подтверждении выбора папки."
    >
      {loading ? (
        <Spinner size="small" />
      ) : (
        <>
          <SegmentedControl aria-label="Куда писать игнор" fullWidth>
            {TARGETS.map((t) => (
              <SegmentedControl.Button key={t.value} selected={t.value === target} onClick={() => setTarget(t.value)}>
                {t.label}
              </SegmentedControl.Button>
            ))}
          </SegmentedControl>
          <div className="rv-hint">{current && current.hint}</div>
          <div className="rv-hint">
            Переключение ничего не удаляет: строка, уже записанная в другое место, остаётся там — тула не отличает свою
            строку от той, что правил ты.
          </div>
          <div className="rv-settings__actions">
            <Button onClick={() => setTarget(saved)} disabled={busy || target === saved}>
              Отменить правки
            </Button>
            <Button variant="primary" onClick={() => void save()} disabled={busy || target === saved}>
              Сохранить
            </Button>
          </div>
        </>
      )}
    </SettingsSection>
  );
}
