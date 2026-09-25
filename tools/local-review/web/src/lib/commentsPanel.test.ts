import { describe, expect, it } from 'vitest';
import { clampPaneWidth, parsePaneWidth } from '../diff/sidebarWidth';
import { COMMENTS_PANEL_WIDTH, parseCommentsPanel } from './commentsPanel';

describe('parseCommentsPanel', () => {
  it('is open only for the stored "1"', () => {
    expect(parseCommentsPanel('1')).toBe(true);
  });

  it.each([null, '', '0', 'true', ' 1 '])('is closed for %j', (raw) => {
    expect(parseCommentsPanel(raw)).toBe(false);
  });
});

describe('comments panel width', () => {
  it('falls back to the default for anything malformed or too narrow', () => {
    expect(parsePaneWidth(COMMENTS_PANEL_WIDTH, null)).toBe(COMMENTS_PANEL_WIDTH.def);
    expect(parsePaneWidth(COMMENTS_PANEL_WIDTH, 'wide')).toBe(COMMENTS_PANEL_WIDTH.def);
    expect(parsePaneWidth(COMMENTS_PANEL_WIDTH, '100')).toBe(COMMENTS_PANEL_WIDTH.def);
    expect(parsePaneWidth(COMMENTS_PANEL_WIDTH, '420')).toBe(420);
  });

  it('never takes more than its share of the window, so the diff keeps room', () => {
    expect(clampPaneWidth(COMMENTS_PANEL_WIDTH, 5000, 1000)).toBe(450);
    expect(clampPaneWidth(COMMENTS_PANEL_WIDTH, 10, 1000)).toBe(COMMENTS_PANEL_WIDTH.min);
  });
});
