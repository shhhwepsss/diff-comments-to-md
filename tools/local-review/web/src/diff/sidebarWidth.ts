// File tree width: dragged on the sidebar's edge, remembered per browser.
// Pure helpers only; the component owns the DOM and storage calls.

export const SIDEBAR_WIDTH_KEY = 'local-review:sidebar-width';
export const SIDEBAR_DEFAULT_WIDTH = 320;
export const SIDEBAR_MIN_WIDTH = 220;
/** Share of the viewport the tree may take, so the diff always keeps room. */
export const SIDEBAR_MAX_SHARE = 0.7;

export function maxSidebarWidth(viewport: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.floor(viewport * SIDEBAR_MAX_SHARE));
}

export function clampSidebarWidth(width: number, viewport: number): number {
  if (!Number.isFinite(width)) return Math.min(SIDEBAR_DEFAULT_WIDTH, maxSidebarWidth(viewport));
  return Math.min(Math.max(Math.round(width), SIDEBAR_MIN_WIDTH), maxSidebarWidth(viewport));
}

/** Stored value -> width in px; anything malformed falls back to the default. */
export function parseSidebarWidth(raw: string | null): number {
  if (raw === null || !/^\d+$/.test(raw.trim())) return SIDEBAR_DEFAULT_WIDTH;
  const n = Number(raw);
  return n >= SIDEBAR_MIN_WIDTH ? n : SIDEBAR_DEFAULT_WIDTH;
}
