// Plain-text logic of «highlight occurrences»: what the word under the caret
// is and where the same word stands elsewhere. No editor here, so it is
// testable on strings.

/** Letters, digits, `_` and `$`: an identifier in most languages we show. */
const WORD_CHAR = /[\p{L}\p{N}_$]/u;

export function isWordChar(ch: string): boolean {
  return ch !== '' && WORD_CHAR.test(ch);
}

/** True when `text` is one whole word, nothing around it. */
export function isSingleWord(text: string): boolean {
  if (!text) return false;
  for (const ch of text) if (!isWordChar(ch)) return false;
  return true;
}

/**
 * The word touching `pos` in `line` (offsets into the line), or null. A caret
 * right after a word counts as being in it, like a click on the word's end.
 */
export function wordAt(line: string, pos: number): { from: number; to: number } | null {
  if (pos < 0 || pos > line.length) return null;
  let from = pos;
  let to = pos;
  while (from > 0 && isWordChar(charBefore(line, from))) from -= charBefore(line, from).length;
  while (to < line.length && isWordChar(charAfter(line, to))) to += charAfter(line, to).length;
  return from < to ? { from, to } : null;
}

/** Start offsets of every whole-word occurrence of `word` in `text`. */
export function findWord(text: string, word: string): number[] {
  const found: number[] = [];
  if (!word) return found;
  for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + 1)) {
    const end = at + word.length;
    if (isWordChar(charBefore(text, at)) || isWordChar(charAfter(text, end))) continue;
    found.push(at);
  }
  return found;
}

/** The index `dir` steps away from `index` among `count`, wrapping around. */
export function stepIndex(index: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return -1;
  if (index < 0) return dir > 0 ? 0 : count - 1;
  return (((index + dir) % count) + count) % count;
}

/**
 * Where an occurrence sits in the order the reader sees: `pos` in the new
 * document, then `side` (0 = a deleted line drawn above the line at `pos`,
 * 1 = the document's own text), then `offset` within that.
 */
export type OrderKey = { pos: number; side: 0 | 1; offset: number };

export function compareKeys(a: OrderKey, b: OrderKey): number {
  return a.pos - b.pos || a.side - b.side || a.offset - b.offset;
}

/** Split text into lines the way the deleted-lines widget draws them. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

/** The line (index) and column of `offset`, given `lineStarts(text)`. */
export function lineColumn(starts: readonly number[], offset: number): { line: number; col: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, col: offset - starts[lo] };
}

/** A mark's top on a ruler `height` px tall for content at `y` of `total` px. */
export function rulerTop(y: number, total: number, height: number, mark = 3): number {
  if (total <= 0 || height <= 0) return 0;
  const top = (y / total) * height;
  return Math.max(0, Math.min(height - mark, Math.round(top)));
}

function charBefore(text: string, at: number): string {
  if (at <= 0) return '';
  const code = text.charCodeAt(at - 1);
  // A surrogate pair: the letter is both halves.
  if (code >= 0xdc00 && code <= 0xdfff && at >= 2) return text.slice(at - 2, at);
  return text[at - 1];
}

function charAfter(text: string, at: number): string {
  if (at >= text.length) return '';
  const code = text.charCodeAt(at);
  if (code >= 0xd800 && code <= 0xdbff && at + 1 < text.length) return text.slice(at, at + 2);
  return text[at];
}
