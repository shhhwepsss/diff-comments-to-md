// File tree width: dragged or keyed on the sidebar's edge, remembered per browser.
// Pure helpers only; the component owns the DOM and storage calls.

export const SIDEBAR_WIDTH_KEY = 'local-review:sidebar-width';
export const SIDEBAR_DEFAULT_WIDTH = 320;
export const SIDEBAR_MIN_WIDTH = 220;
/** Share of the viewport the tree may take, so the diff always keeps room. */
export const SIDEBAR_MAX_SHARE = 0.7;
export const SIDEBAR_KEY_STEP = 16;
export const SIDEBAR_KEY_STEP_LARGE = 64;

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

/** Width after a key press on the resize handle, or null if the key isn't ours. */
export function sidebarWidthForKey(key: string, shift: boolean, width: number, viewport: number): number | null {
  const step = shift ? SIDEBAR_KEY_STEP_LARGE : SIDEBAR_KEY_STEP;
  switch (key) {
    case 'ArrowLeft':
      return clampSidebarWidth(width - step, viewport);
    case 'ArrowRight':
      return clampSidebarWidth(width + step, viewport);
    case 'Home':
      return SIDEBAR_MIN_WIDTH;
    case 'End':
      return maxSidebarWidth(viewport);
    case 'Enter':
      return clampSidebarWidth(SIDEBAR_DEFAULT_WIDTH, viewport);
    default:
      return null;
  }
}
