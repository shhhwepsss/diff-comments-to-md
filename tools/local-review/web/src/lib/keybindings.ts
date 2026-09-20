// User-assigned keyboard shortcuts.
//
// A binding is stored as one canonical string — `Ctrl+Shift+F` — with the
// modifiers in a fixed order. Empty string means "not bound", which is the
// default for every action: the app ships with no shortcut at all.
//
// The key half comes from `KeyboardEvent.code`, never from `.key`: `code` is
// the physical key, so a binding made on a Latin layout still fires on a
// Cyrillic one. That also means only keys with a stable `code` can be bound —
// letters, digits and F1–F12 — which conveniently rules out Escape, Enter,
// Tab and Space, none of which should be stealable from the rest of the UI.
//
// Pure module: no DOM access, no storage. Components do the listening.

export type Binding = {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  /** 'A'–'Z', '0'–'9' or 'F1'–'F12'. */
  key: string;
};

/** Anything with the fields we read, so tests don't need a real event. */
export type KeyEventLike = {
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  code?: string;
};

/** Actions a shortcut can be bound to, with the label the settings page shows. */
export const KEYBINDING_ACTIONS = [{ id: 'zen', label: 'Zen: скрыть всё, кроме диффа' }] as const;

export type KeybindingAction = (typeof KEYBINDING_ACTIONS)[number]['id'];

export type Keybindings = Record<KeybindingAction, string>;

export const KEYBINDING_DEFAULTS: Keybindings = { zen: '' };

const MODIFIERS: Record<string, keyof Omit<Binding, 'key'>> = {
  CTRL: 'ctrl',
  CONTROL: 'ctrl',
  ALT: 'alt',
  OPTION: 'alt',
  SHIFT: 'shift',
  META: 'meta',
  CMD: 'meta',
  COMMAND: 'meta',
  WIN: 'meta',
};

function normalizeKey(raw: string): string | null {
  const key = raw.trim().toUpperCase();
  if (/^[A-Z0-9]$/.test(key)) return key;
  if (/^F([1-9]|1[0-2])$/.test(key)) return key;
  return null;
}

/** Stored string -> binding; '' and anything malformed give null. */
export function parseBinding(raw: string): Binding | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const binding: Binding = { ctrl: false, alt: false, shift: false, meta: false, key: '' };
  for (const part of parts) {
    const modifier = MODIFIERS[part.toUpperCase()];
    if (modifier) {
      binding[modifier] = true;
      continue;
    }
    // A second non-modifier part is not a chord we support.
    if (binding.key) return null;
    const key = normalizeKey(part);
    if (!key) return null;
    binding.key = key;
  }
  return binding.key ? binding : null;
}

export function formatBinding(binding: Binding): string {
  const parts: string[] = [];
  if (binding.ctrl) parts.push('Ctrl');
  if (binding.alt) parts.push('Alt');
  if (binding.shift) parts.push('Shift');
  if (binding.meta) parts.push('Meta');
  parts.push(binding.key);
  return parts.join('+');
}

/** What gets stored: the canonical spelling, or '' for anything unusable. */
export function normalizeBinding(raw: string): string {
  const binding = parseBinding(raw);
  return binding ? formatBinding(binding) : '';
}

/** The pressed key as a bindable name, or null for keys we refuse to bind. */
function keyFromEvent(event: KeyEventLike): string | null {
  const code = event.code || '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;
  return null;
}

/** A keypress as a binding, for the «нажми сочетание» field. */
export function bindingFromEvent(event: KeyEventLike): Binding | null {
  const key = keyFromEvent(event);
  if (!key) return null;
  return { ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey, key };
}

/** Does this keypress trigger the stored binding? An empty binding never does. */
export function matchesEvent(raw: string, event: KeyEventLike): boolean {
  const binding = parseBinding(raw);
  if (!binding) return false;
  const pressed = bindingFromEvent(event);
  if (!pressed) return false;
  return (
    pressed.key === binding.key &&
    pressed.ctrl === binding.ctrl &&
    pressed.alt === binding.alt &&
    pressed.shift === binding.shift &&
    pressed.meta === binding.meta
  );
}

/**
 * Is the focus somewhere text is being typed? A global shortcut must not fire
 * there — the comment form owns its own keys (CommentCard.tsx:56-60), and so
 * does the file filter.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const node = target as (HTMLElement & { tagName?: string }) | null;
  if (!node || typeof node.tagName !== 'string') return false;
  const tag = node.tagName.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return node.isContentEditable === true;
}

/** Whatever came back from the server, shaped into a full bindings map. */
export function keybindingsFrom(value: unknown): Keybindings {
  const out = { ...KEYBINDING_DEFAULTS };
  if (!value || typeof value !== 'object') return out;
  for (const action of KEYBINDING_ACTIONS) {
    const raw = (value as Record<string, unknown>)[action.id];
    if (typeof raw === 'string') out[action.id] = normalizeBinding(raw);
  }
  return out;
}
