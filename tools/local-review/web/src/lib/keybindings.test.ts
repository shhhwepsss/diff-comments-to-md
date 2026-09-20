import { describe, expect, it } from 'vitest';
import {
  bindingFromEvent,
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
    expect(keybindingsFrom({ zen: 'shift+ctrl+f', nope: 'Ctrl+Q' })).toEqual({ zen: 'Ctrl+Shift+F' });
  });

  it('an unusable binding becomes unbound, not an error', () => {
    expect(keybindingsFrom({ zen: 'Ctrl+Escape' })).toEqual({ zen: '' });
  });
});
