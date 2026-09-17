// Line-level view of the merge chunks, kept free of CodeMirror types so it can
// be unit-tested with plain numbers.

/**
 * A changed region in line numbers (1-based). `newCount === 0` is a pure
 * deletion that sits right before new line `newFrom`; `oldCount === 0` is a
 * pure insertion.
 */
export type LineChunk = { oldFrom: number; oldCount: number; newFrom: number; newCount: number };

export type LineRange = { from: number; to: number }; // inclusive

/**
 * Old line number for every new line: index = new line number, value = old
 * line number, or 0 when the line was added or changed (no old counterpart).
 */
export function oldLineNumbers(newLineCount: number, chunks: readonly LineChunk[]): Int32Array {
  const map = new Int32Array(newLineCount + 1);
  const sorted = [...chunks].sort((a, b) => a.newFrom - b.newFrom);
  let offset = 0;
  let ci = 0;
  for (let n = 1; n <= newLineCount; n++) {
    // Chunks that end before this line contribute their size difference.
    while (ci < sorted.length && sorted[ci].newFrom + sorted[ci].newCount <= n) {
      offset += sorted[ci].oldCount - sorted[ci].newCount;
      ci++;
    }
    const c = sorted[ci];
    map[n] = c && n >= c.newFrom && n < c.newFrom + c.newCount ? 0 : n + offset;
  }
  return map;
}

/**
 * Runs of unchanged lines to fold away, like GitHub does around hunks.
 * Lines within `margin` of a change stay visible, and so do `keep` lines
 * (lines that carry a comment or the open editor) — a comment must never end
 * up inside a folded block. Runs shorter than `minSize` are not worth folding.
 */
export function collapsedRanges(
  lineCount: number,
  chunks: readonly LineChunk[],
  keep: Iterable<number>,
  margin: number,
  minSize: number,
  expanded: ReadonlySet<string> = new Set(),
): LineRange[] {
  if (lineCount <= 0) return [];
  const visible = new Uint8Array(lineCount + 2);
  const show = (from: number, to: number) => {
    for (let n = Math.max(1, from); n <= Math.min(lineCount, to); n++) visible[n] = 1;
  };
  for (const c of chunks) show(c.newFrom - margin, c.newFrom + c.newCount - 1 + margin);
  for (const n of keep) show(n, n);

  const out: LineRange[] = [];
  let runStart = 0;
  for (let n = 1; n <= lineCount + 1; n++) {
    const hidden = n <= lineCount && !visible[n];
    if (hidden && !runStart) runStart = n;
    if (!hidden && runStart) {
      const range = { from: runStart, to: n - 1 };
      if (range.to - range.from + 1 >= minSize && !expanded.has(rangeKey(range))) out.push(range);
      runStart = 0;
    }
  }
  return out;
}

export function rangeKey(r: LineRange): string {
  return `${r.from}-${r.to}`;
}

/** Normalizes a drag in either direction. */
export function orderedRange(a: number, b: number): LineRange {
  return a <= b ? { from: a, to: b } : { from: b, to: a };
}

/**
 * Git and GitHub do not show the empty "line" after a trailing newline; a
 * CodeMirror document would. Drop exactly one line terminator at the end.
 */
export function stripFinalNewline(text: string): string {
  if (text.endsWith('\r\n')) return text.slice(0, -2);
  if (text.endsWith('\n') || text.endsWith('\r')) return text.slice(0, -1);
  return text;
}
