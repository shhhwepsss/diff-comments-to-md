import { Marked } from 'marked';
import DOMPurify, { type DOMPurify as Purifier } from 'dompurify';

// Markdown -> sanitized HTML for the rendered view. The text comes from the
// diff, so it is untrusted: marked passes raw HTML through and DOMPurify is what
// makes the result safe. Loaded lazily together with MarkdownPreview.

const marked = new Marked({ gfm: true, breaks: false });

const SAFE_LINK = /^(https?:|mailto:)/i;
const SAFE_SRC = /^(https?:|data:image\/)/i;

let purifier: Purifier | null = null;

/** A private DOMPurify instance, so the hooks below never touch the global one. */
function getPurifier(): Purifier {
  if (purifier) return purifier;
  const p = DOMPurify(window);

  // Checkboxes are what GFM task lists render; any other form control goes.
  p.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName === 'input' && (node as Element).getAttribute('type')?.toLowerCase() !== 'checkbox') {
      node.parentNode?.removeChild(node);
    }
  });

  p.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element;
    const tag = el.tagName?.toLowerCase();

    if (tag === 'input') {
      el.setAttribute('disabled', '');
      return;
    }

    if (tag === 'a') {
      const href = el.getAttribute('href');
      el.removeAttribute('target');
      if (href && SAFE_LINK.test(href.trim())) {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer nofollow');
      } else if (href !== null) {
        // Relative and #fragment links would navigate the review app itself.
        el.removeAttribute('href');
        el.setAttribute('title', `Ссылка внутри репозитория: ${href}`);
      }
    }

    if (el.hasAttribute('src')) {
      const src = (el.getAttribute('src') ?? '').trim();
      if (!SAFE_SRC.test(src)) {
        // Relative paths would resolve against the review server, not the repo.
        el.removeAttribute('src');
        if (tag === 'img') {
          el.classList.add('rv-md-unresolved');
          el.setAttribute('title', `Картинка по относительному пути не загружается: ${src}`);
        }
      }
    }
  });

  purifier = p;
  return p;
}

export function renderMarkdown(text: string): string {
  const raw = marked.parse(text, { async: false });
  return getPurifier().sanitize(raw, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'button', 'select', 'option', 'textarea'],
    FORBID_ATTR: ['style', 'srcset'],
    SANITIZE_NAMED_PROPS: true,
  });
}
