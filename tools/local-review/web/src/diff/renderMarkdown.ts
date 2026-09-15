import { Marked } from 'marked';
import DOMPurify, { type DOMPurify as Purifier } from 'dompurify';

// Markdown -> sanitized HTML for the rendered view. The text comes from the
// diff, so it is untrusted: marked passes raw HTML through, and DOMPurify with
// a strict allowlist is what makes the result safe. Loaded lazily together
// with MarkdownPreview.
//
// Privacy: nothing in the output may make the browser fetch a remote URL on
// its own. Remote images come out as text placeholders unless the reviewer
// asked to load them (loadExternalImages).

const marked = new Marked({ gfm: true, breaks: false });

const SAFE_LINK = /^(https?:|mailto:)/i;
const REMOTE_SRC = /^https?:/i;
const DATA_IMAGE = /^data:image\//i;

/** Parking spot for a remote image URL; never a loadable attribute. */
const REMOTE_ATTR = 'data-rv-remote-src';
const RELATIVE_ATTR = 'data-rv-relative-src';

// What GFM (plus the raw HTML READMEs commonly use) needs, and nothing that
// can load a resource by itself: no picture/source/video/audio/track, iframe,
// object/embed, link/style, svg/math, forms; no srcset/poster/background/
// style/action/data-* attributes. `src` is only honoured on <img>, below.
const ALLOWED_TAGS = [
  'a', 'abbr', 'b', 'bdi', 'bdo', 'blockquote', 'br', 'caption', 'center', 'cite', 'code', 'col', 'colgroup',
  'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5',
  'h6', 'hr', 'i', 'img', 'input', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 'rp', 'rt', 'ruby', 's',
  'samp', 'small', 'span', 'strike', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'time', 'tr', 'tt', 'u', 'ul', 'var', 'wbr',
];
const ALLOWED_ATTR = [
  'align', 'alt', 'checked', 'class', 'colspan', 'datetime', 'dir', 'disabled', 'height', 'href', 'id', 'lang',
  'name', 'open', 'reversed', 'rowspan', 'scope', 'src', 'start', 'title', 'type', 'valign', 'width',
];

let purifier: Purifier | null = null;

/** A private DOMPurify instance, so the hooks below never touch the global one. */
function getPurifier(): Purifier {
  if (purifier) return purifier;
  const p = DOMPurify(window);

  // Checkboxes are what GFM task lists render; any other input goes.
  p.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName === 'input' && (node as Element).getAttribute('type')?.toLowerCase() !== 'checkbox') {
      node.parentNode?.removeChild(node);
    }
  });

  // Runs on DOMPurify's inert parse document, where nothing loads.
  p.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element;
    const tag = el.tagName?.toLowerCase();

    if (tag === 'input') el.setAttribute('disabled', '');

    if (tag === 'a') {
      const href = el.getAttribute('href');
      if (href && SAFE_LINK.test(href.trim())) {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer nofollow');
      } else if (href !== null) {
        // Relative and #fragment links would navigate the review app itself.
        el.removeAttribute('href');
        el.setAttribute('title', `Ссылка внутри репозитория: ${href}`);
      }
    } else {
      el.removeAttribute('href');
    }

    if (el.hasAttribute('src')) {
      const src = (el.getAttribute('src') ?? '').trim();
      el.removeAttribute('src');
      if (tag === 'img') {
        if (DATA_IMAGE.test(src)) el.setAttribute('src', src);
        else if (REMOTE_SRC.test(src)) el.setAttribute(REMOTE_ATTR, src);
        // Relative paths would resolve against the review server, not the repo.
        else el.setAttribute(RELATIVE_ATTR, src);
      }
    }
  });

  purifier = p;
  return p;
}

function placeholder(doc: Document, img: Element, url: string, kind: 'external' | 'relative'): HTMLElement {
  const box = doc.createElement('span');
  box.className = `rv-md-image rv-md-image--${kind}`;
  const alt = img.getAttribute('alt')?.trim();
  if (alt) {
    const altEl = doc.createElement('span');
    altEl.className = 'rv-md-image__alt';
    altEl.textContent = alt;
    box.append(altEl);
  }
  const urlEl = doc.createElement('span');
  urlEl.className = 'rv-md-image__url';
  urlEl.textContent = url;
  box.append(urlEl);
  return box;
}

export type RenderOptions = { loadExternalImages?: boolean };
export type RenderedMarkdown = { html: string; externalImages: number };

export function renderMarkdown(text: string, { loadExternalImages = false }: RenderOptions = {}): RenderedMarkdown {
  const raw = marked.parse(text, { async: false });
  const clean = getPurifier().sanitize(raw, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    SANITIZE_NAMED_PROPS: true,
  });

  // Second pass on an inert DOMParser document (no fetches happen there) to
  // turn parked image URLs into placeholders, or back into src on request.
  const doc = new DOMParser().parseFromString(`<body>${clean}</body>`, 'text/html');
  let externalImages = 0;
  for (const img of [...doc.body.querySelectorAll(`img[${REMOTE_ATTR}]`)]) {
    const url = img.getAttribute(REMOTE_ATTR) ?? '';
    img.removeAttribute(REMOTE_ATTR);
    externalImages++;
    if (loadExternalImages) {
      img.setAttribute('src', url);
      img.setAttribute('referrerpolicy', 'no-referrer');
    } else {
      img.replaceWith(placeholder(doc, img, url, 'external'));
    }
  }
  for (const img of [...doc.body.querySelectorAll(`img[${RELATIVE_ATTR}]`)]) {
    const path = img.getAttribute(RELATIVE_ATTR) ?? '';
    const box = placeholder(doc, img, path, 'relative');
    box.title = 'Картинка по относительному пути не загружается';
    img.replaceWith(box);
  }
  return { html: doc.body.innerHTML, externalImages };
}
