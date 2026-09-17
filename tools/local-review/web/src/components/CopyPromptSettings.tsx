import { useRef, useState } from 'react';
import { Dialog, IconButton, Textarea } from '@primer/react';
import { GearIcon } from '@primer/octicons-react';
import { api } from '../api/client';
import { useToast } from '../lib/toast';

/**
 * The copy prompt: text the export puts after the comments, e.g. "Исправь
 * замечания ревью выше". It lives in ~/.local-review/settings.json, so it is
 * one for every folder and PR, and the server appends it to both the
 * clipboard text and the .md file.
 *
 * The dialog reads the saved value every time it opens, and closing it
 * without «Сохранить» discards the edit.
 */
export function CopyPromptSettings() {
  const toast = useToast();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const show = async () => {
    setOpen(true);
    setLoading(true);
    try {
      setText((await api.settings()).copyPrompt);
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
      const saved = await api.saveSettings({ copyPrompt: text });
      setOpen(false);
      toast(saved.copyPrompt.trim() ? 'Промпт сохранён — добавится в конец экспорта' : 'Промпт очищен — экспортируются только комментарии');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <IconButton
        ref={anchor}
        icon={GearIcon}
        size="small"
        aria-label="Промпт при копировании"
        onClick={() => void show()}
      />
      {open && (
        <Dialog
          title="Промпт при копировании"
          subtitle="Добавляется после комментариев — и в буфер, и в .md-файл. Пусто — экспортируются только комментарии."
          width="large"
          returnFocusRef={anchor}
          onClose={() => setOpen(false)}
          footerButtons={[
            { buttonType: 'default', content: 'Отмена', onClick: () => setOpen(false) },
            { buttonType: 'primary', content: 'Сохранить', onClick: () => void save(), disabled: loading || busy },
          ]}
        >
          <Textarea
            block
            resize="vertical"
            rows={8}
            aria-label="Промпт при копировании"
            placeholder={loading ? 'Загружаю…' : 'Например: Исправь замечания ревью выше. Формат: путь:строка, затем комментарий.'}
            disabled={loading}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void save();
              }
            }}
          />
          <div className="rv-hint">Ctrl+Enter — сохранить</div>
        </Dialog>
      )}
    </>
  );
}
