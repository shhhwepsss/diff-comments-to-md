// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMarkdown, type RenderOptions } from './renderMarkdown';

function dom(md: string, opts?: RenderOptions): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = renderMarkdown(md, opts).html;
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

describe('renderMarkdown: links', () => {
  it('opens absolute links in a new tab without an opener', () => {
    const a = dom('[site](https://example.com/x) <mailto:me@example.com>').querySelectorAll('a');
    expect(a[0].getAttribute('href')).toBe('https://example.com/x');
    expect(a[0].getAttribute('target')).toBe('_blank');
    expect(a[0].getAttribute('rel')).toBe('noopener noreferrer nofollow');
    expect(a[1].getAttribute('href')).toBe('mailto:me@example.com');
  });

  it('drops the href of relative, protocol-relative and fragment links but keeps their text', () => {
    const el = dom('[doc](docs/other.md) [top](#top) [up](../README.md) [cdn](//evil.example/x)');
    const links = [...el.querySelectorAll('a')];
    expect(links.map((a) => a.textContent)).toEqual(['doc', 'top', 'up', 'cdn']);
    expect(links.every((a) => !a.hasAttribute('href'))).toBe(true);
    expect(links[0].getAttribute('title')).toContain('docs/other.md');
  });
});

describe('renderMarkdown: images', () => {
  it('keeps data: images loadable', () => {
    const r = renderMarkdown('![dot](data:image/png;base64,iVBORw0KGgo=)');
    const el = document.createElement('div');
    el.innerHTML = r.html;
    expect(el.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(r.externalImages).toBe(0);
  });

  it('replaces remote images with a text placeholder by default and counts them', () => {
    const r = renderMarkdown('![logo](https://example.com/logo.png) and <img src="http://example.com/b.gif">');
    expect(r.externalImages).toBe(2);
    const el = document.createElement('div');
    el.innerHTML = r.html;
    expect(el.querySelector('img')).toBeNull();
    const boxes = [...el.querySelectorAll('.rv-md-image--external')];
    expect(boxes).toHaveLength(2);
    expect(boxes[0].querySelector('.rv-md-image__alt')?.textContent).toBe('logo');
    expect(boxes[0].querySelector('.rv-md-image__url')?.textContent).toBe('https://example.com/logo.png');
    expect(boxes[1].querySelector('.rv-md-image__alt')).toBeNull();
    expect(boxes[1].querySelector('.rv-md-image__url')?.textContent).toBe('http://example.com/b.gif');
  });

  it('loads remote images only when asked, without a referrer', () => {
    const r = renderMarkdown('![logo](https://example.com/logo.png)', { loadExternalImages: true });
    expect(r.externalImages).toBe(1);
    const el = document.createElement('div');
    el.innerHTML = r.html;
    const img = el.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('https://example.com/logo.png');
    expect(img.getAttribute('alt')).toBe('logo');
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(el.querySelector('.rv-md-image')).toBeNull();
  });

  it('keeps a remote image inside a link as a placeholder inside that link', () => {
    const el = dom('[![build](https://ci.example/badge.svg)](https://ci.example/)');
    expect(el.querySelector('a > .rv-md-image--external .rv-md-image__url')?.textContent).toBe('https://ci.example/badge.svg');
  });

  it('shows relative images as placeholders in both modes', () => {
    for (const loadExternalImages of [false, true]) {
      const r = renderMarkdown('![diagram](./img/diagram.png "Arch")', { loadExternalImages });
      expect(r.externalImages).toBe(0);
      const el = document.createElement('div');
      el.innerHTML = r.html;
      expect(el.querySelector('img')).toBeNull();
      const box = el.querySelector('.rv-md-image--relative');
      expect(box?.querySelector('.rv-md-image__alt')?.textContent).toBe('diagram');
      expect(box?.querySelector('.rv-md-image__url')?.textContent).toBe('./img/diagram.png');
    }
  });

  it('does not trust a data-rv-* attribute supplied by the markdown', () => {
    const r = renderMarkdown('<img data-rv-remote-src="https://evil.example/x.png" alt="x">', { loadExternalImages: true });
    expect(r.externalImages).toBe(0);
    expect(r.html).not.toContain('evil.example');
  });
});

// Every payload points at evil.example. Before the reviewer opts in, that host
// may only appear as text: never in an attribute (a[href] is not a fetch, so it
// is the one exception). After opting in, only <img src> may carry it.
const NETWORK_PAYLOADS: Array<[string, string]> = [
  ['markdown image', '![x](https://evil.example/a.png)'],
  ['reference image', '![x][ref]\n\n[ref]: https://evil.example/ref.png'],
  ['raw img', '<img src="https://evil.example/b.png">'],
  ['protocol-relative img', '<img src="//evil.example/c.png">'],
  ['img srcset', '<img src="data:image/png;base64,AA==" srcset="https://evil.example/d.png 2x">'],
  ['img lowsrc/dynsrc', '<img lowsrc="https://evil.example/e.png" dynsrc="https://evil.example/f.avi">'],
  ['picture/source', '<picture><source srcset="https://evil.example/g.webp"><img alt="g"></picture>'],
  ['video poster/src', '<video poster="https://evil.example/h.png" src="https://evil.example/h.mp4"></video>'],
  ['video source', '<video><source src="https://evil.example/i.mp4"></video>'],
  ['audio', '<audio src="https://evil.example/j.mp3" autoplay></audio>'],
  ['track', '<video><track src="https://evil.example/k.vtt"></video>'],
  ['link stylesheet', '<link rel="stylesheet" href="https://evil.example/l.css">'],
  ['link prefetch', '<link rel="prefetch" href="https://evil.example/l2">'],
  ['style tag url', '<style>p{background:url(https://evil.example/m.png)} @import "https://evil.example/m.css";</style>'],
  ['style attribute url', '<p style="background-image:url(https://evil.example/n.png)">x</p>'],
  ['table background', '<table background="https://evil.example/o.png"><tr><td background="https://evil.example/o2.png">x</td></tr></table>'],
  ['input type=image', '<input type="image" src="https://evil.example/p.png">'],
  ['checkbox with src', '<input type="checkbox" src="https://evil.example/p2.png">'],
  ['href on a non-link', '<span href="https://evil.example/p3">x</span>'],
  ['object', '<object data="https://evil.example/q.swf"></object>'],
  ['embed', '<embed src="https://evil.example/r.swf">'],
  ['iframe', '<iframe src="https://evil.example/s"></iframe>'],
  ['frame', '<frameset><frame src="https://evil.example/s2"></frameset>'],
  ['svg image', '<svg><image href="https://evil.example/t.png"/><use href="https://evil.example/t.svg#a"/></svg>'],
  ['math href', '<math href="https://evil.example/u"><mi>x</mi></math>'],
  ['a ping', '<a href="https://ok.example/" ping="https://evil.example/v">x</a>'],
  ['form action', '<form action="https://evil.example/w"><button formaction="https://evil.example/w2">go</button></form>'],
  ['meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.example/x">'],
  ['base', '<base href="https://evil.example/">'],
  ['body background', '<body background="https://evil.example/y.png">x</body>'],
  ['blockquote cite', '<blockquote cite="https://evil.example/z">q</blockquote>'],
  ['data attribute', '<div data-src="https://evil.example/aa.png">x</div>'],
  ['area href', '<map name="m"><area href="https://evil.example/bb"></map>'],
  ['portal', '<portal src="https://evil.example/cc"></portal>'],
];

function attributesWith(el: HTMLElement, needle: string): string[] {
  const hits: string[] = [];
  for (const node of el.querySelectorAll('*')) {
    for (const attr of node.attributes) {
      if (attr.value.includes(needle)) hits.push(`${node.tagName.toLowerCase()}[${attr.name}]`);
    }
  }
  return hits;
}

describe('renderMarkdown: no network requests before opt-in', () => {
  it.each(NETWORK_PAYLOADS)('%s: no loadable remote URL by default', (_name, md) => {
    const el = dom(md);
    expect(attributesWith(el, 'evil.example').filter((h) => h !== 'a[href]')).toEqual([]);
    expect(el.querySelector('picture, source, video, audio, track, link, style, iframe, frame, object, embed, svg, math, form, button, meta, base, portal, area')).toBeNull();
    expect(el.querySelector('[style], [srcset], [poster], [background], [ping], [action], [formaction], [lowsrc], [dynsrc]')).toBeNull();
  });

  it.each(NETWORK_PAYLOADS)('%s: after opt-in only <img src> is loadable', (_name, md) => {
    const el = dom(md, { loadExternalImages: true });
    expect(attributesWith(el, 'evil.example').filter((h) => h !== 'a[href]' && h !== 'img[src]')).toEqual([]);
    for (const img of el.querySelectorAll('img[src]')) {
      expect(img.getAttribute('src')).toMatch(/^(https?:\/\/|data:image\/)/);
    }
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
    for (const loadExternalImages of [false, true]) {
      const el = dom(md, { loadExternalImages });
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
