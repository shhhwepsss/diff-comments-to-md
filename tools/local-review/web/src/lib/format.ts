import type { Comment } from '../api/types';

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Same anchor format the markdown export uses (lib/export.js). */
export function anchorLabel(c: Pick<Comment, 'file' | 'startLine' | 'endLine'>): string {
  if (c.startLine === null || c.startLine === undefined) return c.file;
  if (c.endLine && c.endLine !== c.startLine) return `${c.file}:L${c.startLine}-L${c.endLine}`;
  return `${c.file}:L${c.startLine}`;
}
