import { describe, expect, it } from 'vitest';
import type { LspServerStatus, LspStatusResponse } from '../api/types';
import { failureText, indicatorFor, serverForPath } from './session';

const ts: LspServerStatus = {
  id: 'typescript',
  name: 'TypeScript / JavaScript',
  label: 'tsserver',
  extensions: ['.ts', '.tsx', '.js'],
  found: { command: '/r/node_modules/.bin/typescript-language-server', source: 'node_modules' },
  hint: 'npm i -D typescript typescript-language-server',
  state: 'stopped',
  message: null,
};
const java: LspServerStatus = { ...ts, id: 'java', name: 'Java', label: 'jdtls', extensions: ['.java'], found: null, hint: 'jdtls, JDK 21+' };

const status = (servers: LspServerStatus[], available = true): LspStatusResponse => ({
  available,
  root: available ? '/r' : null,
  servers,
  running: [],
  ...(available ? {} : { reason: 'no-clone' as const, message: 'Нет локального клона' }),
});

describe('serverForPath', () => {
  it('picks the server by extension, case-insensitively', () => {
    expect(serverForPath([ts, java], 'src/App.TSX')?.id).toBe('typescript');
    expect(serverForPath([ts, java], 'Main.java')?.id).toBe('java');
  });

  it('has none for files without one, or without an extension', () => {
    expect(serverForPath([ts, java], 'README.md')).toBeNull();
    expect(serverForPath([ts, java], 'Makefile')).toBeNull();
    expect(serverForPath([ts, java], '.ts')).toBeNull();
  });
});

describe('indicatorFor', () => {
  it('shows nothing before the status, and for a language no server handles', () => {
    expect(indicatorFor(null, 'a.ts')).toBeNull();
    expect(indicatorFor(status([ts]), 'a.md')).toBeNull();
  });

  it('names the server once found, and its progress', () => {
    expect(indicatorFor(status([ts]), 'a.ts')).toMatchObject({ tone: 'idle', text: 'LSP · tsserver' });
    expect(indicatorFor(status([{ ...ts, state: 'ready' }]), 'a.ts')).toMatchObject({ tone: 'ready', text: 'LSP · tsserver' });
    expect(indicatorFor(status([{ ...ts, state: 'indexing' }]), 'a.ts')).toMatchObject({ tone: 'busy', text: 'tsserver · индексация…' });
    expect(indicatorFor(status([{ ...ts, state: 'starting' }]), 'a.ts')?.tone).toBe('busy');
    expect(indicatorFor(status([{ ...ts, state: 'failed', message: 'упал' }]), 'a.ts')).toMatchObject({ tone: 'error', title: 'упал' });
  });

  it('says what to install when the server is missing', () => {
    const ind = indicatorFor(status([ts, java]), 'Main.java');
    expect(ind).toMatchObject({ tone: 'off', text: 'LSP не найден' });
    expect(ind?.title).toContain('JDK 21+');
  });

  it('says «by text» for a PR without a clone', () => {
    const ind = indicatorFor(status([ts], false), 'a.ts');
    expect(ind).toMatchObject({ tone: 'off', text: 'По тексту' });
    expect(ind?.title).toContain('Клонировать');
  });

  it('tells an untrusted clone from a missing server', () => {
    const untrusted = { ...ts, found: null, untrusted: { command: '/clone/node_modules/.bin/typescript-language-server' } };
    const ind = indicatorFor(status([untrusted]), 'a.ts');
    expect(ind).toMatchObject({ tone: 'off', text: 'LSP не доверен' });
    expect(ind?.title).toContain('Доверять этому репозиторию');
  });

  it('says why a server on PATH was not started for an untrusted clone', () => {
    const refused = { ...ts, found: null, refused: { command: '/usr/bin/typescript-language-server', why: 'no-typescript' as const } };
    const ind = indicatorFor(status([refused]), 'a.ts');
    expect(ind).toMatchObject({ tone: 'off', text: 'LSP не доверен' });
    expect(ind?.title).toContain('/usr/bin/typescript-language-server');
    expect(ind?.title).toContain('node_modules/typescript клона');
  });
});

describe('failureText', () => {
  it('adds the hint when there is one', () => {
    expect(failureText({ ok: false, reason: 'no-server', message: 'LSP не найден: gopls', hint: 'go install …' })).toBe(
      'LSP не найден: gopls. Установите: go install …',
    );
    expect(failureText({ ok: false, reason: 'timeout', message: 'Не ответил' })).toBe('Не ответил');
  });
});
