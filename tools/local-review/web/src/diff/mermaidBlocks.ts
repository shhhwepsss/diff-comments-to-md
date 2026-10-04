// Turns the mermaid blocks renderMarkdown marked into diagrams. No mermaid
// import here: the caller passes `draw`, so the library stays in its own lazy
// chunk and this part is testable without a browser layout engine.
//
// The diagram goes into the page as <img src="data:image/svg+xml,...">, never
// as markup. An SVG shown through <img> is a static picture: the browser runs
// no script in it and loads nothing it refers to, whatever the source said.

export const MERMAID_BLOCK = 'rv-mermaid';
const RENDERED = 'rv-mermaid--rendered';
const DIAGRAM = 'rv-mermaid__diagram';
const ERROR = 'rv-mermaid__error';

const SVG_IMAGE = /^data:image\/svg\+xml[;,]/;
const MAX_REASON = 200;

const REMOTE_BLOCKED = 'Диаграмма не отрисована: в ней есть внешний адрес, а просмотр ничего не загружает из сети.';

// mermaid's own spelling of a character inside a diagram: #58; #x3a; #colon;
const ENTITY = /#(?:(\d{1,7})|x([\da-f]{1,6})|(colon|sol|bsol));/gi;
const NAMED: Record<string, string> = { colon: ':', sol: '/', bsol: '\\' };
// A scheme the browser would go to the network for, or the start of a
// protocol-relative address. Backslashes count: URL parsing reads them as slashes.
const REMOTE = /(?:https?|wss?|ftp)\s*:|[/\\]{2}/i;

/**
 * While mermaid lays a diagram out, the diagram is in the live page, and some
 * shapes load an image there (flowchart `@{ img: "https://..." }`): that
 * request would tell a remote server the reviewer's IP. mermaid has no switch
 * for it, so a source that mentions a remote address anywhere is not drawn at
 * all. Deliberately coarse: a URL in a label is refused too.
 */
export function hasRemoteReference(source: string): boolean {
  const plain = source
    // The URL parser drops tabs and line breaks, so "ht\ttps:" is still https.
    .replace(/[\t\r\n]/g, '')
    .replace(ENTITY, (_m, dec?: string, hex?: string, name?: string) => {
      if (name) return NAMED[name.toLowerCase()];
      const code = dec ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? '', 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : '';
    });
  return REMOTE.test(plain);
}

/** Source of one diagram in, URL for an <img> out; rejects when it cannot be drawn. */
export type DrawMermaid = (source: string) => Promise<string>;

export function mermaidErrorText(e: unknown): string {
  const message = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  // mermaid's parse errors are several lines long; the first one names the place.
  const reason = message.trim().split('\n')[0].trim();
  if (!reason) return 'Не удалось отрисовать диаграмму mermaid.';
  return `Не удалось отрисовать диаграмму mermaid: ${reason.length > MAX_REASON ? `${reason.slice(0, MAX_REASON)}…` : reason}`;
}

/**
 * mermaid hands back an HTML-serialized <svg width="100%">. An image needs
 * well-formed XML and a size of its own, so the markup is re-read on an inert
 * DOMParser document, sized from its viewBox and serialized as XML.
 */
export function svgImageUrl(svgMarkup: string): string {
  const doc = new DOMParser().parseFromString(`<body>${svgMarkup}</body>`, 'text/html');
  const svg = doc.body.querySelector('svg');
  if (!svg) throw new Error('mermaid returned no svg');

  const box = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  if (box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0) {
    svg.setAttribute('width', String(box[2]));
    svg.setAttribute('height', String(box[3]));
  }
  const style = (svg.getAttribute('style') ?? '').replace(/max-width:[^;]*;?/gi, '').trim();
  if (style) svg.setAttribute('style', style);
  else svg.removeAttribute('style');

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
}

function show(box: Element, result: HTMLElement, rendered: boolean) {
  for (const old of [...box.querySelectorAll(`:scope > .${DIAGRAM}, :scope > .${ERROR}`)]) old.remove();
  box.classList.toggle(RENDERED, rendered);
  box.append(result);
}

/**
 * Draws every mermaid block under `root`, one at a time. A block that fails
 * keeps its source visible and gets an error line; the others still render.
 * Safe to call again (theme change): each result replaces the previous one.
 */
export async function renderMermaidBlocks(root: HTMLElement, draw: DrawMermaid, isStale: () => boolean): Promise<void> {
  for (const box of [...root.querySelectorAll(`.${MERMAID_BLOCK}`)]) {
    const code = box.querySelector(':scope > pre > code');
    if (!code) continue;
    if (isStale()) return;

    const source = code.textContent ?? '';
    let url: string | null = null;
    let problem = REMOTE_BLOCKED;
    if (!hasRemoteReference(source)) {
      try {
        url = await draw(source);
        if (!SVG_IMAGE.test(url)) throw new Error('not an svg image');
      } catch (e) {
        url = null;
        problem = mermaidErrorText(e);
      }
      if (isStale()) return;
    }

    const doc = box.ownerDocument;
    if (url) {
      const img = doc.createElement('img');
      img.className = DIAGRAM;
      img.alt = 'Диаграмма mermaid';
      img.src = url;
      show(box, img, true);
    } else {
      const error = doc.createElement('p');
      error.className = ERROR;
      error.textContent = problem;
      show(box, error, false);
    }
  }
}
