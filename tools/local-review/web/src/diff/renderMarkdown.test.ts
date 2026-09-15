// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './renderMarkdown';

function dom(md: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = renderMarkdown(md);
  return el;
}

describe('renderMarkdown: GitHub-flavored markdown', () => {
  it('renders headings, emphasis, lists and code', () => {
    const el = dom('# Title\n\nSome **bold** and _em_ and ~~gone~~.\n\n- one\n- two\n\n1. first\n\n```ts\nconst a = 1;\n```\n');
    expect(el.querySelector('h1')?.textContent).toBe('Title');
    expect(el.querySelector('strong')?.textContent).toBe('bold');
    expect(el.querySelector('em')?.textContent).toBe('em');
    expect(el.querySelector('del')?.textContent).toBe('gone');
    expect(el.querySelectorAll('ul > li')).toHaveLength(2);
    expect(el.querySelector('ol > li')?.textContent).toBe('first');
    const code = el.querySelector('pre > code');
    expect(code?.textContent).toBe('const a = 1;\n');
    expect(code?.className).toBe('language-ts');
  });

  it('renders tables', () => {
    const el = dom('| a | b |\n|---|--:|\n| 1 | 2 |\n');
    expect(el.querySelectorAll('table th')).toHaveLength(2);
    expect(el.querySelector('table td')?.textContent).toBe('1');
  });

  it('renders task lists as disabled checkboxes', () => {
    const el = dom('- [x] done\n- [ ] todo\n');
    const boxes = [...el.querySelectorAll('input')];
    expect(boxes).toHaveLength(2);
    expect(boxes.every((b) => b.type === 'checkbox' && b.disabled)).toBe(true);
    expect(boxes.map((b) => b.checked)).toEqual([true, false]);
  });

  it('keeps harmless raw HTML such as details/summary', () => {
    const el = dom('<details><summary>More</summary>\n\nHidden\n\n</details>\n');
    expect(el.querySelector('details > summary')?.textContent).toBe('More');
  });
});

describe('renderMarkdown: links and images', () => {
  it('opens absolute links in a new tab without an opener', () => {
    const a = dom('[site](https://example.com/x) <mailto:me@example.com>').querySelectorAll('a');
    expect(a[0].getAttribute('href')).toBe('https://example.com/x');
    expect(a[0].getAttribute('target')).toBe('_blank');
    expect(a[0].getAttribute('rel')).toBe('noopener noreferrer nofollow');
    expect(a[1].getAttribute('href')).toBe('mailto:me@example.com');
  });

  it('drops the href of relative and fragment links but keeps their text', () => {
    const el = dom('[doc](docs/other.md) [top](#top) [up](../README.md)');
    const links = [...el.querySelectorAll('a')];
    expect(links.map((a) => a.textContent)).toEqual(['doc', 'top', 'up']);
    expect(links.every((a) => !a.hasAttribute('href'))).toBe(true);
    expect(links[0].getAttribute('title')).toContain('docs/other.md');
  });

  it('keeps absolute images and data: images', () => {
    const el = dom('![logo](https://example.com/logo.png) ![dot](data:image/png;base64,iVBORw0KGgo=)');
    const imgs = [...el.querySelectorAll('img')];
    expect(imgs[0].getAttribute('src')).toBe('https://example.com/logo.png');
    expect(imgs[1].getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
  });

  it('does not load relative images and marks them instead', () => {
    const img = dom('![diagram](./img/diagram.png "Arch")').querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.hasAttribute('src')).toBe(false);
    expect(img!.getAttribute('alt')).toBe('diagram');
    expect(img!.classList.contains('rv-md-unresolved')).toBe(true);
    expect(img!.getAttribute('title')).toContain('./img/diagram.png');
  });

  it('drops srcset so relative candidates are never fetched', () => {
    const img = dom('<img src="https://example.com/a.png" srcset="a.png 2x">').querySelector('img');
    expect(img!.hasAttribute('srcset')).toBe(false);
  });
});

describe('renderMarkdown: sanitization of untrusted content', () => {
  const payloads: Array<[string, string]> = [
    ['script tag', '<script>window.__pwned = 1</script>'],
    ['img onerror', '<img src=x onerror="window.__pwned = 1">'],
    ['svg onload', '<svg onload="window.__pwned = 1"><circle r="1"/></svg>'],
    ['iframe', '<iframe src="https://evil.example"></iframe>'],
    ['javascript link (markdown)', '[click](javascript:window.__pwned=1)'],
    ['javascript link (mixed case, entity)', '<a href="JaVaScRiPt&#58;window.__pwned=1">x</a>'],
    ['vbscript link', '<a href="vbscript:msgbox(1)">x</a>'],
    ['data html link', '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)'],
    ['inline event on div', '<div onclick="window.__pwned=1" onmouseover="x()">hover</div>'],
    ['style attribute', '<p style="position:fixed;inset:0">overlay</p>'],
    ['style tag', '<style>body{display:none}</style>'],
    ['form', '<form action="https://evil.example"><button>go</button></form>'],
    ['object/embed', '<object data="x.swf"></object><embed src="x.swf">'],
    ['meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.example">'],
    ['base tag', '<base href="https://evil.example/">'],
    ['text input', '<input type="text" name="password" value="x">'],
    ['javascript image src', '<img src="javascript:window.__pwned=1">'],
  ];

  it.each(payloads)('neutralizes %s', (_name, md) => {
    const html = renderMarkdown(md);
    const el = document.createElement('div');
    el.innerHTML = html;
    expect(el.querySelector('script, iframe, style, form, button, object, embed, meta, base, svg, math')).toBeNull();
    expect(el.querySelector('input:not([type="checkbox"])')).toBeNull();
    for (const node of el.querySelectorAll('*')) {
      for (const attr of node.attributes) {
        expect(attr.name.startsWith('on')).toBe(false);
        expect(attr.name).not.toBe('style');
        expect(attr.value.replace(/\s/g, '').toLowerCase()).not.toMatch(/^(javascript|vbscript):/);
        if (attr.name === 'href' || attr.name === 'src') {
          expect(attr.value).toMatch(/^(https?:|mailto:|data:image\/)/i);
        }
      }
    }
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('prefixes ids and names to prevent DOM clobbering', () => {
    const el = dom('<a id="rvConfig" name="rvSettings">x</a> <a id="location">y</a>');
    const [a, b] = [...el.querySelectorAll('a')];
    expect(a.id).toBe('user-content-rvConfig');
    expect(a.getAttribute('name')).toBe('user-content-rvSettings');
    expect(b.id === '' || b.id.startsWith('user-content-')).toBe(true);
  });

  it('does not leak hooks into the global DOMPurify instance', async () => {
    renderMarkdown('[a](docs/x.md)');
    const { default: DOMPurify } = await import('dompurify');
    const out = DOMPurify.sanitize('<a href="docs/x.md">a</a>');
    expect(out).toBe('<a href="docs/x.md">a</a>');
  });
});
