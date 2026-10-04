import { SegmentedControl } from '@primer/react';
import { SettingsSection } from './SettingsScreen';

const SCOPES: { value: boolean; label: string; hint: string }[] = [
  {
    value: true,
    label: 'Для всех файлов',
    hint: '«Просмотр» или «Код», выбранный в одном файле, включается сразу во всех файлах, где есть просмотр, — и в ленте, и в режиме одного файла.',
  },
  {
    value: false,
    label: 'Для каждого файла отдельно',
    hint: 'Переключатель меняет вид только своего файла; остальные остаются как были.',
  },
];

/**
 * Whether «Код» / «Просмотр» in a file's header is one switch for every file
 * or that file's own (diff/renderMode.ts). The choice of view itself is not
 * stored anywhere: it lasts until the review is closed or the page reloaded.
 *
 * Controlled: the page holds the draft and saves it, this only renders and
 * reports the choice.
 */
export function RenderModeSection({ value, onChange }: { value: boolean; onChange: (next: boolean) => void }) {
  const current = SCOPES.find((s) => s.value === value);

  return (
    <SettingsSection
      title="Вид файла: «Код» / «Просмотр»"
      description="На что действует переключатель вида в шапке файла."
    >
      <SegmentedControl aria-label="На что действует переключатель вида файла" fullWidth>
        {SCOPES.map((s) => (
          <SegmentedControl.Button key={String(s.value)} selected={s.value === value} onClick={() => onChange(s.value)}>
            {s.label}
          </SegmentedControl.Button>
        ))}
      </SegmentedControl>
      <div className="rv-hint">{current && current.hint}</div>
      <div className="rv-hint">Файлы, у которых просмотра нет, всегда показываются кодом.</div>
    </SettingsSection>
  );
}
