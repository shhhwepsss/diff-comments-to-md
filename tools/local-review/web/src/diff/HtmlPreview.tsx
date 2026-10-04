import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@primer/react';
import { GlobeIcon, PlayIcon } from '@primer/octicons-react';
import { HEIGHT_MESSAGE, prepareHtml } from './htmlDocument';
import './markdown.css';

// Read-only rendered view of an .html file, in a sandboxed iframe. Loaded with
// React.lazy together with the markdown view.
//
// Two sandboxes, never mixed:
// - no scripts (the default): allow-same-origin only, so the app can measure
//   the page and handle its link clicks; the page itself runs nothing;
// - scripts on: allow-scripts only, an opaque origin with no access to the
//   app; the page reports its height with postMessage (htmlDocument.ts).
// allow-scripts together with allow-same-origin would let the page lift its
// own sandbox, so that pair never happens.

type Props = {
  text: string;
  scripts: boolean;
  onRunScripts: () => void;
  /** Remote resources load only after the reviewer asked for it for this file. */
  loadExternal: boolean;
  onLoadExternal: () => void;
};

const MIN_HEIGHT = 120;

export default function HtmlPreview({ text, scripts, onRunScripts, loadExternal, onLoadExternal }: Props) {
  const { html, externalRefs } = useMemo(() => prepareHtml(text, { scripts, external: loadExternal }), [text, scripts, loadExternal]);
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(MIN_HEIGHT);
  const observer = useRef<ResizeObserver | null>(null);
  useEffect(() => () => observer.current?.disconnect(), []);
  const hasScripts = useMemo(() => /<script[\s>]/i.test(text), [text]);

  // Scripts mode: the page's own frame posts its height.
  useEffect(() => {
    if (!scripts) return;
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      const h = (e.data as Record<string, unknown> | null)?.[HEIGHT_MESSAGE];
      if (typeof h === 'number' && Number.isFinite(h)) setHeight(Math.max(MIN_HEIGHT, Math.ceil(h)));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [scripts]);

  // No-scripts mode: the frame is same-origin, so it is measured from here and
  // its links are handled like in the markdown view: in-page anchors scroll,
  // http(s) links open in a new tab, anything else (relative paths) does nothing.
  const onLoad = () => {
    observer.current?.disconnect();
    observer.current = null;
    if (scripts) return;
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    const measure = () => {
      const h = Math.max(doc.documentElement.getBoundingClientRect().height, doc.body?.scrollHeight ?? 0);
      setHeight(Math.max(MIN_HEIGHT, Math.ceil(h)));
    };
    measure();
    observer.current = new ResizeObserver(measure);
    observer.current.observe(doc.documentElement);
    doc.addEventListener('click', (e) => {
      const a = (e.target as Element | null)?.closest?.('a[href]');
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute('href') ?? '';
      if (href.startsWith('#')) {
        const id = decodeURIComponent(href.slice(1));
        (doc.getElementById(id) ?? doc.getElementsByName(id)[0])?.scrollIntoView({ block: 'start' });
      } else if (/^https?:\/\//i.test(href)) {
        window.open(href, '_blank', 'noopener,noreferrer');
      }
    });
  };

  if (!text.trim()) {
    return <div className="rv-markdown rv-markdown--empty">Файл пуст.</div>;
  }
  const offerScripts = hasScripts && !scripts;
  const offerExternal = externalRefs > 0 && !loadExternal;
  return (
    <>
      {(offerScripts || offerExternal) && (
        <div className="rv-markdown-external">
          {offerScripts && (
            <Button size="small" leadingVisual={PlayIcon} onClick={onRunScripts}>
              Запустить скрипты
            </Button>
          )}
          {offerExternal && (
            <Button size="small" leadingVisual={GlobeIcon} onClick={onLoadExternal}>
              Загрузить внешние ресурсы ({externalRefs})
            </Button>
          )}
          <span className="rv-hint">
            {offerScripts ? 'Скрипты страницы не запускаются сами. ' : ''}
            {offerExternal ? 'Внешние ресурсы не загружаются сами: их сервер увидел бы твой IP.' : ''}
          </span>
        </div>
      )}
      <iframe
        // A new sandbox takes effect only in a new frame.
        key={scripts ? 'scripts' : 'static'}
        ref={frame}
        className="rv-html-frame"
        title="Просмотр HTML"
        sandbox={scripts ? 'allow-scripts' : 'allow-same-origin'}
        referrerPolicy="no-referrer"
        srcDoc={html}
        onLoad={onLoad}
        style={{ height }}
      />
    </>
  );
}
