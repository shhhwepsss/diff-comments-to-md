// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { hasRemoteReference, mermaidErrorText, renderMermaidBlocks, svgImageUrl } from './mermaidBlocks';

// The real mermaid needs a browser to lay a diagram out, so these tests feed
// renderMermaidBlocks a fake `draw` and only check what ends up in the DOM.

const IMAGE = 'data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E';

function root(...sources: string[]): HTMLElement {
  const el = document.createElement('div');
  for (const source of sources) {
    const code = document.createElement('code');
    code.className = 'language-mermaid';
    code.textContent = source;
    const pre = document.createElement('pre');
    pre.append(code);
    const box = document.createElement('div');
    box.className = 'rv-mermaid';
    box.append(pre);
    el.append(box);
  }
  return el;
}

const never = () => false;

describe('renderMermaidBlocks', () => {
  it('shows the diagram as an image and hides the source', async () => {
    const el = root('erDiagram\n  A ||--o{ B : has\n');
    const draw = vi.fn(async () => IMAGE);
    await renderMermaidBlocks(el, draw, never);
    expect(draw).toHaveBeenCalledWith('erDiagram\n  A ||--o{ B : has\n');
    const box = el.querySelector('.rv-mermaid')!;
    expect(box.classList.contains('rv-mermaid--rendered')).toBe(true);
    const img = box.querySelector('img.rv-mermaid__diagram')!;
    expect(img.getAttribute('src')).toBe(IMAGE);
    expect(img.getAttribute('alt')).toBe('Диаграмма mermaid');
    expect(box.querySelector('pre')).not.toBeNull();
    expect(box.querySelector('.rv-mermaid__error')).toBeNull();
  });

  it('keeps the source and adds an error line when a block cannot be drawn', async () => {
    const el = root('erDiagram\n  A ||--o{\n', 'graph TD; A-->B');
    const draw = vi.fn(async (source: string) => {
      if (source.startsWith('erDiagram')) throw new Error('Parse error on line 2:\n...A ||--o{\n-----^');
      return IMAGE;
    });
    await renderMermaidBlocks(el, draw, never);
    const [bad, good] = [...el.querySelectorAll('.rv-mermaid')];
    expect(bad.classList.contains('rv-mermaid--rendered')).toBe(false);
    expect(bad.querySelector('img')).toBeNull();
    expect(bad.querySelector('pre > code')?.textContent).toBe('erDiagram\n  A ||--o{\n');
    expect(bad.querySelector('.rv-mermaid__error')?.textContent).toBe('Не удалось отрисовать диаграмму mermaid: Parse error on line 2:');
    expect(good.querySelector('img')?.getAttribute('src')).toBe(IMAGE);
  });

  it('writes the error message as text', async () => {
    const el = root('x');
    await renderMermaidBlocks(el, async () => Promise.reject(new Error('<img src=x onerror=alert(1)>')), never);
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('.rv-mermaid__error')?.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('refuses anything that is not an inline SVG image', async () => {
    for (const url of ['https://evil.example/x.svg', 'javascript:alert(1)', 'data:text/html,<script>1</script>', '<svg></svg>']) {
      const el = root('x');
      await renderMermaidBlocks(el, async () => url, never);
      expect(el.querySelector('img')).toBeNull();
      expect(el.querySelector('.rv-mermaid__error')).not.toBeNull();
    }
  });

  it('does not hand a source with a remote address to mermaid', async () => {
    const el = root('flowchart LR\n  X@{ img: "https://evil.example/x.png" }\n', 'erDiagram\n  A ||--o{ B : has\n');
    const draw = vi.fn(async () => IMAGE);
    await renderMermaidBlocks(el, draw, never);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(draw).toHaveBeenCalledWith('erDiagram\n  A ||--o{ B : has\n');
    const [remote, local] = [...el.querySelectorAll('.rv-mermaid')];
    expect(remote.querySelector('img')).toBeNull();
    expect(remote.classList.contains('rv-mermaid--rendered')).toBe(false);
    expect(remote.querySelector('.rv-mermaid__error')?.textContent).toBe(
      'Диаграмма не отрисована: в ней есть внешний адрес, а просмотр ничего не загружает из сети.',
    );
    expect(local.querySelector('img')).not.toBeNull();
  });

  it('replaces the previous result on a second pass', async () => {
    const el = root('x');
    await renderMermaidBlocks(el, async () => Promise.reject(new Error('boom')), never);
    await renderMermaidBlocks(el, async () => IMAGE, never);
    const box = el.querySelector('.rv-mermaid')!;
    expect(box.querySelectorAll('img')).toHaveLength(1);
    expect(box.querySelector('.rv-mermaid__error')).toBeNull();
    expect(box.classList.contains('rv-mermaid--rendered')).toBe(true);

    await renderMermaidBlocks(el, async () => Promise.reject(new Error('boom')), never);
    expect(box.querySelector('img')).toBeNull();
    expect(box.querySelectorAll('.rv-mermaid__error')).toHaveLength(1);
    expect(box.classList.contains('rv-mermaid--rendered')).toBe(false);
  });

  it('leaves the DOM alone once the pass is stale', async () => {
    const el = root('x', 'y');
    let stale = false;
    const draw = vi.fn(async () => {
      stale = true;
      return IMAGE;
    });
    await renderMermaidBlocks(el, draw, () => stale);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('.rv-mermaid--rendered')).toBeNull();
  });

  it('skips a wrapper without a code block', async () => {
    const el = document.createElement('div');
    el.innerHTML = '<div class="rv-mermaid">forged</div>';
    const draw = vi.fn(async () => IMAGE);
    await renderMermaidBlocks(el, draw, never);
    expect(draw).not.toHaveBeenCalled();
    expect(el.innerHTML).toBe('<div class="rv-mermaid">forged</div>');
  });
});

describe('hasRemoteReference', () => {
  it.each([
    ['image shape', 'flowchart LR\n  X@{ img: "https://evil.example/x.png" }'],
    ['http', 'flowchart LR\n  X@{ img: "http://evil.example/x.png" }'],
    ['upper case scheme', 'flowchart LR\n  X@{ img: "HTTPS://evil.example/x.png" }'],
    ['protocol-relative', 'flowchart LR\n  X@{ img: "//evil.example/x.png" }'],
    ['backslashes', 'flowchart LR\n  X@{ img: "\\\\evil.example\\x.png" }'],
    ['scheme without slashes', 'flowchart LR\n  X@{ img: "https:evil.example/x.png" }'],
    ['scheme with one slash', 'flowchart LR\n  X@{ img: "https:/evil.example/x.png" }'],
    ['scheme split by a tab', 'flowchart LR\n  X@{ img: "ht\ttps://evil.example/x.png" }'],
    ['mermaid numeric entities', 'flowchart LR\n  X@{ img: "https#58;#47;#47;evil.example/x.png" }'],
    ['mermaid hex and named entities', 'flowchart LR\n  X@{ img: "https#colon;#x2f;#sol;evil.example/x.png" }'],
    ['css url', 'flowchart LR\n  A-->B\n  style B fill:url(https://evil.example/s.png)'],
    ['link in a label', 'flowchart LR\n  A["see https://example.com/docs"]'],
    ['websocket and ftp', 'flowchart LR\n  A["wss://evil.example"] --> B["ftp://evil.example"]'],
  ])('%s', (_name, source) => {
    expect(hasRemoteReference(source)).toBe(true);
  });

  it.each([
    ['erDiagram', 'erDiagram\n    CUSTOMER ||--o{ ORDER : places\n    CUSTOMER {\n        string email PK "user: a/b"\n    }'],
    ['flowchart', 'flowchart LR\n    A[Start] --> B{Choice}\n    B -->|yes| C[Done]'],
    ['sequence', 'sequenceDiagram\n    Alice->>Bob: Hello\n    Bob-->>Alice: Hi #35;1'],
    ['comment', '%% a note\ngraph TD; A-->B'],
    ['words that only look like a scheme', 'flowchart LR\n  A["https is on"] --> B["path a/b/c, ratio 1:2"]'],
  ])('%s is local', (_name, source) => {
    expect(hasRemoteReference(source)).toBe(false);
  });
});

describe('mermaidErrorText', () => {
  it('keeps the first line of the reason', () => {
    expect(mermaidErrorText(new Error('Parse error on line 3:\nmore'))).toBe('Не удалось отрисовать диаграмму mermaid: Parse error on line 3:');
  });

  it('works without a usable reason', () => {
    expect(mermaidErrorText(undefined)).toBe('Не удалось отрисовать диаграмму mermaid.');
    expect(mermaidErrorText(new Error('  '))).toBe('Не удалось отрисовать диаграмму mermaid.');
    expect(mermaidErrorText('plain')).toBe('Не удалось отрисовать диаграмму mermaid: plain');
  });

  it('cuts a very long reason', () => {
    const text = mermaidErrorText(new Error('x'.repeat(1000)));
    expect(text.length).toBeLessThan(300);
    expect(text.endsWith('…')).toBe(true);
  });
});

describe('svgImageUrl', () => {
  const SVG = '<svg id="m1" width="100%" xmlns="http://www.w3.org/2000/svg" style="max-width: 320.5px;" viewBox="0 0 320.5 120"><g><text>CUSTOMER</text></g></svg>';

  function decode(url: string): Element {
    expect(url.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
    const xml = decodeURIComponent(url.slice(url.indexOf(',') + 1));
    return new DOMParser().parseFromString(xml, 'image/svg+xml').documentElement;
  }

  it('gives the image its own size, taken from the viewBox', () => {
    const svg = decode(svgImageUrl(SVG));
    expect(svg.tagName).toBe('svg');
    expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(svg.getAttribute('width')).toBe('320.5');
    expect(svg.getAttribute('height')).toBe('120');
    expect(svg.getAttribute('style') ?? '').not.toContain('max-width');
    expect(svg.querySelector('text')?.textContent).toBe('CUSTOMER');
  });

  it('produces well-formed XML from HTML-serialized markup', () => {
    // No xmlns and an HTML-only entity: fine for innerHTML, not for an XML parser.
    const svg = decode(svgImageUrl('<svg viewBox="0 0 10 10"><text>a&nbsp;b &amp; c</text></svg>'));
    expect(svg.querySelector('parsererror')).toBeNull();
    expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(svg.textContent).toBe('a b & c');
  });

  it('throws when there is no svg', () => {
    expect(() => svgImageUrl('<p>nope</p>')).toThrow();
    expect(() => svgImageUrl('')).toThrow();
  });
});
