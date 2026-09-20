import { useEffect, useRef, useState } from 'react';
import { Button } from '@primer/react';
import { SettingsSection } from './SettingsScreen';
import { bindingFromEvent, formatBinding, KEYBINDING_ACTIONS, type Keybindings } from '../lib/keybindings';

/**
 * One row: the action, the shortcut it has and the two things you can do to it.
 *
 * «Задать» puts the row into recording: the next keypress with a bindable key
 * becomes the shortcut, Escape leaves recording without changing anything.
 * The listener is on the window and captures, so the key never reaches the
 * rest of the page while the row is recording.
 */
function KeybindingRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (binding: string) => void;
}) {
  const [recording, setRecording] = useState(false);
  // Recording is started by a click and ended by a key; the handler is
  // registered once per recording session and needs the current onChange.
  const commit = useRef(onChange);
  commit.current = onChange;

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecording(false);
        return;
      }
      const binding = bindingFromEvent(e);
      // A lone modifier reports no bindable key: keep waiting for the real one.
      if (!binding) return;
      commit.current(formatBinding(binding));
      setRecording(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording]);

  return (
    <div className="rv-keybinding">
      <span className="rv-keybinding__label">{label}</span>
      <Button
        className="rv-keybinding__value"
        aria-live="polite"
        onClick={() => setRecording(true)}
        disabled={recording}
      >
        {recording ? 'Нажми сочетание…' : value || 'Не задано'}
      </Button>
      <Button variant="invisible" onClick={() => onChange('')} disabled={recording || !value}>
        Очистить
      </Button>
    </div>
  );
}

export function KeybindingsSection({
  value,
  onChange,
}: {
  value: Keybindings;
  onChange: (next: Keybindings) => void;
}) {
  return (
    <SettingsSection
      title="Горячие клавиши"
      description="По умолчанию не задано ничего. Клавиша — буква, цифра или F1–F12, с модификаторами или без; сочетание не срабатывает, пока курсор в поле ввода. Esc всегда выходит из Zen и его назначить нельзя."
    >
      <div className="rv-keybindings">
        {KEYBINDING_ACTIONS.map((action) => (
          <KeybindingRow
            key={action.id}
            label={action.label}
            value={value[action.id]}
            onChange={(binding) => onChange({ ...value, [action.id]: binding })}
          />
        ))}
      </div>
    </SettingsSection>
  );
}
