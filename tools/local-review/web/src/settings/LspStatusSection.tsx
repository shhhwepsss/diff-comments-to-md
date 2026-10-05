import { useCallback, useEffect, useState } from 'react';
import { Button, Spinner } from '@primer/react';
import { SyncIcon } from '@primer/octicons-react';
import { api, errorMessage } from '../api/client';
import type { Descriptor, LspServerStatus, LspStatusResponse } from '../api/types';
import { SettingsSection } from './SettingsScreen';
// The indicator dots are the file header's.
import '../diff/diff.css';

const STATE_LABEL: Record<string, string> = {
  stopped: 'не запущен',
  starting: 'запускается…',
  indexing: 'индексация…',
  ready: 'работает',
  failed: 'ошибка',
  stopping: 'останавливается…',
};

function ServerRow({ server, available }: { server: LspServerStatus; available: boolean }) {
  const tone = !server.found
    ? 'off'
    : server.state === 'failed'
      ? 'error'
      : server.state === 'ready'
        ? 'ready'
        : server.state === 'stopped'
          ? 'idle'
          : 'busy';
  return (
    <tr>
      <td>{server.name}</td>
      <td>
        <code>{server.label}</code>
      </td>
      <td>
        {server.found ? (
          <span title={server.found.command}>
            {server.found.source === 'node_modules' ? 'node_modules/.bin' : 'PATH'}
          </span>
        ) : (
          <span className="rv-lsp-status__missing">
            не найден — <span className="rv-hint">{server.hint}</span>
          </span>
        )}
      </td>
      <td>
        <span className={`rv-lsp-indicator is-${tone}`} title={server.message ?? undefined}>
          <i className="rv-lsp-indicator__dot" aria-hidden="true" />
          {!server.found ? '—' : available ? STATE_LABEL[server.state] ?? server.state : 'недоступен'}
        </span>
      </td>
    </tr>
  );
}

/**
 * Which language servers code navigation would use, for the repository the
 * settings page was opened from (or, with none, what is on PATH). Read-only:
 * nothing is installed by the tool, the hint says what to install.
 */
export function LspStatusSection({ descriptor }: { descriptor: Descriptor | null }) {
  const [status, setStatus] = useState<LspStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setStatus(await api.lspStatus(descriptor && descriptor.source === 'local' ? descriptor : null));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [descriptor]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <SettingsSection
      title="Навигация по коду (LSP)"
      description="Переход к определению и подсказки при наведении берут language server, установленный у вас: сначала node_modules/.bin репозитория, затем PATH. Сам инструмент ничего не устанавливает. Сервер запускается при первом запросе и останавливается после 10 минут простоя."
    >
      {error && <div className="rv-hint">Не удалось получить статус: {error}</div>}
      {!status && !error && <Spinner size="small" />}
      {status && (
        <>
          <div className="rv-hint">
            {status.root ? (
              <>
                Репозиторий: <code>{status.root}</code>
              </>
            ) : (
              'Репозиторий не выбран — показано, что найдено в PATH.'
            )}
          </div>
          <table className="rv-lsp-status">
            <thead>
              <tr>
                <th>Язык</th>
                <th>Сервер</th>
                <th>Где найден</th>
                <th>Состояние</th>
              </tr>
            </thead>
            <tbody>
              {status.servers.map((s) => (
                <ServerRow key={s.id} server={s} available={status.available || !status.root} />
              ))}
            </tbody>
          </table>
          {status.running.length > 0 && (
            <div className="rv-hint">
              Запущено: {status.running.map((r) => `${r.label} (${STATE_LABEL[r.state] ?? r.state}) — ${r.root}`).join('; ')}
            </div>
          )}
          <div className="rv-hint">
            TypeScript 7 отвечает сам (<code>tsc --lsp</code>), для TypeScript 5–6 нужен typescript-language-server. Java: jdtls
            требует JDK 21+, первый запуск на Maven/Gradle-проекте занимает до минуты, индекс хранится в
            ~/.local-review/jdtls/. F12 в браузере может сначала открыть DevTools — Ctrl+клик и меню по правой кнопке работают
            всегда.
          </div>
        </>
      )}
      <div className="rv-settings__actions">
        <Button size="small" leadingVisual={SyncIcon} onClick={() => void load()} disabled={busy}>
          Обновить
        </Button>
      </div>
    </SettingsSection>
  );
}
