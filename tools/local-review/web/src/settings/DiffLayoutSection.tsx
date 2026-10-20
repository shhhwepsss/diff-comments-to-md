import { SegmentedControl } from '@primer/react';
import type { DiffLayout } from '../api/types';
import { SettingsSection } from './SettingsScreen';

const LAYOUTS: { value: DiffLayout; label: string; hint: string }[] = [
  {
    value: 'unified',
    label: 'Одна колонка',
    hint: 'Новая версия файла, удалённые строки — между её строками.',
  },
  {
    value: 'split',
    label: 'Две колонки',
    hint: 'Старая версия слева, новая справа. На узком экране — одна колонка.',
  },
];

/**
 * How the diff of a file is drawn, until the reviewer switches it on the diff
 * screen: from then on the browser remembers that choice.
 *
 * Controlled: the page holds the draft and saves it, this only renders and
 * reports the choice.
 */
export function DiffLayoutSection({ value, onChange }: { value: DiffLayout; onChange: (next: DiffLayout) => void }) {
  const current = LAYOUTS.find((l) => l.value === value);

  return (
    <SettingsSection title="Вид диффа по умолчанию" description="Как показывать изменения файла, когда экран диффа открывают впервые.">
      <SegmentedControl aria-label="Вид диффа по умолчанию" fullWidth>
        {LAYOUTS.map((l) => (
          <SegmentedControl.Button key={l.value} selected={l.value === value} onClick={() => onChange(l.value)}>
            {l.label}
          </SegmentedControl.Button>
        ))}
      </SegmentedControl>
      <div className="rv-hint">{current && current.hint}</div>
      <div className="rv-hint">
        Применяется, пока вы не переключили вид сами: последний выбор запоминается в браузере.
      </div>
    </SettingsSection>
  );
}
