/**
 * Unsaved comment text, kept in memory so closing a panel does not throw it
 * away. One store per review (ReviewProvider remounts per descriptor); a page
 * reload starts empty. Forms read a draft once, when they mount, so the store
 * is a plain map and not React state: typing does not re-render the review.
 */
export type DraftStore = {
  get: (key: string) => string | undefined;
  set: (key: string, text: string) => void;
  clear: (key: string) => void;
};

/** The "new general comment" form. */
export const NEW_GENERAL_DRAFT = 'general:new';

/** An in-progress edit of an existing comment. */
export function editDraftKey(id: string): string {
  return `edit:${id}`;
}

export function createDraftStore(): DraftStore {
  const texts = new Map<string, string>();
  return {
    get: (key) => texts.get(key),
    set: (key, text) => {
      texts.set(key, text);
    },
    clear: (key) => {
      texts.delete(key);
    },
  };
}
