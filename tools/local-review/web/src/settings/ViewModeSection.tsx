import { SegmentedControl } from '@primer/react';
import type { ViewMode } from '../api/types';
import { SettingsSection } from './SettingsScreen';

const MODES: { value: ViewMode; label: string; hint: string }[] = [
  {
    value: 'all',
    label: 'Все файлы',
    hint: 'Все файлы диффа идут один под другим, лентой.',
  },
  {
    value: 'single',
    label: 'Один файл',
    hint: 'На экране один файл; остальные открываются из дерева.',
  },
];

/**
 * The view mode the diff screen starts in. It is only a default: once the
 * mode is switched on the diff screen, the browser remembers that choice and
 * this setting no longer decides.
 *
 * Controlled: the page holds the draft and saves it, this only renders and
 * reports the choice.
 */
export function ViewModeSection({ value, onChange }: { value: ViewMode; onChange: (next: ViewMode) => void }) {
  const current = MODES.find((m) => m.value === value);

  return (
    <SettingsSection
      title="Режим просмотра по умолчанию"
      description="Как экран диффа показывает файлы, когда его открывают впервые."
    >
      <SegmentedControl aria-label="Режим просмотра по умолчанию" fullWidth>
        {MODES.map((m) => (
          <SegmentedControl.Button key={m.value} selected={m.value === value} onClick={() => onChange(m.value)}>
            {m.label}
          </SegmentedControl.Button>
        ))}
      </SegmentedControl>
      <div className="rv-hint">{current && current.hint}</div>
      <div className="rv-hint">
        Применяется, пока вы не переключили режим сами: последний выбор запоминается в браузере.
      </div>
    </SettingsSection>
  );
}
