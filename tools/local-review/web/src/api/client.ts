import type {
  BrowseResponse,
  Comment,
  CommitContext,
  CommitsResponse,
  Descriptor,
  DiffResponse,
  GhStatus,
  PrSearchResponse,
  SessionResponse,
  Settings,
  StateResponse,
  ValidateResponse,
} from './types';
import type { PrAuthorFilter } from '../lib/prAuthor';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Status of an ApiError for a request that never got an HTTP response. */
export const NO_RESPONSE = 0;

/**
 * The text a failed response should show: the server's `{ error }` when it
 * sent one, otherwise the start of a plain-text body (a proxy page, a stack),
 * otherwise just the status.
 */
export function responseErrorMessage(status: number, payload: unknown): string {
  if (payload && typeof payload === 'object' && 'error' in payload && payload.error) return String(payload.error);
  const text = typeof payload === 'string' ? payload.replace(/\s+/g, ' ').trim() : '';
  if (!text) return `HTTP ${status}`;
  return `HTTP ${status}: ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`;
}

/** One line for a toast from whatever a request (or anything else) threw. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}

/** A toast line with what was being done in front: "Не удалось X: reason". */
export function failureMessage(action: string, e: unknown): string {
  return `${action}: ${errorMessage(e)}`;
}

async function request<T>(pathname: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(pathname, init);
  } catch (e) {
    // fetch rejects only when there is no response at all: the review server
    // is down or restarting. The browser's own "Failed to fetch" says nothing.
    throw new ApiError(`Сервер review недоступен (${errorMessage(e)})`, NO_RESPONSE);
  }
  const contentType = res.headers.get('content-type') || '';
  let payload: unknown;
  try {
    payload = contentType.includes('application/json') ? await res.json() : await res.text();
  } catch (e) {
    throw new ApiError(`HTTP ${res.status}: ответ не читается (${errorMessage(e)})`, res.status);
  }
  if (!res.ok) throw new ApiError(responseErrorMessage(res.status, payload), res.status);
  return payload as T;
}

function jsonBody(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/**
 * Descriptor -> query string. One place builds it and every request uses it —
 * including POST and DELETE, so the server reads it from exactly one place.
 */
export function descriptorQuery(d: Descriptor | null, extra?: Record<string, string>): string {
  const p = new URLSearchParams();
  if (d && d.source === 'local') {
    p.set('source', 'local');
    p.set('root', d.root);
    p.set('mode', d.mode);
    // An omitted base means "the repository's default branch" server-side;
    // sending an empty string would be the same thing, but noisier in logs.
    if (d.base) p.set('base', d.base);
    // Local commit range only matters in commits mode: other modes ignore it,
    // and sending it anyway would be a stale range from a previous selection.
    if (d.mode === 'commits' && d.from && d.to) {
      p.set('from', d.from);
      p.set('to', d.to);
    }
  } else if (d && d.source === 'pr') {
    p.set('source', 'pr');
    p.set('host', d.host);
    p.set('owner', d.owner);
    p.set('repo', d.repo);
    p.set('number', String(d.number));
    // Presence of both is what selects the PR's "commits" view.
    if (d.from && d.to) {
      p.set('from', d.from);
      p.set('to', d.to);
    }
  }
  for (const [k, v] of Object.entries(extra || {})) p.set(k, v);
  return p.toString();
}

/**
 * The descriptor to ask /api/commits with. A local `mode=commits` without a
 * range is a 400 on every endpoint (lib/descriptor.js requires both ends), and
 * the address can name that view before a range exists — `?mode=commits` typed
 * by hand, or a repository with no commits at all. The branch history does not
 * depend on the range, so ask for it as a plain working descriptor.
 */
export function commitsListDescriptor(d: Descriptor): Descriptor {
  return d.source === 'local' && d.mode === 'commits' && !(d.from && d.to) ? { ...d, mode: 'working' } : d;
}

export const api = {
  state: (d: Descriptor, fresh = false) =>
    request<StateResponse>(`/api/state?${descriptorQuery(d, fresh ? { fresh: '1' } : undefined)}`),
  diff: (d: Descriptor, file: string, fresh = false) =>
    request<DiffResponse>(`/api/diff?${descriptorQuery(d, fresh ? { file, fresh: '1' } : { file })}`),
  commits: (d: Descriptor, fresh = false) =>
    request<CommitsResponse>(`/api/commits?${descriptorQuery(d, fresh ? { fresh: '1' } : undefined)}`),

  comments: (d: Descriptor) => request<{ comments: Comment[] }>(`/api/comments?${descriptorQuery(d)}`),
  createComment: (
    d: Descriptor,
    body: { file: string; startLine: number | null; endLine: number | null; text: string; commit?: CommitContext },
  ) => request<{ comment: Comment }>(`/api/comments?${descriptorQuery(d)}`, jsonBody('POST', body)),
  createGeneralComment: (d: Descriptor, text: string) =>
    request<{ comment: Comment }>(`/api/comments?${descriptorQuery(d)}`, jsonBody('POST', { general: true, text })),
  updateComment: (d: Descriptor, id: string, text: string) =>
    request<{ comment: Comment }>(`/api/comments/${encodeURIComponent(id)}?${descriptorQuery(d)}`, jsonBody('PUT', { text })),
  deleteComment: (d: Descriptor, id: string) =>
    request<{ removed: string }>(`/api/comments/${encodeURIComponent(id)}?${descriptorQuery(d)}`, { method: 'DELETE' }),
  clearAll: (d: Descriptor) =>
    request<{ removed: number; remaining: number }>(
      `/api/comments/clear-all?${descriptorQuery(d)}`,
      jsonBody('POST', { confirm: true }),
    ),

  setViewed: (d: Descriptor, file: string, fingerprint: string | null, viewed: boolean) =>
    request<{ file: string; viewed: boolean }>(
      `/api/viewed?${descriptorQuery(d)}`,
      jsonBody('POST', viewed ? { file, fingerprint, viewed } : { file, viewed }),
    ),

  exportText: (d: Descriptor) => request<string>(`/api/export/text?${descriptorQuery(d)}`),
  exportFile: (d: Descriptor) =>
    request<{ file: string; path: string; dir: string; count: number }>(`/api/export/file?${descriptorQuery(d)}`, {
      method: 'POST',
    }),

  browse: (path?: string) =>
    request<BrowseResponse>('/api/browse' + (path ? `?path=${encodeURIComponent(path)}` : '')),
  validateRoot: (root: string) => request<ValidateResponse>(`/api/local/validate?root=${encodeURIComponent(root)}`),

  session: () => request<SessionResponse>('/api/session'),
  saveSession: (descriptor: Descriptor) =>
    request<{ ok: true; gitignore?: { changed: boolean } }>('/api/session', jsonBody('POST', { descriptor })),

  settings: () => request<Settings>('/api/settings'),
  saveSettings: (patch: Partial<Settings>) => request<Settings>('/api/settings', jsonBody('PUT', patch)),

  ghStatus: () => request<GhStatus>('/api/gh/status'),
  searchPrs: (params: { repo?: string; q?: string; state: string; author: PrAuthorFilter }) => {
    const p = new URLSearchParams();
    if (params.repo) p.set('repo', params.repo);
    if (params.q) p.set('q', params.q);
    p.set('state', params.state);
    p.set('author', params.author);
    return request<PrSearchResponse>(`/api/pr/search?${p.toString()}`);
  },
};
