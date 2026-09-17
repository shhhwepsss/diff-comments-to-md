import { useRef, useState } from 'react';
import { Dialog, IconButton, SegmentedControl } from '@primer/react';
import { GearIcon } from '@primer/octicons-react';
import { api } from '../api/client';
import type { Settings } from '../api/types';
import { useToast } from '../lib/toast';

const TARGETS: { value: Settings['gitignoreTarget']; label: string; hint: string }[] = [
  {
    value: 'project',
    label: 'В .gitignore репозитория',
    hint: 'Строка `.local-review/` дописывается в корневой .gitignore открытой папки. Её видно в git status, и она уедет в коммит, если её закоммитить.',
  },
  {
    value: 'global',
    label: 'В глобальный игнор',
    hint: 'Строка дописывается в общий для машины файл (core.excludesFile, по умолчанию ~/.config/git/ignore). Репозитории остаются нетронутыми. Если core.excludesFile не задан, тула пропишет его в глобальный git config.',
  },
];

/**
 * Where the `.local-review/` ignore line goes. The setting lives in
 * ~/.local-review/settings.json, so it is one for every folder and PR, and the
 * server applies it when a folder is confirmed (POST /api/session).
 *
 * Switching the target only adds a line to the new place: a line already
 * written elsewhere is left alone, because the tool cannot tell its own line
 * from one the user edited.
 */
export function GitignoreSettings() {
  const toast = useToast();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<Settings['gitignoreTarget']>('project');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const show = async () => {
    setOpen(true);
    setLoading(true);
    try {
      setTarget((await api.settings()).gitignoreTarget);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
      setOpen(false);
    } finally {
      setLoading(false);
    }
  };

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const saved = await api.saveSettings({ gitignoreTarget: target });
      setOpen(false);
      toast(
        saved.gitignoreTarget === 'global'
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
    <>
      <IconButton
        ref={anchor}
        icon={GearIcon}
        size="small"
        variant="invisible"
        aria-label="Настройки"
        onClick={() => void show()}
      />
      {open && (
        <Dialog
          title="Игнорирование .local-review/"
          subtitle="Где прописывать, что папку с комментариями не нужно коммитить. Применяется при подтверждении выбора папки."
          width="large"
          returnFocusRef={anchor}
          onClose={() => setOpen(false)}
          footerButtons={[
            { buttonType: 'default', content: 'Отмена', onClick: () => setOpen(false) },
            { buttonType: 'primary', content: 'Сохранить', onClick: () => void save(), disabled: loading || busy },
          ]}
        >
          <SegmentedControl aria-label="Куда писать игнор" fullWidth>
            {TARGETS.map((t) => (
              <SegmentedControl.Button
                key={t.value}
                selected={t.value === target}
                disabled={loading}
                onClick={() => setTarget(t.value)}
              >
                {t.label}
              </SegmentedControl.Button>
            ))}
          </SegmentedControl>
          <div className="rv-hint">{loading ? 'Загружаю…' : current && current.hint}</div>
          <div className="rv-hint">
            Переключение ничего не удаляет: строка, уже записанная в другое место, остаётся там.
          </div>
        </Dialog>
      )}
    </>
  );
}
