import { StateEffect, StateField, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';

// Comment cards and the comment editor live *inside* the document, as block
// widgets under their line. CodeMirror owns the container element; React
// renders into it through a portal, so Primer context and theme still apply.

export type Block = { key: string; line: number };

type Listener = () => void;

/** The containers CodeMirror currently shows, for React to portal into. */
export class PortalRegistry {
  private containers = new Map<string, HTMLElement>();
  private listeners = new Set<Listener>();
  private version = 0;
  private observer: ResizeObserver | null = null;
  view: EditorView | null = null;

  register(key: string, el: HTMLElement) {
    this.containers.set(key, el);
    this.observe(el);
    this.bump();
  }

  unregister(key: string, el: HTMLElement) {
    if (this.containers.get(key) === el) this.containers.delete(key);
    this.observer?.unobserve(el);
    this.bump();
  }

  entries(): [string, HTMLElement][] {
    return [...this.containers.entries()];
  }

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.version;

  destroy() {
    this.observer?.disconnect();
    this.observer = null;
    this.containers.clear();
    this.bump();
  }

  private observe(el: HTMLElement) {
    // A card that grows (textarea autosize, edit mode) must push the lines
    // below it down; CodeMirror only re-measures when asked.
    this.observer ??= new ResizeObserver(() => this.view?.requestMeasure());
    this.observer.observe(el);
  }

  private bump() {
    this.version += 1;
    // Notify after CodeMirror finishes its DOM update, not in the middle of it.
    queueMicrotask(() => this.listeners.forEach((l) => l()));
  }
}

export class PortalWidget extends WidgetType {
  constructor(
    readonly key: string,
    readonly registry: PortalRegistry,
  ) {
    super();
  }

  eq(other: PortalWidget) {
    return other.key === this.key && other.registry === this.registry;
  }

  toDOM() {
    const el = document.createElement('div');
    el.className = 'rv-block';
    el.dataset.key = this.key;
    this.registry.register(this.key, el);
    return el;
  }

  destroy(el: HTMLElement) {
    this.registry.unregister(this.key, el);
  }

  // Clicks and typing inside a card belong to React, not to the editor.
  ignoreEvent() {
    return true;
  }

  get estimatedHeight() {
    return 96;
  }
}

export const setBlocks = StateEffect.define<Block[]>();

export function blocksField(registry: PortalRegistry) {
  return StateField.define<{ blocks: Block[]; deco: DecorationSet }>({
    create: () => ({ blocks: [], deco: Decoration.none }),
    update(value, tr) {
      for (const e of tr.effects) {
        if (!e.is(setBlocks)) continue;
        const doc = tr.state.doc;
        const ranges: Range<Decoration>[] = [];
        for (const b of e.value) {
          if (b.line < 1 || b.line > doc.lines) continue;
          ranges.push(
            Decoration.widget({ widget: new PortalWidget(b.key, registry), block: true, side: 1 }).range(doc.line(b.line).to),
          );
        }
        return { blocks: e.value, deco: Decoration.set(ranges, true) };
      }
      return value;
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
  });
}
