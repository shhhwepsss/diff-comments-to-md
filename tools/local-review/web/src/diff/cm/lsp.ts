import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, closeHoverTooltips, hoverTooltip, type DecorationSet, type Tooltip } from '@codemirror/view';
import { language } from '@codemirror/language';
import { highlightCode } from '@lezer/highlight';
import type { LspCallDirection, LspHover, LspLocation } from '../../api/types';
import type { CodeNavKeys, NavQuery, NavTab, TextNav } from '../../nav/codeNav';
import { findDeclarations, findWord, type TextFile } from '../../nav/textSearch';
import { kindFromHover, mayHaveCalls, mayHaveImplementations, type SymbolKind } from '../../nav/navList';
import { displayBinding, isTypingTarget } from '../../lib/keybindings';
import { portalOpen } from '../../lib/portal';
import { failureText, indicatorFor, type LspSession } from '../../lsp/session';
import { hoverBlocks, inlineParts } from '../../lsp/hoverText';
import { githubHighlightStyle } from './theme';
import { wordAt } from './occurrenceMatch';

// Code navigation in a diff: hover for the signature and docs, Ctrl/Cmd+click
// (and F12, and the context menu) for «go to definition»; references,
// implementations and the call hierarchy open the navigation panel
// (nav/NavPanel.tsx) from the menu, the hover's buttons and their shortcuts.
// Everything asks the language server through the review's LspSession; this
// file is the editor side — which word is under the pointer, the tooltip,
// the menu.
//
// Only the document is navigable: it is the new side of the diff (added and
// unchanged lines), the text the server sees. Deleted lines are the merge
// view's widgets with no file on disk behind them, so they get neither hover
// nor a menu (the highlight of occurrences still works there).
//
// A GitHub PR with no local clone has no server to ask: there «definition»
// and «references» search the text of the files of the diff instead
// (nav/textSearch.ts), and the rest says that it needs a clone.

const NEEDS_CLONE = 'Нужен локальный клон: реализации и иерархию вызовов LSP ищет по типам. «Клонировать…» — над диффом';

/** The context menu on screen, if any: one for the whole page. */
let openMenu: { el: HTMLElement; close: () => void } | null = null;

/** A word of the document: its range and the zero-based LSP position of its start. */
type Word = { from: number; to: number; line: number; character: number };

function wordRange(state: EditorState, pos: number): Word | null {
  const line = state.doc.lineAt(pos);
  const w = wordAt(line.text, pos - line.from);
  if (!w) return null;
  return { from: line.from + w.from, to: line.from + w.to, line: line.number - 1, character: w.from };
}

/** The word under a mouse event, when the pointer really is over it and over a document line. */
function wordAtPointer(view: EditorView, event: MouseEvent): Word | null {
  const target = event.target as HTMLElement | null;
  if (!target?.closest || !view.contentDOM.contains(target)) return null;
  // Deleted lines and comment cards are widgets inside the content.
  if (!target.closest('.cm-line') || target.closest('.cm-deletedChunk')) return null;
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (pos === null) return null;
  const w = wordRange(view.state, pos);
  if (!w) return null;
  const a = view.coordsAtPos(w.from, 1);
  const b = view.coordsAtPos(w.to, -1);
  if (!a || !b) return null;
  const inside = event.clientX >= a.left - 1 && event.clientX <= b.right + 1 && event.clientY >= a.top && event.clientY <= a.bottom;
  return inside ? w : null;
}

/**
 * One file's link to the language server. Lives as long as the file's
 * component; FileDiff refreshes its fields on every render, the editor under
 * it may be rebuilt.
 */
export class LspHub {
  path = '';
  session: LspSession | null = null;
  /** The text on screen is not the working tree (staged, commits): send it along. */
  sendText = false;
  /** The shortcuts, for the menu. */
  keys: CodeNavKeys | null = null;
  /** Navigation by text instead of a server (a PR with no clone); null when a server is there to ask. */
  text: TextNav | null = null;
  /** Open the place a definition is at; `fromLine` (1-based) is where the jump started. */
  onNavigate: (loc: LspLocation, fromLine: number) => void = () => undefined;
  /** Show the navigation panel for a symbol of this file. */
  onPanel: (query: NavQuery) => void = () => undefined;
  toast: (text: string, error?: boolean) => void = () => undefined;

  /** Ctrl+click and F12 lead somewhere here: a server answers, or the search by text. */
  canNavigate(): boolean {
    return this.text !== null || Boolean(this.session?.canAsk(this.path));
  }

  /** Why this file cannot be asked (about `tab`, when given), or null when it can. */
  unavailable(tab?: NavTab): string | null {
    if (this.text) return tab === 'implementation' || tab === 'calls' ? NEEDS_CLONE : null;
    const session = this.session;
    if (!session) return 'LSP недоступен';
    const indicator = indicatorFor(session.getSnapshot(), this.path);
    if (session.canAsk(this.path)) return null;
    if (!session.getSnapshot()) return 'Статус LSP ещё не загружен';
    return indicator ? indicator.title : 'Для этого типа файлов нет language server';
  }

  request(view: EditorView, w: Word) {
    return {
      path: this.path,
      line: w.line,
      character: w.character,
      ...(this.sendText ? { text: view.state.doc.toString() } : {}),
    };
  }

  /** References, implementations or calls of the word at `pos`, in the side panel. */
  openPanel(view: EditorView, pos: number, tab: NavTab, direction: LspCallDirection = 'incoming', kind?: SymbolKind | null) {
    const w = wordRange(view.state, pos);
    if (!w) return;
    const reason = this.unavailable(tab);
    if (reason) {
      this.toast(reason, true);
      return;
    }
    if (this.text) {
      void this.textPanel(view, w, 'references');
      return;
    }
    this.onPanel({ tab, direction, word: view.state.sliceDoc(w.from, w.to), kind, ...this.request(view, w) });
  }

  /** The panel with what the search by text found: declarations to choose from, or every occurrence. */
  private async textPanel(view: EditorView, w: Word, kind: 'definitions' | 'references', found?: { locations: LspLocation[]; skipped: number }) {
    const word = view.state.sliceDoc(w.from, w.to);
    let hits = found;
    if (!hits) {
      const { files, skipped } = await this.textFiles(view);
      if (!files) return;
      hits = { locations: findWord(files, word), skipped };
    }
    this.onPanel({ tab: 'references', direction: 'incoming', word, path: this.path, line: w.line, character: w.character, textHits: { kind, ...hits } });
  }

  /** The texts of the files of the diff, with the editor marked busy while they load. */
  private async textFiles(view: EditorView): Promise<{ files: TextFile[] | null; skipped: number }> {
    view.dom.classList.add('rv-lsp-pending');
    try {
      return await this.text!.files();
    } catch (e) {
      this.toast(`Не удалось прочитать файлы диффа: ${e instanceof Error ? e.message : String(e)}`, true);
      return { files: null, skipped: 0 };
    } finally {
      view.dom.classList.remove('rv-lsp-pending');
    }
  }

  /**
   * «Definition» without a server: the lines of the diff's files that declare
   * the word. One — it is opened; several — the panel lists them; the
   * declaration itself clicked — its uses, as VS Code does.
   */
  private async definitionByText(view: EditorView, w: Word) {
    const word = view.state.sliceDoc(w.from, w.to);
    const { files, skipped } = await this.textFiles(view);
    if (!files) return;
    const found = findDeclarations(files, word);
    const more = skipped ? ` (прочитаны не все файлы диффа: пропущено ${skipped})` : '';
    if (found.length === 0) {
      this.toast(`Объявление «${word}» не найдено поиском по тексту${more}`);
      return;
    }
    const here = found.length === 1 && found[0].path === this.path && found[0].line === w.line && found[0].character === w.character;
    if (here) {
      await this.textPanel(view, w, 'references');
      return;
    }
    if (found.length === 1) {
      this.onNavigate(found[0], view.state.doc.lineAt(w.from).number);
      return;
    }
    await this.textPanel(view, w, 'definitions', { locations: found, skipped });
  }

  async goToDefinition(view: EditorView, pos: number) {
    const w = wordRange(view.state, pos);
    if (!w) return;
    if (this.text) {
      await this.definitionByText(view, w);
      return;
    }
    const reason = this.unavailable();
    if (reason) {
      this.toast(reason, true);
      return;
    }
    view.dom.classList.add('rv-lsp-pending');
    try {
      const res = await this.session!.definition(this.request(view, w));
      if (!res.ok) {
        this.toast(failureText(res), true);
        return;
      }
      const target = res.locations[0];
      if (!target) {
        this.toast(`Определение «${view.state.sliceDoc(w.from, w.to)}» не найдено`);
        return;
      }
      if (target.path === null) {
        this.toast(
          target.gitInternal
            ? `Определение в служебных файлах .git (${target.external ?? ''}) — они не открываются`
            : `Определение вне репозитория: ${target.external ?? 'неизвестно где'}`,
        );
        return;
      }
      if (res.locations.length > 1) this.toast(`Определений: ${res.locations.length} — открыто первое`);
      this.onNavigate(target, view.state.doc.lineAt(w.from).number);
    } catch (e) {
      this.toast(`Не удалось перейти к определению: ${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      view.dom.classList.remove('rv-lsp-pending');
    }
  }
}

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** The «follow the link» modifier: Cmd on a Mac (where Ctrl+click is the right click), Ctrl elsewhere. */
function linkModifier(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return MAC ? e.metaKey : e.ctrlKey || e.metaKey;
}

/** The editor whose caret F12 acts on: the one clicked last. */
let active: { hub: LspHub; view: EditorView } | null = null;

/** The word at the caret of the last clicked file, if that file is still on screen. */
function caretWord(): { hub: LspHub; view: EditorView; pos: number } | null {
  if (!active || !active.view.dom.isConnected) return null;
  const { hub, view } = active;
  const pos = view.state.selection.main.head;
  return wordRange(view.state, pos) ? { hub, view, pos } : null;
}

/** F12 (or whatever it is bound to): definition of the word at the caret of the last clicked file. */
export function definitionAtCaret(): boolean {
  const at = caretWord();
  if (!at) return false;
  void at.hub.goToDefinition(at.view, at.pos);
  return true;
}

/** Shift+F12, Ctrl+F12, Alt+Shift+H: the panel for the word at the caret. */
export function panelAtCaret(tab: NavTab): boolean {
  const at = caretWord();
  if (!at) return false;
  at.hub.openPanel(at.view, at.pos, tab);
  return true;
}

// ------------------------------------------------------------ Ctrl+hover link

const setLink = StateEffect.define<{ from: number; to: number } | null>();
const linkMark = Decoration.mark({ class: 'rv-lsp-link' });

const linkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setLink)) return e.value ? Decoration.set([linkMark.range(e.value.from, e.value.to)]) : Decoration.none;
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** With Ctrl/Cmd held, the word under the pointer is underlined like a link. */
function linkPlugin(hub: LspHub) {
  return ViewPlugin.fromClass(
    class {
      current: { from: number; to: number } | null = null;
      last: MouseEvent | null = null;

      constructor(readonly view: EditorView) {
        view.contentDOM.addEventListener('mousemove', this.onMove);
        view.contentDOM.addEventListener('mouseleave', this.onLeave);
        window.addEventListener('keydown', this.onKey);
        window.addEventListener('keyup', this.onKey);
        window.addEventListener('blur', this.clear);
      }

      onMove = (e: MouseEvent) => {
        this.last = e;
        this.refresh(linkModifier(e));
      };

      onKey = (e: KeyboardEvent) => {
        if (e.key === 'Control' || e.key === 'Meta') this.refresh(e.type === 'keydown' && linkModifier(e));
      };

      clear = () => this.set(null);

      // The pointer is in another file now: Ctrl pressed there must not
      // underline a word here, at the spot the pointer last was.
      onLeave = () => {
        this.last = null;
        this.set(null);
      };

      refresh(mod: boolean) {
        const w = mod && this.last && hub.canNavigate() ? wordAtPointer(this.view, this.last) : null;
        this.set(w && { from: w.from, to: w.to });
      }

      set(range: { from: number; to: number } | null) {
        const same = range === this.current || (range && this.current && range.from === this.current.from && range.to === this.current.to);
        if (same) return;
        this.current = range;
        this.view.dom.classList.toggle('rv-lsp-mod', range !== null);
        this.view.dispatch({ effects: setLink.of(range) });
      }

      destroy() {
        this.view.contentDOM.removeEventListener('mousemove', this.onMove);
        this.view.contentDOM.removeEventListener('mouseleave', this.onLeave);
        window.removeEventListener('keydown', this.onKey);
        window.removeEventListener('keyup', this.onKey);
        window.removeEventListener('blur', this.clear);
      }
    },
  );
}

// ------------------------------------------------------------------- hover

const HOVER_MS = 350;

function hoverDom(view: EditorView, hub: LspHub, hover: LspHover, word: Word): HTMLElement {
  const dom = document.createElement('div');
  dom.className = 'rv-lsp-tip';
  const parser = view.state.facet(language)?.parser;
  for (const block of hoverBlocks(hover)) {
    if (block.type === 'code') {
      const pre = dom.appendChild(document.createElement('pre'));
      pre.className = 'rv-lsp-tip__code';
      if (parser) {
        highlightCode(
          block.text,
          parser.parse(block.text),
          githubHighlightStyle,
          (text, classes) => {
            if (!classes) pre.append(text);
            else {
              const span = pre.appendChild(document.createElement('span'));
              span.className = classes;
              span.textContent = text;
            }
          },
          () => pre.append('\n'),
        );
      } else pre.textContent = block.text;
    } else {
      for (const para of block.text.split(/\n{2,}/)) {
        const p = dom.appendChild(document.createElement('p'));
        p.className = 'rv-lsp-tip__doc';
        for (const part of inlineParts(para)) {
          if (part.code) p.appendChild(document.createElement('code')).textContent = part.text;
          else p.append(part.text);
        }
      }
    }
  }
  const acts = dom.appendChild(document.createElement('div'));
  acts.className = 'rv-lsp-tip__acts';
  const action = (label: string, title: string, run: () => void) => {
    const b = acts.appendChild(document.createElement('button'));
    b.type = 'button';
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      view.dispatch({ effects: closeHoverTooltips });
      run();
    });
  };
  // The first code block is the signature: `(method) …`, `class …`.
  const kind = kindFromHover(hoverBlocks(hover).find((b) => b.type === 'code')?.text);
  const keyOf = (k: keyof CodeNavKeys) => displayBinding(hub.keys?.[k] ?? '');
  action('Определение', keyOf('definition'), () => void hub.goToDefinition(view, word.from));
  action('Ссылки', keyOf('references'), () => hub.openPanel(view, word.from, 'references', 'incoming', kind));
  if (mayHaveImplementations(kind)) action('Реализации', keyOf('implementation'), () => hub.openPanel(view, word.from, 'implementation', 'incoming', kind));
  if (mayHaveCalls(kind)) action('Кто вызывает', keyOf('callHierarchy'), () => hub.openPanel(view, word.from, 'calls', 'incoming', kind));
  const hint = acts.appendChild(document.createElement('span'));
  hint.className = 'rv-lsp-tip__hint';
  hint.textContent = MAC ? '⌘+клик' : 'Ctrl+клик';
  return dom;
}

function hoverSource(hub: LspHub) {
  // One request at a time per editor; answers are kept for the life of the
  // document (it is read-only), so moving back over a word costs nothing.
  let controller: AbortController | null = null;
  const cache = new WeakMap<EditorState['doc'], Map<number, LspHover | null>>();
  return async (view: EditorView, pos: number): Promise<Tooltip | null> => {
    // Ctrl held means «link», and an open menu has the pointer's attention.
    if (view.dom.classList.contains('rv-lsp-mod') || openMenu) return null;
    const w = wordRange(view.state, pos);
    if (!w || !hub.session?.canAsk(hub.path)) return null;
    const doc = view.state.doc;
    let known = cache.get(doc);
    if (!known) cache.set(doc, (known = new Map()));
    let hover = known.get(w.from);
    if (hover === undefined) {
      controller?.abort();
      const mine = (controller = new AbortController());
      try {
        const res = await hub.session.hover(hub.request(view, w), mine.signal);
        // Failures are the indicator's to show; a tooltip saying «error» on
        // every word would be noise. Only answers are kept: a server that
        // was starting or had crashed may answer next time.
        hover = res.ok ? res.hover : null;
        if (res.ok) known.set(w.from, hover);
      } catch {
        return null;
      }
      if (mine.signal.aborted || view.state.doc !== doc) return null;
    }
    if (!hover) return null;
    const value = hover;
    return { pos: w.from, end: w.to, create: () => ({ dom: hoverDom(view, hub, value, w) }) };
  };
}

// ------------------------------------------------------------ context menu


export function closeLspMenu() {
  openMenu?.close();
}

function showMenu(view: EditorView, hub: LspHub, w: Word, x: number, y: number) {
  closeLspMenu();
  const name = view.state.sliceDoc(w.from, w.to);
  const el = document.createElement('div');
  el.className = 'rv-lsp-menu';
  el.setAttribute('role', 'menu');
  el.setAttribute('aria-label', `Действия с «${name}»`);
  const reason = hub.unavailable();
  const byText = hub.text !== null;

  const item = (label: string, kbd: string, run: () => void, disabled: string | null = null) => {
    const b = el.appendChild(document.createElement('button'));
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.className = 'rv-lsp-menu__item';
    b.appendChild(document.createElement('span')).textContent = label;
    if (kbd) b.appendChild(document.createElement('kbd')).textContent = kbd;
    if (disabled) {
      b.disabled = true;
      b.title = disabled;
    }
    b.addEventListener('click', () => {
      close();
      run();
    });
    return b;
  };

  const keys = hub.keys;
  item(byText ? 'Найти объявление (по тексту)' : 'Перейти к определению', displayBinding(keys?.definition ?? ''), () => void hub.goToDefinition(view, w.from), reason);
  item(byText ? 'Найти слово в файлах диффа' : 'Найти ссылки', displayBinding(keys?.references ?? ''), () => hub.openPanel(view, w.from, 'references'), reason);
  item('Реализации', displayBinding(keys?.implementation ?? ''), () => hub.openPanel(view, w.from, 'implementation'), hub.unavailable('implementation'));
  item('Иерархия вызовов', displayBinding(keys?.callHierarchy ?? ''), () => hub.openPanel(view, w.from, 'calls'), hub.unavailable('calls'));
  el.appendChild(document.createElement('hr'));
  item('Подсветить совпадения', '', () => view.dispatch({ selection: { anchor: w.from, head: w.to } }));
  item('Копировать имя', '', () => {
    void navigator.clipboard?.writeText(name).then(
      () => hub.toast(`Скопировано: ${name}`),
      () => hub.toast('Буфер обмена недоступен', true),
    );
  });
  const note = reason ?? (byText ? 'Нет локального клона — поиск по тексту файлов диффа, без типов' : null);
  if (note) {
    const div = el.appendChild(document.createElement('div'));
    div.className = 'rv-lsp-menu__note';
    div.textContent = note;
  }

  // Inside the app's root: Primer's colour variables are defined there, not on <body>.
  (document.querySelector('.rv-root') ?? document.body).appendChild(el);
  const box = el.getBoundingClientRect();
  el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - box.width - 8))}px`;
  el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - box.height - 8))}px`;
  const items = () => [...el.querySelectorAll<HTMLButtonElement>('.rv-lsp-menu__item:not(:disabled)')];
  // Focus moves into the menu for the arrows; it goes back where it was when
  // the menu closes with focus inside, so the keyboard does not land on <body>.
  const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  items()[0]?.focus();

  const onDown = (e: MouseEvent) => {
    if (!el.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    // Tab would walk out of the menu and leave it open behind the focus.
    if (e.key === 'Tab') {
      close();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const next = (at + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
    list[next]?.focus();
  };
  // A scroll still on its way when the menu opened (the page settling) must
  // not take it down; one the reviewer makes does.
  const openedAt = performance.now();
  const onScroll = () => {
    if (performance.now() - openedAt > 150) close();
  };
  const close = () => {
    window.removeEventListener('mousedown', onDown, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('blur', close);
    window.removeEventListener('resize', close);
    const hadFocus = el.contains(document.activeElement);
    el.remove();
    if (hadFocus && before?.isConnected) before.focus({ preventScroll: true });
    if (openMenu?.el === el) openMenu = null;
  };
  window.addEventListener('mousedown', onDown, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('blur', close);
  window.addEventListener('resize', close);
  openMenu = { el, close };
}

// --------------------------------------------------------------- extension

function handlers(hub: LspHub) {
  return EditorView.domEventHandlers({
    mousedown(e, view) {
      active = { hub, view };
      if (e.button !== 0 || !linkModifier(e)) return false;
      const w = wordAtPointer(view, e);
      if (!w) return false;
      // Not a multi-cursor click, not a text selection: a link.
      e.preventDefault();
      view.dispatch({ selection: { anchor: w.from }, effects: closeHoverTooltips });
      void hub.goToDefinition(view, w.from);
      return true;
    },
    contextmenu(e, view) {
      if (e.shiftKey) return false; // Shift+right click: the browser's own menu, always
      const w = wordAtPointer(view, e);
      if (!w) return false;
      e.preventDefault();
      active = { hub, view };
      view.dispatch({ selection: { anchor: w.from }, effects: closeHoverTooltips });
      showMenu(view, hub, w, e.clientX, e.clientY);
      return true;
    },
  });
}

/** Hover, Ctrl+click and the context menu for one file's editor. */
export function lspNavigation(hub: LspHub): Extension {
  return [linkField, linkPlugin(hub), handlers(hub), hoverTooltip(hoverSource(hub), { hoverTime: HOVER_MS })];
}

/** Keys that must not fire while a menu, a dialog or a text field has them. */
export function navKeysBlocked(e: KeyboardEvent): boolean {
  return e.defaultPrevented || isTypingTarget(e.target) || portalOpen() || openMenu !== null;
}
