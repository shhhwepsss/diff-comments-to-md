import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  ApiError,
  commitsListDescriptor,
  descriptorQuery,
  errorMessage,
  failureMessage,
  NO_RESPONSE,
  responseErrorMessage,
} from './client';

const local = { source: 'local' as const, root: '/repo', mode: 'working' as const, base: '' };
const pr = { source: 'pr' as const, host: 'github.com', owner: 'o', repo: 'r', number: 25 };

describe('commitsListDescriptor', () => {
  it('asks for the branch history without a range the server would reject', () => {
    // `?mode=commits` out of the address, or a repository with no commits yet:
    // the server needs both ends of the range or answers 400.
    const asked = commitsListDescriptor({ ...local, mode: 'commits' });
    expect(asked).toEqual({ ...local, mode: 'working' });
    expect(new URLSearchParams(descriptorQuery(asked)).get('mode')).toBe('working');
    expect(commitsListDescriptor({ ...local, mode: 'commits', from: 'aaa111' })).toEqual({
      ...local,
      mode: 'working',
      from: 'aaa111',
    });
  });

  it('leaves a resolved range and a PR alone', () => {
    const ranged = { ...local, mode: 'commits' as const, from: 'aaa111', to: 'bbb222' };
    expect(commitsListDescriptor(ranged)).toBe(ranged);
    expect(commitsListDescriptor(local)).toBe(local);
    expect(commitsListDescriptor(pr)).toBe(pr);
    expect(commitsListDescriptor({ ...pr, from: 'aaa111', to: 'bbb222' })).toEqual({ ...pr, from: 'aaa111', to: 'bbb222' });
  });
});

describe('responseErrorMessage', () => {
  it("prefers the server's { error } text", () => {
    expect(responseErrorMessage(400, { error: 'Нужен root' })).toBe('Нужен root');
  });

  it('falls back to the status when the JSON has no error', () => {
    expect(responseErrorMessage(500, {})).toBe('HTTP 500');
    expect(responseErrorMessage(500, null)).toBe('HTTP 500');
  });

  it('includes a plain-text body, collapsed to one line', () => {
    expect(responseErrorMessage(502, '  Bad\n  gateway \n')).toBe('HTTP 502: Bad gateway');
  });

  it('cuts a long text body', () => {
    const message = responseErrorMessage(500, 'x'.repeat(500));
    expect(message).toBe(`HTTP 500: ${'x'.repeat(200)}…`);
  });
});

describe('errorMessage / failureMessage', () => {
  it('reads Error messages and stringifies anything else', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(new TypeError(''))).toBe('TypeError');
  });

  it('prefixes the action', () => {
    expect(failureMessage('Не удалось загрузить сессию', new Error('HTTP 500'))).toBe(
      'Не удалось загрузить сессию: HTTP 500',
    );
  });
});

describe('request errors', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('turns a network failure into an ApiError that names the server', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const e = await api.session().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(NO_RESPONSE);
    expect((e as ApiError).message).toBe('Сервер review недоступен (Failed to fetch)');
  });

  it('carries the JSON error text and status of a failed response', async () => {
    const res = new Response(JSON.stringify({ error: 'не git-репозиторий' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res));
    const e = await api.validateRoot('/tmp').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(400);
    expect((e as ApiError).message).toBe('не git-репозиторий');
  });

  it('reports an unreadable JSON body instead of a bare SyntaxError', async () => {
    const res = new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res));
    const e = await api.session().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).message).toMatch(/^HTTP 200: ответ не читается \(/);
  });

  it('still resolves a successful response', async () => {
    const res = new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res));
    await expect(api.saveSession({ source: 'local', root: '/r', mode: 'working', base: '' })).resolves.toEqual({ ok: true });
  });
});
