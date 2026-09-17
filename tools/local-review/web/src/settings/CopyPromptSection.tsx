import { Textarea } from '@primer/react';
import { SettingsSection } from './SettingsScreen';

/**
 * The copy prompt: text the export puts after the comments, e.g. "Исправь
 * замечания ревью выше". It lives in ~/.local-review/settings.json, so it is
 * one for every folder and PR, and the server appends it to both the
 * clipboard text and the .md file.
 *
 * Controlled: the page holds the draft and saves it, this only renders and
 * reports edits. Ctrl+Enter is handled by the page.
 */
export function CopyPromptSection({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  return (
    <SettingsSection
      title="Промпт при копировании"
      description="Добавляется после комментариев — и в буфер, и в .md-файл. Пусто — экспортируются только комментарии."
    >
      <Textarea
        block
        resize="vertical"
        rows={8}
        aria-label="Промпт при копировании"
        placeholder="Например: Исправь замечания ревью выше. Формат: путь:строка, затем комментарий."
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </SettingsSection>
  );
}
