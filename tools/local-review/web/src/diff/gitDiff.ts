import { Change, diff as charDiff } from '@codemirror/merge';
import type { Hunk } from '../api/types';

// CodeMirror's own diff works on characters. On code that tends to find
// accidental matches inside inserted blocks and glue unrelated lines into one
// big "changed" chunk. Git already told us which lines changed (the hunks the
// server returns), so the line structure comes from git and the character
// diff only runs *inside* each changed run, for word highlighting.

// Line numbers, `to` exclusive. `paired` = how many deleted lines face an
// added line (GitHub word-diffs only those pairs; the rest is plain +/-).
type Run = { oldFrom: number; oldTo: number; newFrom: number; newTo: number; paired: number };

/** Maximal runs of consecutive del/add lines in the hunks. */
export function changedRuns(hunks: readonly Hunk[]): Run[] {
  const runs: Run[] = [];
  for (const hunk of hunks) {
    // "@@ -0,0 +1,n @@" is a new file (and +0,0 a deleted one): no lines on that side.
    let oldLine = Math.max(hunk.oldStart, 1);
    let newLine = Math.max(hunk.newStart, 1);
    let run: Run | null = null;
    let dels = 0;
    let adds = 0;
    const close = () => {
      if (run) {
        run.oldTo = oldLine;
        run.newTo = newLine;
        run.paired = Math.min(dels, adds);
        runs.push(run);
      }
      run = null;
      dels = 0;
      adds = 0;
    };
    for (const line of hunk.lines) {
      if (line.type === 'context') {
        close();
        oldLine++;
        newLine++;
        continue;
      }
      run ??= { oldFrom: oldLine, oldTo: oldLine, newFrom: newLine, newTo: newLine, paired: 0 };
      if (line.type === 'del') {
        oldLine++;
        dels++;
      } else {
        newLine++;
        adds++;
      }
    }
    close();
  }
  return runs;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

/** Offset of the start of `line` (1-based); one past the end for the line after the last. */
function posOf(starts: number[], length: number, line: number): number {
  return line <= starts.length ? starts[line - 1] : length + 1;
}

/**
 * Changes for CodeMirror built from git's hunks, or null when the hunks do not
 * describe these two texts (then the caller falls back to CodeMirror's diff).
 * `a` and `b` are the documents as CodeMirror sees them: "\n"-joined lines.
 */
export function changesFromHunks(hunks: readonly Hunk[], a: string, b: string): Change[] | null {
  const startsA = lineStarts(a);
  const startsB = lineStarts(b);
  const out: Change[] = [];
  let prevA = 0;
  let prevB = 0;

  for (const run of changedRuns(hunks)) {
    // A run may end right after the last line (lines + 1), never further.
    if (run.oldTo > startsA.length + 1 || run.newTo > startsB.length + 1) return null;
    let fromA = posOf(startsA, a.length, run.oldFrom);
    let midA = posOf(startsA, a.length, run.oldFrom + run.paired);
    let toA = posOf(startsA, a.length, run.oldTo);
    let fromB = posOf(startsB, b.length, run.newFrom);
    let midB = posOf(startsB, b.length, run.newFrom + run.paired);
    let toB = posOf(startsB, b.length, run.newTo);
    // A run that reaches the end of either text takes the line break before
    // it instead of the (missing) one after it.
    if (toA > a.length || toB > b.length) {
      [fromA, midA, toA, fromB, midB, toB] = [fromA, midA, toA, fromB, midB, toB].map((p) => Math.max(0, p - 1));
    }
    if (toA > a.length || toB > b.length || fromA < prevA || fromB < prevB || fromA > toA || fromB > toB) return null;
    // Everything between two runs is unchanged, so it must read the same on both sides.
    if (a.slice(prevA, fromA) !== b.slice(prevB, fromB)) return null;

    // Paired lines: word diff. The rest of the run: whole lines.
    if (run.paired) {
      for (const c of charDiff(a.slice(fromA, midA), b.slice(fromB, midB))) {
        out.push(new Change(c.fromA + fromA, c.toA + fromA, c.fromB + fromB, c.toB + fromB));
      }
    } else {
      midA = fromA;
      midB = fromB;
    }
    if (midA !== toA || midB !== toB) out.push(new Change(midA, toA, midB, toB));
    prevA = toA;
    prevB = toB;
  }
  if (a.slice(prevA) !== b.slice(prevB)) return null;
  return out;
}

/**
 * New-file lines that were added without a deleted counterpart. They get no
 * word highlighting (the whole line is new), like on GitHub.
 */
export function unpairedAddedLines(hunks: readonly Hunk[]): number[] {
  const lines: number[] = [];
  for (const run of changedRuns(hunks)) {
    for (let n = run.newFrom + run.paired; n < run.newTo; n++) lines.push(n);
  }
  return lines;
}

/** A `diffConfig.override` for the merge view. */
export function gitDiffOverride(hunks: readonly Hunk[]) {
  return (a: string, b: string): readonly Change[] => changesFromHunks(hunks, a, b) ?? charDiff(a, b);
}
