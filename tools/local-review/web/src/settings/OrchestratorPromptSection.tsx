import { Textarea } from '@primer/react';
import { SettingsSection } from './SettingsScreen';

/**
 * The orchestrator prompt: text only the export of a review session has. The
 * session's «Для оркестратора» section is its general comments and then this —
 * the instruction to the agent that hands the PRs out to other agents. Kept
 * beside the copy prompt in ~/.local-review/settings.json.
 *
 * Controlled, like every section: the page holds the draft and saves it.
 */
export function OrchestratorPromptSection({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  return (
    <SettingsSection
      title="Промпт оркестратора"
      description="Только для экспорта сессии: идёт в раздел «Для оркестратора» после общих комментариев сессии."
    >
      <Textarea
        block
        resize="vertical"
        rows={6}
        aria-label="Промпт оркестратора"
        placeholder="Например: Раздай каждый раздел «## PR #…» отдельному агенту: он правит только свой PR и пушит в его ветку. PR-ы «без замечаний» и «не трогать» пропусти."
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </SettingsSection>
  );
}
