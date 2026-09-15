import type { Comment } from '../api/types';

/** A comment about the review as a whole (lib/store.js isGeneralComment). */
export type GeneralComment = Comment & { file: null };

export function isGeneralComment(c: Comment): c is GeneralComment {
  return c.file === null;
}

/** General comments in the order the export lists them: oldest first. */
export function generalComments(comments: Comment[]): GeneralComment[] {
  return comments.filter(isGeneralComment).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}
