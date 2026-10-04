// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, HEIGHT_MESSAGE, prepareHtml } from './htmlDocument';

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

function csp(doc: Document): string | null {
  return doc.head.firstElementChild?.getAttribute('http-equiv') === 'Content-Security-Policy'
    ? doc.head.firstElementChild.getAttribute('content')
    : null;
}

describe('prepareHtml', () => {
  it('puts the policy first in <head> and keeps the page', () => {
    const doc = parse(prepareHtml('<!doctype html><html lang="ru"><head><title>T</title></head><body><h1>Hi</h1></body></html>').html);
    expect(csp(doc)).toBe(contentSecurityPolicy({}));
    expect(doc.title).toBe('T');
    expect(doc.documentElement.lang).toBe('ru');
    expect(doc.querySelector('h1')?.textContent).toBe('Hi');
  });

  it('keeps the doctype as the file had it', () => {
    expect(prepareHtml('<!DOCTYPE html><p>x</p>').html).toMatch(/^<!DOCTYPE html>/);
    expect(prepareHtml('<p>quirks</p>').html).toMatch(/^<html>/);
    expect(
      prepareHtml('<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd"><p>x</p>').html,
    ).toMatch(/^<!DOCTYPE html PUBLIC "-\/\/W3C\/\/DTD HTML 4.01\/\/EN" "http:\/\/www.w3.org\/TR\/html4\/strict.dtd">/);
  });

  it('adds a head to a fragment', () => {
    const doc = parse(prepareHtml('<div>fragment</div>').html);
    expect(csp(doc)).not.toBeNull();
    expect(doc.body.textContent).toBe('fragment');
  });

  it('drops meta refresh, which would navigate the frame away', () => {
    const doc = parse(prepareHtml('<head><meta http-equiv=" Refresh " content="0; url=https://evil.example"></head><p>x</p>').html);
    expect(doc.querySelector('meta[http-equiv~="Refresh" i]')).toBeNull();
    expect(doc.querySelectorAll('meta[http-equiv]')).toHaveLength(1);
  });

  it('injects the height reporter only when scripts run', () => {
    expect(prepareHtml('<p>x</p>').html).not.toContain(HEIGHT_MESSAGE);
    const doc = parse(prepareHtml('<p>x</p>', { scripts: true }).html);
    expect(doc.head.children[1]?.tagName).toBe('SCRIPT');
    expect(doc.head.children[1]?.textContent).toContain(HEIGHT_MESSAGE);
  });

  it('counts remote resources', () => {
    const page = `
      <link rel="stylesheet" href="https://cdn.example/a.css">
      <link rel="icon" href="favicon.ico">
      <style>body { background: url("https://x.example/bg.png") } .a { background: url(local.png) }</style>
      <img src="//img.example/a.png"><img src="a.png"><img src="data:image/png;base64,AA==">
      <img srcset="a.png 1x, https://img.example/b.png 2x">
      <script src="http://cdn.example/x.js"></script>
      <div style="background-image:url(https://x.example/y.png)"></div>`;
    expect(prepareHtml(page).externalRefs).toBe(6);
    expect(prepareHtml('<img src="a.png"><a href="https://link.example">link</a>').externalRefs).toBe(0);
  });
});

describe('contentSecurityPolicy', () => {
  const directive = (policy: string, name: string) => policy.split('; ').find((d) => d.startsWith(name + ' '));

  it('loads nothing remote and runs nothing by default', () => {
    const p = contentSecurityPolicy({});
    expect(p).toContain("default-src 'none'");
    expect(directive(p, 'script-src')).toBe("script-src 'none'");
    expect(directive(p, 'connect-src')).toBe("connect-src 'none'");
    expect(p).not.toContain('https:');
  });

  it('runs inline scripts, still with no network', () => {
    const p = contentSecurityPolicy({ scripts: true });
    expect(directive(p, 'script-src')).toBe("script-src 'unsafe-inline'");
    expect(directive(p, 'connect-src')).toBe("connect-src 'none'");
    expect(p).not.toContain('https:');
  });

  it('opens remote resources on request', () => {
    const p = contentSecurityPolicy({ external: true });
    expect(directive(p, 'img-src')).toContain('https:');
    expect(directive(p, 'style-src')).toContain('https:');
    expect(directive(p, 'script-src')).toBe("script-src 'none'");
    const both = contentSecurityPolicy({ scripts: true, external: true });
    expect(directive(both, 'script-src')).toContain('https:');
    expect(directive(both, 'connect-src')).toContain('https:');
  });
});
