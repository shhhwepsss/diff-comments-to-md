import { describe, expect, it } from 'vitest';
import {
  bindingFromEvent,
  displayBinding,
  formatBinding,
  isTypingTarget,
  keybindingsFrom,
  matchesEvent,
  normalizeBinding,
  parseBinding,
  KEYBINDING_DEFAULTS,
} from './keybindings';

const press = (code: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}) => ({
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  code,
  ...mods,
});

describe('parseBinding', () => {
  it('reads modifiers and the key', () => {
    expect(parseBinding('Ctrl+Shift+F')).toEqual({ ctrl: true, alt: false, shift: true, meta: false, key: 'F' });
  });

  it('ignores order and case, and accepts the usual modifier aliases', () => {
    expect(parseBinding('shift + control + f')).toEqual(parseBinding('Ctrl+Shift+F'));
    expect(parseBinding('cmd+k')).toEqual(parseBinding('Meta+K'));
    expect(parseBinding('option+z')).toEqual(parseBinding('Alt+Z'));
  });

  it('allows a bare key', () => {
    expect(parseBinding('Z')).toEqual({ ctrl: false, alt: false, shift: false, meta: false, key: 'Z' });
    expect(parseBinding('F8')?.key).toBe('F8');
    expect(parseBinding('7')?.key).toBe('7');
  });

  it.each(['', '   ', 'Ctrl', 'Ctrl+', 'Ctrl+Escape', 'Enter', 'Tab', 'Space', 'Ctrl+A+B', 'F13', 'Ctrl+ф', '++'])(
    'refuses %j',
    (raw) => {
      expect(parseBinding(raw)).toBeNull();
    },
  );
});

describe('formatBinding', () => {
  it('puts the modifiers in a fixed order', () => {
    expect(formatBinding({ ctrl: true, alt: true, shift: true, meta: true, key: 'A' })).toBe('Ctrl+Alt+Shift+Meta+A');
  });

  it('round-trips through parseBinding', () => {
    expect(normalizeBinding('shift+ctrl+f')).toBe('Ctrl+Shift+F');
    expect(normalizeBinding('Ctrl+Shift+F')).toBe('Ctrl+Shift+F');
  });
});

describe('normalizeBinding', () => {
  it('turns anything unusable into an empty binding', () => {
    expect(normalizeBinding('Ctrl+Enter')).toBe('');
    expect(normalizeBinding('')).toBe('');
  });
});

describe('bindingFromEvent', () => {
  it('takes the key from the physical code, not the typed character', () => {
    // Cyrillic layout: pressing the A key reports key='ф', code='KeyA'.
    expect(bindingFromEvent(press('KeyA', { ctrlKey: true }))).toEqual({
      ctrl: true,
      alt: false,
      shift: false,
      meta: false,
      key: 'A',
    });
  });

  it('reads digits and function keys', () => {
    expect(bindingFromEvent(press('Digit3'))?.key).toBe('3');
    expect(bindingFromEvent(press('F11'))?.key).toBe('F11');
  });

  it.each(['Escape', 'Enter', 'Tab', 'Space', 'ShiftLeft', 'ArrowLeft', 'Backquote', ''])(
    'refuses to bind %j',
    (code) => {
      expect(bindingFromEvent(press(code))).toBeNull();
    },
  );
});

describe('matchesEvent', () => {
  it('fires on the exact combination', () => {
    expect(matchesEvent('Ctrl+Shift+F', press('KeyF', { ctrlKey: true, shiftKey: true }))).toBe(true);
  });

  it('does not fire when a modifier differs', () => {
    expect(matchesEvent('Ctrl+Shift+F', press('KeyF', { ctrlKey: true }))).toBe(false);
    expect(matchesEvent('Ctrl+Shift+F', press('KeyF', { ctrlKey: true, shiftKey: true, altKey: true }))).toBe(false);
  });

  it('does not fire on another key', () => {
    expect(matchesEvent('Ctrl+Shift+F', press('KeyG', { ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  it('an unbound action never fires', () => {
    expect(matchesEvent('', press('KeyF'))).toBe(false);
    expect(matchesEvent('Ctrl+Enter', press('Enter', { ctrlKey: true }))).toBe(false);
  });
});

describe('isTypingTarget', () => {
  it.each(['INPUT', 'TEXTAREA', 'SELECT'])('is true inside %s', (tagName) => {
    expect(isTypingTarget({ tagName } as unknown as EventTarget)).toBe(true);
  });

  it('is true for contenteditable', () => {
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true);
  });

  it('is false elsewhere', () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget({ tagName: 'DIV' } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget({} as unknown as EventTarget)).toBe(false);
  });
});

describe('keybindingsFrom', () => {
  it('fills in the defaults for anything missing or malformed', () => {
    expect(keybindingsFrom(undefined)).toEqual(KEYBINDING_DEFAULTS);
    expect(keybindingsFrom(null)).toEqual(KEYBINDING_DEFAULTS);
    expect(keybindingsFrom('Ctrl+F')).toEqual(KEYBINDING_DEFAULTS);
    expect(keybindingsFrom({ zen: 42 })).toEqual(KEYBINDING_DEFAULTS);
  });

  it('normalizes what it keeps and drops unknown actions', () => {
    expect(keybindingsFrom({ zen: 'shift+ctrl+f', nope: 'Ctrl+Q' })).toEqual({
      zen: 'Ctrl+Shift+F',
      commentsPanel: '',
      viewedFile: 'Alt+V',
      viewMode: 'Alt+A',
      definition: 'F12',
      references: 'Shift+F12',
      implementation: 'Ctrl+F12',
      callHierarchy: 'Alt+Shift+H',
      navBack: 'Alt+Left',
      navForward: 'Alt+Right',
    });
  });

  it('an unusable binding becomes unbound, not an error', () => {
    expect(keybindingsFrom({ zen: 'Ctrl+Escape' })).toEqual({
      zen: '',
      commentsPanel: '',
      viewedFile: 'Alt+V',
      viewMode: 'Alt+A',
      definition: 'F12',
      references: 'Shift+F12',
      implementation: 'Ctrl+F12',
      callHierarchy: 'Alt+Shift+H',
      navBack: 'Alt+Left',
      navForward: 'Alt+Right',
    });
  });

  it('ships the comments panel unbound, like Zen', () => {
    expect(KEYBINDING_DEFAULTS.commentsPanel).toBe('');
    expect(keybindingsFrom({ commentsPanel: 'alt+c' })).toEqual({
      zen: '',
      commentsPanel: 'Alt+C',
      viewedFile: 'Alt+V',
      viewMode: 'Alt+A',
      definition: 'F12',
      references: 'Shift+F12',
      implementation: 'Ctrl+F12',
      callHierarchy: 'Alt+Shift+H',
      navBack: 'Alt+Left',
      navForward: 'Alt+Right',
    });
  });

  it('ships the view-mode switch bound to Alt+A, and keeps it cleared once cleared', () => {
    expect(KEYBINDING_DEFAULTS.viewMode).toBe('Alt+A');
    expect(keybindingsFrom({}).viewMode).toBe('Alt+A');
    expect(keybindingsFrom({ viewMode: '' }).viewMode).toBe('');
  });

  it('ships no two actions on the same shortcut', () => {
    const bound = Object.values(KEYBINDING_DEFAULTS).filter(Boolean);
    expect(new Set(bound).size).toBe(bound.length);
  });

  it('ships the viewed-file shortcut bound to Alt+V, and keeps it cleared once cleared', () => {
    expect(KEYBINDING_DEFAULTS.viewedFile).toBe('Alt+V');
    expect(keybindingsFrom({}).viewedFile).toBe('Alt+V');
    expect(keybindingsFrom({ viewedFile: '' }).viewedFile).toBe('');
  });

  it('ships code navigation on F12 and Alt+←/→', () => {
    expect(KEYBINDING_DEFAULTS.definition).toBe('F12');
    expect(KEYBINDING_DEFAULTS.navBack).toBe('Alt+Left');
    expect(KEYBINDING_DEFAULTS.navForward).toBe('Alt+Right');
  });
});

describe('arrow keys', () => {
  it('bind only with Ctrl, Alt or Meta', () => {
    expect(parseBinding('Alt+Left')).toEqual({ ctrl: false, alt: true, shift: false, meta: false, key: 'Left' });
    expect(normalizeBinding('alt+arrowright')).toBe('Alt+Right');
    expect(normalizeBinding('Ctrl+→')).toBe('Ctrl+Right');
    expect(parseBinding('Left')).toBeNull();
    expect(parseBinding('Shift+Right')).toBeNull();
  });

  it('are read from events with a modifier', () => {
    expect(bindingFromEvent(press('ArrowLeft', { altKey: true }))?.key).toBe('Left');
    expect(bindingFromEvent(press('ArrowRight', { shiftKey: true }))).toBeNull();
    expect(matchesEvent('Alt+Left', press('ArrowLeft', { altKey: true }))).toBe(true);
    expect(matchesEvent('Alt+Left', press('ArrowRight', { altKey: true }))).toBe(false);
  });

  it('show as arrows', () => {
    expect(displayBinding('Alt+Left')).toBe('Alt+←');
    expect(displayBinding('Ctrl+Right')).toBe('Ctrl+→');
    expect(displayBinding('F12')).toBe('F12');
    expect(displayBinding('')).toBe('');
  });
});

describe('code navigation panel shortcuts', () => {
  it('ship as Shift+F12, Ctrl+F12 and Shift+Alt+H, stored canonically', () => {
    expect([KEYBINDING_DEFAULTS.references, KEYBINDING_DEFAULTS.implementation, KEYBINDING_DEFAULTS.callHierarchy]).toEqual([
      'Shift+F12',
      'Ctrl+F12',
      'Alt+Shift+H',
    ]);
    expect(normalizeBinding('Shift+Alt+H')).toBe('Alt+Shift+H');
  });

  it('tell F12 from Shift+F12 and Ctrl+F12', () => {
    const f12 = press('F12');
    const shiftF12 = press('F12', { shiftKey: true });
    const ctrlF12 = press('F12', { ctrlKey: true });
    expect([matchesEvent('F12', f12), matchesEvent('F12', shiftF12), matchesEvent('F12', ctrlF12)]).toEqual([true, false, false]);
    expect([matchesEvent('Shift+F12', shiftF12), matchesEvent('Ctrl+F12', ctrlF12)]).toEqual([true, true]);
    // By physical key: Alt+Shift+H on a Cyrillic layout is still KeyH.
    expect(matchesEvent('Alt+Shift+H', press('KeyH', { altKey: true, shiftKey: true }))).toBe(true);
  });
});
