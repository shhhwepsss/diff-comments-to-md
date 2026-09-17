import { useEffect, useState } from 'react';
import { Button, Spinner, Textarea } from '@primer/react';
import { api } from '../api/client';
import { useToast } from '../lib/toast';
import { SettingsSection } from './SettingsScreen';

/**
 * The copy prompt: text the export puts after the comments, e.g. "Исправь
 * замечания ревью выше". It lives in ~/.local-review/settings.json, so it is
 * one for every folder and PR, and the server appends it to both the
 * clipboard text and the .md file.
 */
export function CopyPromptSection() {
  const toast = useToast();
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .settings()
      .then((s) => {
        if (!alive) return;
        setText(s.copyPrompt);
        setSaved(s.copyPrompt);
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
      const next = await api.saveSettings({ copyPrompt: text });
      setText(next.copyPrompt);
      setSaved(next.copyPrompt);
      toast(next.copyPrompt.trim() ? 'Промпт сохранён — добавится в конец экспорта' : 'Промпт очищен — экспортируются только комментарии');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      title="Промпт при копировании"
      description="Добавляется после комментариев — и в буфер, и в .md-файл. Пусто — экспортируются только комментарии."
    >
      {loading ? (
        <Spinner size="small" />
      ) : (
        <>
          <Textarea
            block
            resize="vertical"
            rows={8}
            aria-label="Промпт при копировании"
            placeholder="Например: Исправь замечания ревью выше. Формат: путь:строка, затем комментарий."
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void save();
              }
            }}
          />
          <div className="rv-settings__actions">
            <span className="rv-hint">Ctrl+Enter — сохранить</span>
            <Button onClick={() => setText(saved)} disabled={busy || text === saved}>
              Отменить правки
            </Button>
            <Button variant="primary" onClick={() => void save()} disabled={busy || text === saved}>
              Сохранить
            </Button>
          </div>
        </>
      )}
    </SettingsSection>
  );
}
