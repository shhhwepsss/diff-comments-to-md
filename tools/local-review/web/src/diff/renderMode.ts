// «Код» or «Просмотр»: which files show the rendered view instead of the
// source diff. With the «Вид файла» setting on (the default) the switch in any
// file's header is one switch for every file; with it off each file has its
// own, as it always had.
//
// Not persisted: like the other per-file choices of the diff pane it lasts
// until the review is closed or the page is reloaded.

export type RenderChoice = {
  /** The common choice, used when the mode is shared. */
  all: boolean;
  /**
   * Choices made for one file. When the mode is shared these are the
   * exceptions: a file sent back to the source on its own (a comment to
   * scroll to, a preview that failed to load).
   */
  files: Record<string, boolean>;
};

/** Nothing switched yet: every file shows its source. */
export const NO_RENDER_CHOICE: RenderChoice = { all: false, files: {} };

/** `shared` is the setting: one render mode for every file. */
export function isRendered(choice: RenderChoice, path: string, shared: boolean): boolean {
  return choice.files[path] ?? (shared && choice.all);
}

/**
 * The reviewer used the switch in `path`'s header. Shared: every file follows,
 * the exceptions included. Not shared: only that file changes.
 */
export function switchRendered(choice: RenderChoice, path: string, rendered: boolean, shared: boolean): RenderChoice {
  if (!shared) return setFileRendered(choice, path, rendered, shared);
  if (choice.all === rendered && Object.keys(choice.files).length === 0) return choice;
  return { all: rendered, files: {} };
}

/** One file changes its view, whatever the setting; the others stay as they are. */
export function setFileRendered(choice: RenderChoice, path: string, rendered: boolean, shared: boolean): RenderChoice {
  if (isRendered(choice, path, shared) === rendered) return choice;
  return { ...choice, files: { ...choice.files, [path]: rendered } };
}
