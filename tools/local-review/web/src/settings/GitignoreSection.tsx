import { SegmentedControl } from '@primer/react';
import type { Settings } from '../api/types';
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
 *
 * Controlled: the page holds the draft and saves it, this only renders and
 * reports the choice.
 */
export function GitignoreSection({ value, onChange }: { value: Target; onChange: (next: Target) => void }) {
  const current = TARGETS.find((t) => t.value === value);

  return (
    <SettingsSection
      title="Игнорирование .local-review/"
      description="Где прописывать, что папку с комментариями не нужно коммитить. Применяется при подтверждении выбора папки."
    >
      <SegmentedControl aria-label="Куда писать игнор" fullWidth>
        {TARGETS.map((t) => (
          <SegmentedControl.Button key={t.value} selected={t.value === value} onClick={() => onChange(t.value)}>
            {t.label}
          </SegmentedControl.Button>
        ))}
      </SegmentedControl>
      <div className="rv-hint">{current && current.hint}</div>
      <div className="rv-hint">
        Переключение ничего не удаляет: строка, уже записанная в другое место, остаётся там — тула не отличает свою
        строку от той, что правил ты.
      </div>
    </SettingsSection>
  );
}
