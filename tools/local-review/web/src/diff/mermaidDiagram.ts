import mermaid from 'mermaid';
import { svgImageUrl } from './mermaidBlocks';

// The only module that imports mermaid. MarkdownPreview loads it with a
// dynamic import, and only for a document that has a mermaid block, so the
// library (and the per-diagram chunks it splits into) is fetched from the
// review server on demand and never from a CDN.
//
// The source comes from the diff, so it is untrusted:
// - securityLevel 'strict' makes mermaid encode HTML in labels, ignore click
//   handlers and pass the finished SVG through its own DOMPurify;
// - htmlLabels off keeps labels as SVG <text>, with no HTML inside the diagram;
// - `secure` stops a %%{init}%% directive or frontmatter in the source from
//   changing any of this.
// The SVG then leaves here as an image URL, see mermaidBlocks.ts.

const SECURE_KEYS = [
  'secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges',
  'htmlLabels', 'dompurifyConfig', 'themeCSS', 'fontFamily', 'altFontFamily',
];

let configuredDark: boolean | null = null;
let nextId = 0;

function configure(dark: boolean) {
  if (configuredDark === dark) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    secure: SECURE_KEYS,
    htmlLabels: false,
    // A failed diagram throws; without this mermaid would also draw its own
    // "Syntax error" picture into the page.
    suppressErrorRendering: true,
    theme: dark ? 'dark' : 'default',
  });
  configuredDark = dark;
}

export async function drawMermaid(source: string, dark: boolean): Promise<string> {
  configure(dark);
  const id = `rv-mermaid-${nextId++}`;
  try {
    const { svg } = await mermaid.render(id, source);
    return svgImageUrl(svg);
  } finally {
    // mermaid lays the diagram out in a temporary node under <body>; make sure
    // a failure does not leave it there.
    document.getElementById(`d${id}`)?.remove();
    document.getElementById(id)?.remove();
  }
}
