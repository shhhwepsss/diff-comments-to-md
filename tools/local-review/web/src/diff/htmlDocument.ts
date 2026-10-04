// An .html file of the diff -> the document the rendered view puts into a
// sandboxed iframe (HtmlPreview). The text is untrusted, so the iframe's
// sandbox is the wall: no scripts unless the reviewer runs them, and even then
// an opaque origin that can't reach the app or its API. What this module adds
// is privacy: a Content-Security-Policy that keeps the page from loading
// anything from the network until the reviewer asks for it.

export type HtmlOptions = {
  /** Inline scripts run (the iframe also gets allow-scripts). */
  scripts?: boolean;
  /** Remote images, styles, fonts, scripts and requests may load. */
  external?: boolean;
};

export type PreparedHtml = {
  html: string;
  /** Remote resources the page refers to; they load only with `external`. */
  externalRefs: number;
};

/** Message the injected script posts with the document height (scripts mode only). */
export const HEIGHT_MESSAGE = 'rvHtmlHeight';

const REMOTE = /^(https?:)?\/\//i;
const CSS_REMOTE_URL = /url\(\s*['"]?(https?:)?\/\//gi;

export function contentSecurityPolicy({ scripts = false, external = false }: HtmlOptions): string {
  const remote = external ? ' https: http:' : '';
  return [
    "default-src 'none'",
    `img-src data: blob:${remote}`,
    `media-src data: blob:${remote}`,
    `style-src 'unsafe-inline' data:${remote}`,
    `font-src data:${remote}`,
    `script-src ${scripts ? `'unsafe-inline'${remote}` : "'none'"}`,
    `connect-src ${scripts && external ? 'https: http:' : "'none'"}`,
    "form-action 'none'",
  ].join('; ');
}

// Reports the height so the iframe can grow to fit, like the markdown view.
// Only the page's own frame can read it; a page script could post a fake
// height too, which only resizes its own frame.
const HEIGHT_SCRIPT = `(function(){var d=document.documentElement;function s(){var h=Math.max(d.getBoundingClientRect().height,document.body?document.body.scrollHeight:0);parent.postMessage({${HEIGHT_MESSAGE}:Math.ceil(h)},'*')}new ResizeObserver(s).observe(d);addEventListener('load',s)})();`;

function countExternal(doc: Document): number {
  let n = 0;
  for (const el of Array.from(doc.querySelectorAll('[src], [srcset], [poster], link[href], object[data]'))) {
    const urls = [
      el.getAttribute('src'),
      el.getAttribute('poster'),
      el.getAttribute('data'),
      el.tagName === 'LINK' ? el.getAttribute('href') : null,
      ...(el.getAttribute('srcset') ?? '').split(',').map((s) => s.trim().split(/\s+/)[0]),
    ];
    if (urls.some((u) => u && REMOTE.test(u.trim()))) n++;
  }
  for (const el of Array.from(doc.querySelectorAll('style, [style]'))) {
    const css = el.tagName === 'STYLE' ? el.textContent ?? '' : el.getAttribute('style') ?? '';
    n += css.match(CSS_REMOTE_URL)?.length ?? 0;
  }
  return n;
}

/**
 * The page as the iframe's srcdoc: parsed (nothing runs or loads while
 * parsing), with the policy as the first thing in <head>, so it covers the
 * whole document, and without <meta http-equiv="refresh">, which would send
 * the frame off to another address on its own. The doctype stays as the file
 * had it, quirks mode included.
 */
export function prepareHtml(text: string, opts: HtmlOptions = {}): PreparedHtml {
  const doc = new DOMParser().parseFromString(text, 'text/html');

  for (const meta of Array.from(doc.querySelectorAll('meta[http-equiv]'))) {
    if (meta.getAttribute('http-equiv')?.trim().toLowerCase() === 'refresh') meta.remove();
  }

  const csp = doc.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', contentSecurityPolicy(opts));
  const injected: Element[] = [csp];
  if (opts.scripts) {
    const s = doc.createElement('script');
    s.textContent = HEIGHT_SCRIPT;
    injected.push(s);
  }
  doc.head.prepend(...injected);

  const doctype = doc.doctype ? new XMLSerializer().serializeToString(doc.doctype) : '';
  return { html: doctype + doc.documentElement.outerHTML, externalRefs: countExternal(doc) };
}
