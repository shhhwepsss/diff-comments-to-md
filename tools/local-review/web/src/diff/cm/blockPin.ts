import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';

// With line wrap off the content is as wide as its longest line and scrolls
// sideways; a comment card is a block inside that content, so it would scroll
// away under the sticky gutters. The cards are `position: sticky` instead
// (cm/theme.ts) and take their place from two CSS variables kept here: where
// the gutters end and how much of the editor is visible to the right of them.

export type PinBox = { left: number; width: number };

/** The part of the scroller not covered by the gutters. */
export function pinBox(scrollerWidth: number, guttersWidth: number): PinBox {
  const left = Math.max(0, guttersWidth);
  return { left, width: Math.max(0, scrollerWidth - left) };
}

export const pinBlocks = ViewPlugin.fromClass(
  class {
    private observer: ResizeObserver;
    private applied = '';
    private request;

    constructor(readonly view: EditorView) {
      this.request = {
        key: this,
        read: (v: EditorView) => {
          const gutters = v.scrollDOM.querySelector('.cm-gutters');
          return pinBox(v.scrollDOM.clientWidth, gutters ? gutters.getBoundingClientRect().width : 0);
        },
        write: (box: PinBox, v: EditorView) => {
          const key = `${box.left}:${box.width}`;
          if (key === this.applied) return;
          this.applied = key;
          v.dom.style.setProperty('--rv-pin-left', `${box.left}px`);
          v.dom.style.setProperty('--rv-pin-width', `${box.width}px`);
        },
      };
      // The pane, the sidebar or the window got resized.
      this.observer = new ResizeObserver(() => view.requestMeasure(this.request));
      this.observer.observe(view.scrollDOM);
      view.requestMeasure(this.request);
    }

    update(update: ViewUpdate) {
      // The gutters can widen (longer numbers after a fold opens).
      if (update.geometryChanged) update.view.requestMeasure(this.request);
    }

    destroy() {
      this.observer.disconnect();
    }
  },
);
