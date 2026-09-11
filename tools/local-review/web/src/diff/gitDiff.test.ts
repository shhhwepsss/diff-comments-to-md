import { describe, expect, it } from 'vitest';
import { Chunk, type Change } from '@codemirror/merge';
import { Text } from '@codemirror/state';
import type { DiffLine, Hunk } from '../api/types';
import { changedRuns, changesFromHunks, gitDiffOverride, unpairedAddedLines } from './gitDiff';

// Hunk lines in the shape lib/diff.js parsePatch returns.
const ctx = (text: string): DiffLine => ({ type: 'context', oldLine: 0, newLine: 0, text });
const del = (text: string): DiffLine => ({ type: 'del', oldLine: 0, newLine: null, text });
const add = (text: string): DiffLine => ({ type: 'add', oldLine: null, newLine: 0, text });
const hunk = (oldStart: number, newStart: number, lines: DiffLine[]): Hunk => ({ oldStart, newStart, heading: '', lines });

/** Applying the changes to `a` must give `b` — whatever else happens. */
function apply(a: string, b: string, changes: readonly Change[]): string {
  let out = '';
  let pos = 0;
  for (const c of changes) {
    out += a.slice(pos, c.fromA) + b.slice(c.fromB, c.toB);
    pos = c.toA;
  }
  return out + a.slice(pos);
}

describe('changedRuns', () => {
  it('splits hunks into runs of del/add lines', () => {
    const runs = changedRuns([hunk(1, 1, [ctx('a'), del('b'), add('B'), add('B2'), ctx('c'), add('d')])]);
    expect(runs).toEqual([
      { oldFrom: 2, oldTo: 3, newFrom: 2, newTo: 4, paired: 1 },
      { oldFrom: 4, oldTo: 4, newFrom: 5, newTo: 6, paired: 0 },
    ]);
  });

  it('lists added lines without a deleted partner', () => {
    expect(unpairedAddedLines([hunk(1, 1, [ctx('a'), del('b'), add('B'), add('B2'), ctx('c'), add('d')])])).toEqual([3, 5]);
  });
});

// Through the real merge library: the chunks CodeMirror builds from our
// changes. Texts keep their final newline, as DiffEditor passes them.
describe('Chunk.build with the git override', () => {
  const chunksFor = (a: string, b: string, hunks: Hunk[]) =>
    Chunk.build(Text.of(a.split('\n')), Text.of(b.split('\n')), { override: gitDiffOverride(hunks) }).map((c) => [
      c.fromA,
      c.toA,
      c.fromB,
      c.toB,
    ]);

  it('keeps an append at the end of the file a pure insertion', () => {
    // "b" is untouched and must not be pulled into the chunk.
    expect(chunksFor('a\nb\n', 'a\nb\nc\n', [hunk(1, 1, [ctx('a'), ctx('b'), add('c')])])).toEqual([[4, 4, 4, 6]]);
  });

  it('keeps a removal at the end of the file a pure deletion', () => {
    expect(chunksFor('a\nb\nc\n', 'a\nb\n', [hunk(1, 1, [ctx('a'), ctx('b'), del('c')])])).toEqual([[4, 6, 4, 4]]);
  });

  it('does not glue two runs separated by an untouched line', () => {
    const a = 'x\nA\nkeep\nB\ny\n';
    const b = 'x\nA2\nkeep\nB2\ny\n';
    const chunks = chunksFor(a, b, [
      hunk(1, 1, [ctx('x'), del('A'), add('A2'), ctx('keep'), del('B'), add('B2'), ctx('y')]),
    ]);
    expect(chunks.length).toBe(2);
  });
});

describe('changesFromHunks — paired vs surplus lines', () => {
  it('word-diffs only the paired line and adds the surplus as whole lines', () => {
    const a = 'x\nconst A = 1;\nz';
    const b = 'x\nconst B = 1;\nnew line\nz';
    const changes = changesFromHunks([hunk(1, 1, [ctx('x'), del('const A = 1;'), add('const B = 1;'), add('new line'), ctx('z')])], a, b)!;
    expect(apply(a, b, changes)).toBe(b);
    const last = changes[changes.length - 1];
    // The surplus is one whole-line insertion: "new line\n".
    expect(b.slice(last.fromB, last.toB)).toBe('new line\n');
    expect(last.toA - last.fromA).toBe(0);
  });

  it('keeps a surplus at the end of the file correct', () => {
    const a = 'x\ny';
    const b = 'x\nY\nw';
    const changes = changesFromHunks([hunk(1, 1, [ctx('x'), del('y'), add('Y'), add('w')])], a, b)!;
    expect(apply(a, b, changes)).toBe(b);
  });

  it('keeps a deleted surplus at the end of the file correct', () => {
    const a = 'x\ny\nz';
    const b = 'x\nY';
    const changes = changesFromHunks([hunk(1, 1, [ctx('x'), del('y'), del('z'), add('Y')])], a, b)!;
    expect(apply(a, b, changes)).toBe(b);
  });
});

describe('changesFromHunks', () => {
  it('keeps unchanged lines between an insertion and a modification out of the change', () => {
    // The shape that fooled the character diff: a renamed constant, a block
    // inserted after it, then untouched lines, then more insertions.
    const a = ['x', 'const A = 1;', '', 'const M = {', "  '.html': 1,", "  '.css': 2,", '};'].join('\n');
    const b = [
      'x',
      'const DEFAULT_A = 1;',
      '',
      '/** doc */',
      'function f() { return A; }',
      '',
      'const M = {',
      "  '.html': 1,",
      "  '.css': 2,",
      "  '.map': 3,",
      '};',
    ].join('\n');
    const hunks = [
      hunk(1, 1, [
        ctx('x'),
        del('const A = 1;'),
        add('const DEFAULT_A = 1;'),
        ctx(''),
        add('/** doc */'),
        add('function f() { return A; }'),
        add(''),
        ctx('const M = {'),
        ctx("  '.html': 1,"),
        ctx("  '.css': 2,"),
        add("  '.map': 3,"),
        ctx('};'),
      ]),
    ];
    const changes = changesFromHunks(hunks, a, b)!;
    expect(changes).not.toBeNull();
    expect(apply(a, b, changes)).toBe(b);
    // No change touches the untouched ".html"/".css" lines on the old side.
    const htmlAt = a.indexOf("  '.html'");
    const cssEnd = a.indexOf("  '.css': 2,") + "  '.css': 2,".length;
    for (const c of changes) expect(c.toA <= htmlAt || c.fromA >= cssEnd).toBe(true);
  });

  it('handles a new file (hunk -0,0)', () => {
    const b = 'one\ntwo';
    const changes = changesFromHunks([hunk(0, 1, [add('one'), add('two')])], '', b)!;
    expect(changes.map((c) => [c.fromA, c.toA, c.fromB, c.toB])).toEqual([[0, 0, 0, b.length]]);
  });

  it('handles a deleted file (hunk +0,0)', () => {
    const a = 'one\ntwo';
    const changes = changesFromHunks([hunk(1, 0, [del('one'), del('two')])], a, '')!;
    expect(changes.map((c) => [c.fromA, c.toA, c.fromB, c.toB])).toEqual([[0, a.length, 0, 0]]);
  });

  it('handles lines appended at the end', () => {
    const a = 'x\ny';
    const b = 'x\ny\nz';
    const changes = changesFromHunks([hunk(1, 1, [ctx('x'), ctx('y'), add('z')])], a, b)!;
    expect(changes.map((c) => [c.fromA, c.toA, c.fromB, c.toB])).toEqual([[3, 3, 3, 5]]);
    expect(apply(a, b, changes)).toBe(b);
  });

  it('handles lines removed from the end', () => {
    const a = 'x\ny\nz';
    const b = 'x';
    const changes = changesFromHunks([hunk(1, 1, [ctx('x'), del('y'), del('z')])], a, b)!;
    expect(changes.map((c) => [c.fromA, c.toA, c.fromB, c.toB])).toEqual([[1, 5, 1, 1]]);
    expect(apply(a, b, changes)).toBe(b);
  });

  it('word-diffs a modified last line', () => {
    const a = 'x\nfoo(a)';
    const b = 'x\nfoo(b)';
    const changes = changesFromHunks([hunk(1, 1, [ctx('x'), del('foo(a)'), add('foo(b)')])], a, b)!;
    expect(apply(a, b, changes)).toBe(b);
    expect(changes.every((c) => c.toA - c.fromA <= 2)).toBe(true);
  });

  it('refuses hunks that do not describe the texts', () => {
    // Claims line 2 changed, but line 1 differs too.
    expect(changesFromHunks([hunk(1, 1, [ctx('x'), del('y'), add('Y')])], 'x\ny', 'Q\nY')).toBeNull();
    // Points past the end of the text.
    expect(changesFromHunks([hunk(5, 5, [del('y')])], 'x', 'x')).toBeNull();
  });

  it('returns no changes for no hunks when the texts match', () => {
    expect(changesFromHunks([], 'a\nb', 'a\nb')).toEqual([]);
  });
});
