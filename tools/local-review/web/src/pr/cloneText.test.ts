import { describe, expect, it } from 'vitest';
import type { PrCloneStatus, PrDescriptor } from '../api/types';
import { cloneCommands, headWarning, linkCommands, repoArg, shortSha } from './cloneText';

const pr: PrDescriptor = { source: 'pr', host: 'github.com', owner: 'acme', repo: 'web', number: 128 };

describe('cloneText', () => {
  it('names the repository as gh does', () => {
    expect(repoArg(pr)).toBe('acme/web');
    expect(repoArg({ ...pr, host: 'ghe.example.com' })).toBe('ghe.example.com/acme/web');
  });

  it('shows the commands the server runs', () => {
    expect(cloneCommands(pr, '~/projects/web')).toBe('gh repo clone acme/web ~/projects/web\ncd ~/projects/web && gh pr checkout 128');
    expect(cloneCommands(pr, "/tmp/my web's")).toContain(`'/tmp/my web'\\''s'`);
    expect(cloneCommands(pr, '  ')).toContain('gh repo clone acme/web …');
    expect(linkCommands(pr, '/src/web')).toContain('git -C /src/web remote -v');
  });

  it('warns only when the clone is known to be elsewhere', () => {
    const base: PrCloneStatus = { bound: true, valid: true, suggested: '', job: null, head: 'aaaaaaaaaa', branch: 'main', prHead: 'bbbbbbbbbb', prBranch: 'feature', onHead: false };
    expect(headWarning(base, 128)).toBe(
      'Клон не на коммите PR #128: в клоне main @ aaaaaaa, а дифф показывает feature @ bbbbbbb. Файлы могут не совпадать — LSP получает показанный текст.',
    );
    expect(headWarning({ ...base, branch: null }, 1)).toContain('в клоне HEAD aaaaaaa');
    expect(headWarning({ ...base, onHead: true }, 1)).toBeNull();
    expect(headWarning({ ...base, onHead: null }, 1)).toBeNull();
    expect(headWarning({ ...base, valid: false }, 1)).toBeNull();
    expect(shortSha(null)).toBe('?');
  });
});
