import { api, commitsListDescriptor, errorMessage } from '../api/client';
import type {
  Descriptor,
  LspDefinitionResponse,
  LspFailure,
  LspHoverResponse,
  LspRequest,
  LspServerStatus,
  LspState,
  LspStatusResponse,
} from '../api/types';

// The review's side of the language servers: which one serves a file, what
// it is doing (the indicator in the file header), and the requests. One per
// review; the server does the real work (lib/lsp/).

/** What the indicator in a file header shows. */
export type LspIndicator = {
  /** ready: answering; idle: found, starts on the first request; busy: starting or indexing. */
  tone: 'ready' | 'idle' | 'busy' | 'off' | 'error';
  text: string;
  title: string;
};

const BUSY: ReadonlySet<LspState> = new Set(['starting', 'indexing', 'stopping']);
/** While a server starts or indexes, its state is re-read this often. */
const POLL_MS = 1500;

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/** The server for a file, by its extension; null when none handles it. */
export function serverForPath(servers: readonly LspServerStatus[], path: string): LspServerStatus | null {
  const ext = extensionOf(path);
  return (ext && servers.find((s) => s.extensions.includes(ext))) || null;
}

/**
 * The header indicator for a file, or null when the file's language has no
 * server at all (a README needs no «LSP не найден»).
 */
export function indicatorFor(status: LspStatusResponse | null, path: string): LspIndicator | null {
  if (!status) return null;
  const server = serverForPath(status.servers, path);
  if (!server) return null;
  if (!status.available) {
    return {
      tone: 'off',
      text: 'Без LSP',
      title: status.message || 'LSP работает только для локальной папки: у PR нет локального клона.',
    };
  }
  if (!server.found) {
    return { tone: 'off', text: 'LSP не найден', title: `${server.name}: language server не установлен. Установите: ${server.hint}` };
  }
  const where = server.found.source === 'node_modules' ? 'из node_modules/.bin' : 'из PATH';
  switch (server.state) {
    case 'starting':
      return { tone: 'busy', text: `${server.label} · запуск…`, title: `${server.label} запускается (${where})` };
    case 'indexing':
      return { tone: 'busy', text: `${server.label} · индексация…`, title: `${server.label} индексирует проект — первый ответ может занять время` };
    case 'ready':
      return { tone: 'ready', text: `LSP · ${server.label}`, title: `${server.label} готов (${where}): Ctrl+клик — к определению, наведение — подсказка` };
    case 'failed':
      return { tone: 'error', text: `LSP · ошибка`, title: server.message || `${server.label} упал` };
    default:
      return {
        tone: 'idle',
        text: `LSP · ${server.label}`,
        title: `${server.label} найден ${where}; запустится при первом наведении или переходе`,
      };
  }
}

/** One line for a toast from a failed answer, with what to install when that is the problem. */
export function failureText(f: LspFailure): string {
  return f.hint ? `${f.message}. Установите: ${f.hint}` : f.message;
}

export class LspSession {
  private status: LspStatusResponse | null = null;
  private listeners = new Set<() => void>();
  private pollTimer: number | undefined;
  private disposed = false;

  /**
   * Only the repository matters to a language server, and «commits» without
   * a range yet (the history still loading) is a 400 everywhere: such a view
   * is asked about as the working tree.
   */
  constructor(private readonly view: () => Descriptor) {}

  private descriptor(): Descriptor {
    return commitsListDescriptor(this.view());
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): LspStatusResponse | null => this.status;

  /** Reads the status, and keeps re-reading it while a server starts or indexes. */
  start() {
    this.disposed = false;
    void this.refresh();
  }

  /** No more polling; a request still in flight lands nowhere. */
  stop() {
    this.disposed = true;
    window.clearTimeout(this.pollTimer);
  }

  /** The server that would answer for `path`, from the last status read. */
  serverFor(path: string): LspServerStatus | null {
    return this.status ? serverForPath(this.status.servers, path) : null;
  }

  /** Worth asking at all: a local repository and an installed server for this file. */
  canAsk(path: string): boolean {
    const server = this.serverFor(path);
    return Boolean(this.status?.available && server?.found);
  }

  async refresh(): Promise<void> {
    try {
      const next = await api.lspStatus(this.descriptor());
      if (this.disposed) return;
      this.status = next;
      this.publish();
      this.schedulePoll();
    } catch {
      // No status means no indicator; navigation still reports its own errors.
    }
  }

  definition(req: LspRequest): Promise<LspDefinitionResponse> {
    return this.ask(req.path, () => api.lspDefinition(this.descriptor(), req));
  }

  hover(req: LspRequest, signal?: AbortSignal): Promise<LspHoverResponse> {
    return this.ask(req.path, () => api.lspHover(this.descriptor(), req, signal), signal);
  }

  private async ask<T extends LspDefinitionResponse | LspHoverResponse>(path: string, send: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const server = this.serverFor(path);
    // A first request starts the server: say so at once, not after it answers.
    if (server && server.found && (server.state === 'stopped' || server.state === 'failed')) this.setState(server.id, 'starting', null);
    try {
      const res = await send();
      if (res.server) this.setState(res.server.id, res.server.state, res.ok ? null : res.message, res.server.label);
      return res;
    } catch (e) {
      // Given up by the caller (a newer hover): nothing to learn from it.
      if (signal?.aborted) throw e;
      // The request failed on the way (server down): the state is unknown, read it again.
      void this.refresh();
      throw new Error(errorMessage(e));
    }
  }

  private setState(id: string, state: LspState, message: string | null, label?: string) {
    if (!this.status) return;
    const servers = this.status.servers.map((s) =>
      s.id === id && (s.state !== state || s.message !== message || (label && s.label !== label))
        ? { ...s, state, message, label: label ?? s.label }
        : s,
    );
    if (servers.every((s, i) => s === this.status?.servers[i])) return;
    this.status = { ...this.status, servers };
    this.publish();
    this.schedulePoll();
  }

  private schedulePoll() {
    window.clearTimeout(this.pollTimer);
    if (this.disposed || !this.status?.servers.some((s) => BUSY.has(s.state))) return;
    this.pollTimer = window.setTimeout(() => void this.refresh(), POLL_MS);
  }

  private publish() {
    for (const l of this.listeners) l();
  }
}
