import type { LspHover } from '../api/types';

// A hover answer is markdown (or plain text): a fenced signature, then the
// documentation. The tooltip shows the fences as code and the rest as text
// with `inline code` — no HTML from the server ever reaches the page, so this
// splits the text instead of rendering it.

export type HoverBlock = { type: 'code'; lang: string; text: string } | { type: 'text'; text: string };
export type InlinePart = { code: boolean; text: string };

const FENCE = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/;

/** The hover as code blocks and paragraphs, in order; empty parts dropped. */
export function hoverBlocks(hover: LspHover): HoverBlock[] {
  if (hover.kind === 'plaintext') {
    const text = hover.value.trim();
    return text ? [{ type: 'text', text }] : [];
  }
  const blocks: HoverBlock[] = [];
  const lines = hover.value.replace(/\r\n?/g, '\n').split('\n');
  let text: string[] = [];
  const flushText = () => {
    const joined = text.join('\n').trim();
    if (joined) blocks.push({ type: 'text', text: tidy(joined) });
    text = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE.exec(lines[i]);
    if (!open) {
      text.push(lines[i]);
      continue;
    }
    flushText();
    const code: string[] = [];
    let j = i + 1;
    while (j < lines.length && !(lines[j].trim().startsWith(open[1]) && FENCE.test(lines[j]))) code.push(lines[j++]);
    const body = code.join('\n').replace(/\s+$/, '');
    if (body.trim()) blocks.push({ type: 'code', lang: open[2], text: body });
    i = j;
  }
  flushText();
  return blocks;
}

/**
 * Markdown leftovers that read badly as plain text: `[text](link)` keeps the
 * text, `*` and `**` emphasis markers go (`__` stays: it is too often part of
 * a name), horizontal rules go, and hard line breaks (two spaces, a
 * backslash) become plain ones.
 */
function tidy(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(^|[\s(])(\*\*|\*)(?=\S)([^*\n]+?)\2(?=[\s.,;:)!?]|$)/g, '$1$3')
    .replace(/^\s*(---+|\*\*\*+|___+)\s*$/gm, '')
    .replace(/( {2,}|\\)\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A paragraph cut into plain text and `inline code`. */
export function inlineParts(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const re = /`([^`\n]+)`/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) parts.push({ code: false, text: text.slice(at, m.index) });
    parts.push({ code: true, text: m[1] });
    at = m.index + m[0].length;
  }
  if (at < text.length) parts.push({ code: false, text: text.slice(at) });
  return parts;
}
