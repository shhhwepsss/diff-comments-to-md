import { describe, expect, it } from 'vitest';
import { NO_RENDER_CHOICE, isRendered, setFileRendered, switchRendered } from './renderMode';

describe('isRendered', () => {
  it('shows the source until something is switched', () => {
    expect(isRendered(NO_RENDER_CHOICE, 'a.md', true)).toBe(false);
    expect(isRendered(NO_RENDER_CHOICE, 'a.md', false)).toBe(false);
  });

  it('follows the common choice when the mode is shared', () => {
    expect(isRendered({ all: true, files: {} }, 'a.md', true)).toBe(true);
  });

  it("lets a file's own choice win over the common one", () => {
    const choice = { all: true, files: { 'a.md': false } };
    expect(isRendered(choice, 'a.md', true)).toBe(false);
    expect(isRendered(choice, 'b.md', true)).toBe(true);
  });

  it('ignores the common choice when every file is on its own', () => {
    const choice = { all: true, files: { 'a.md': true } };
    expect(isRendered(choice, 'a.md', false)).toBe(true);
    expect(isRendered(choice, 'b.md', false)).toBe(false);
  });
});

describe('switchRendered', () => {
  it('switches every file when the mode is shared', () => {
    const on = switchRendered(NO_RENDER_CHOICE, 'a.md', true, true);
    expect(isRendered(on, 'a.md', true)).toBe(true);
    expect(isRendered(on, 'b.md', true)).toBe(true);
    const off = switchRendered(on, 'b.md', false, true);
    expect(isRendered(off, 'a.md', true)).toBe(false);
    expect(isRendered(off, 'b.md', true)).toBe(false);
  });

  it("drops the files' own choices when the mode is shared", () => {
    // b.md was sent back to the source on its own; «Просмотр» in any file
    // brings it along with the rest.
    const next = switchRendered({ all: true, files: { 'b.md': false } }, 'a.md', true, true);
    expect(next).toEqual({ all: true, files: {} });
    // The file that is the exception switches everything too.
    expect(switchRendered({ all: true, files: { 'b.md': false } }, 'b.md', true, true)).toEqual({ all: true, files: {} });
  });

  it('switches only that file when every file is on its own', () => {
    const on = switchRendered(NO_RENDER_CHOICE, 'a.md', true, false);
    expect(on).toEqual({ all: false, files: { 'a.md': true } });
    expect(isRendered(on, 'a.md', false)).toBe(true);
    expect(isRendered(on, 'b.md', false)).toBe(false);
    const off = switchRendered(on, 'a.md', false, false);
    expect(isRendered(off, 'a.md', false)).toBe(false);
  });

  it('returns the same object when nothing changes', () => {
    const shared = { all: true, files: {} };
    expect(switchRendered(shared, 'a.md', true, true)).toBe(shared);
    expect(switchRendered(NO_RENDER_CHOICE, 'a.md', false, true)).toBe(NO_RENDER_CHOICE);
    const own = { all: false, files: { 'a.md': true } };
    expect(switchRendered(own, 'a.md', true, false)).toBe(own);
    expect(switchRendered(own, 'b.md', false, false)).toBe(own);
  });
});

describe('setFileRendered', () => {
  it('changes one file and leaves the rest on the common choice', () => {
    const next = setFileRendered({ all: true, files: {} }, 'a.md', false, true);
    expect(next).toEqual({ all: true, files: { 'a.md': false } });
    expect(isRendered(next, 'a.md', true)).toBe(false);
    expect(isRendered(next, 'b.md', true)).toBe(true);
  });

  it('is the plain per-file switch when every file is on its own', () => {
    const next = setFileRendered({ all: false, files: { 'a.md': true } }, 'a.md', false, false);
    expect(isRendered(next, 'a.md', false)).toBe(false);
  });

  it('returns the same object when the file already shows that view', () => {
    const shared = { all: false, files: {} };
    expect(setFileRendered(shared, 'a.ts', false, true)).toBe(shared);
    const own = { all: true, files: { 'a.md': false } };
    expect(setFileRendered(own, 'a.md', false, true)).toBe(own);
  });
});
