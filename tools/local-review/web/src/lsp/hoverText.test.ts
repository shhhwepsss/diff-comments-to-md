import { describe, expect, it } from 'vitest';
import { hoverBlocks, inlineParts } from './hoverText';

describe('hoverBlocks', () => {
  it('splits a tsserver hover into the signature and the docs', () => {
    const value =
      '\n```typescript\n(alias) new DiffStore(source: DiffSource): DiffStore\nimport DiffStore\n```\nCaches file texts of one diff source.';
    expect(hoverBlocks({ kind: 'markdown', value })).toEqual([
      { type: 'code', lang: 'typescript', text: '(alias) new DiffStore(source: DiffSource): DiffStore\nimport DiffStore' },
      { type: 'text', text: 'Caches file texts of one diff source.' },
    ]);
  });

  it('keeps several code blocks and paragraphs in order', () => {
    const value = 'Intro\n\n```java\nint x;\n```\n\n---\n\nMore *docs* with [a link](http://x).\n\n```\nraw\n```';
    expect(hoverBlocks({ kind: 'markdown', value })).toEqual([
      { type: 'text', text: 'Intro' },
      { type: 'code', lang: 'java', text: 'int x;' },
      { type: 'text', text: 'More docs with a link.' },
      { type: 'code', lang: '', text: 'raw' },
    ]);
  });

  it('leaves identifiers with underscores alone', () => {
    expect(hoverBlocks({ kind: 'markdown', value: 'Uses MAX_TEXT_BYTES and __proto__' })).toEqual([
      { type: 'text', text: 'Uses MAX_TEXT_BYTES and __proto__' },
    ]);
  });

  it('tolerates an unclosed fence and plain text', () => {
    expect(hoverBlocks({ kind: 'markdown', value: '```ts\nconst a = 1;' })).toEqual([{ type: 'code', lang: 'ts', text: 'const a = 1;' }]);
    expect(hoverBlocks({ kind: 'plaintext', value: '  int x  ' })).toEqual([{ type: 'text', text: 'int x' }]);
    expect(hoverBlocks({ kind: 'markdown', value: '   ' })).toEqual([]);
  });
});

describe('inlineParts', () => {
  it('cuts out inline code', () => {
    expect(inlineParts('Pass `bytes` to `formatSize`.')).toEqual([
      { code: false, text: 'Pass ' },
      { code: true, text: 'bytes' },
      { code: false, text: ' to ' },
      { code: true, text: 'formatSize' },
      { code: false, text: '.' },
    ]);
    expect(inlineParts('no code')).toEqual([{ code: false, text: 'no code' }]);
  });
});
