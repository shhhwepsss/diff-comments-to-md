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
  StateResponse,
  ValidateResponse,
} from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(pathname: string, init?: RequestInit): Promise<T> {
  const res = await fetch(pathname, init);
  const contentType = res.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const message = payload && typeof payload === 'object' && payload.error ? payload.error : `HTTP ${res.status}`;
    throw new ApiError(String(message), res.status);
  }
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

  ghStatus: () => request<GhStatus>('/api/gh/status'),
  searchPrs: (params: { repo?: string; q?: string; state: string }) => {
    const p = new URLSearchParams();
    if (params.repo) p.set('repo', params.repo);
    if (params.q) p.set('q', params.q);
    p.set('state', params.state);
    return request<PrSearchResponse>(`/api/pr/search?${p.toString()}`);
  },
};
