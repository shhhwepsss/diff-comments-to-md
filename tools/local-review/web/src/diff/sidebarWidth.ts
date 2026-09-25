// Widths of the side panes (file tree, comments panel): dragged on the pane's
// edge, remembered per browser. Pure helpers only; the component owns the DOM
// and storage calls.

export type PaneWidth = { min: number; def: number; /** Share of the viewport the pane may take. */ maxShare: number };

export function maxPaneWidth(pane: PaneWidth, viewport: number): number {
  return Math.max(pane.min, Math.floor(viewport * pane.maxShare));
}

export function clampPaneWidth(pane: PaneWidth, width: number, viewport: number): number {
  if (!Number.isFinite(width)) return Math.min(pane.def, maxPaneWidth(pane, viewport));
  return Math.min(Math.max(Math.round(width), pane.min), maxPaneWidth(pane, viewport));
}

/** Stored value -> width in px; anything malformed falls back to the default. */
export function parsePaneWidth(pane: PaneWidth, raw: string | null): number {
  if (raw === null || !/^\d+$/.test(raw.trim())) return pane.def;
  const n = Number(raw);
  return n >= pane.min ? n : pane.def;
}

export const SIDEBAR_WIDTH_KEY = 'local-review:sidebar-width';
export const SIDEBAR_DEFAULT_WIDTH = 320;
export const SIDEBAR_MIN_WIDTH = 220;
/** Share of the viewport the tree may take, so the diff always keeps room. */
export const SIDEBAR_MAX_SHARE = 0.7;
export const SIDEBAR_PANE: PaneWidth = { min: SIDEBAR_MIN_WIDTH, def: SIDEBAR_DEFAULT_WIDTH, maxShare: SIDEBAR_MAX_SHARE };

export function maxSidebarWidth(viewport: number): number {
  return maxPaneWidth(SIDEBAR_PANE, viewport);
}

export function clampSidebarWidth(width: number, viewport: number): number {
  return clampPaneWidth(SIDEBAR_PANE, width, viewport);
}

export function parseSidebarWidth(raw: string | null): number {
  return parsePaneWidth(SIDEBAR_PANE, raw);
}
