import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

// Everything is a Primer CSS variable, so switching light/dark re-colors the
// editor without reconfiguring it.

export const githubTheme = EditorView.theme({
  '&': {
    color: 'var(--codeMirror-fgColor, var(--fgColor-default))',
    backgroundColor: 'var(--codeMirror-bgColor, var(--bgColor-default))',
    fontSize: '12px',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--fontStack-monospace)',
    lineHeight: '20px',
  },
  '.cm-content': { padding: '0', caretColor: 'transparent' },
  '.cm-line': { padding: '0 16px 0 22px', position: 'relative' },
  // The +/- sign column, like GitHub's unified diff.
  '.cm-line::before': {
    position: 'absolute',
    left: '8px',
    content: '" "',
    color: 'var(--fgColor-muted)',
    userSelect: 'none',
  },
  '.cm-changedLine::before': { content: '"+"' },
  '.cm-deletedLine': { padding: '0 16px 0 22px', position: 'relative' },
  '.cm-deletedLine::before': {
    position: 'absolute',
    left: '8px',
    content: '"-"',
    color: 'var(--fgColor-muted)',
    userSelect: 'none',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--codeMirror-selection-bgColor, var(--borderColor-accent-muted)) !important',
  },

  // Changed lines (new side) and the deleted block (old side).
  '&.cm-merge-b .cm-changedLine': {
    backgroundColor: 'var(--diffBlob-additionLine-bgColor)',
  },
  '&.cm-merge-b .cm-changedText': {
    background: 'var(--diffBlob-additionWord-bgColor)',
    borderRadius: '2px',
  },
  // Word highlights only make sense where lines were modified, not where a
  // block was purely added or purely removed.
  '&.cm-merge-b .rv-pure-add .cm-changedText': { background: 'none' },
  '.cm-deletedChunk:not(:has(+ .cm-changedLine)) .cm-deletedText': { background: 'none' },
  '.cm-deletedChunk': {
    backgroundColor: 'var(--diffBlob-deletionLine-bgColor)',
    paddingLeft: '0',
  },
  '.cm-deletedChunk .cm-deletedText': {
    background: 'var(--diffBlob-deletionWord-bgColor)',
    borderRadius: '2px',
  },
  '.cm-deletedChunk del': { textDecoration: 'none' },
  // The empty line after a final newline (cm/lastLine.ts).
  '.cm-line.rv-hidden-line, .cm-gutterElement.rv-hidden-line': { display: 'none' },
  '.cm-deletedChunk .cm-chunkButtons': { display: 'none' },

  // Gutters: two number columns.
  '.cm-gutters': {
    backgroundColor: 'var(--codeMirror-gutters-bgColor, var(--bgColor-default))',
    color: 'var(--codeMirror-lineNumber-fgColor, var(--fgColor-muted))',
    border: 'none',
    fontFamily: 'var(--fontStack-monospace)',
    userSelect: 'none',
  },
  '.cm-gutter': { minWidth: '44px' },
  '.cm-gutterElement': {
    padding: '0 10px 0 8px !important',
    textAlign: 'right',
    cursor: 'pointer',
  },
  // The base theme clips every gutter; this one lets the "+" button below
  // hang over the content edge instead of being cut in half.
  '.cm-gutter.cm-lineNumbers': { overflow: 'visible' },
  '.cm-lineNumbers .cm-gutterElement': { position: 'relative' },
  '.cm-gutterElement.rv-gutter-add': {
    backgroundColor: 'var(--diffBlob-additionNum-bgColor)',
    color: 'var(--diffBlob-additionNum-fgColor, var(--fgColor-default))',
  },
  '.cm-gutterElement.rv-gutter-del': {
    backgroundColor: 'var(--diffBlob-deletionNum-bgColor)',
    color: 'var(--diffBlob-deletionNum-fgColor, var(--fgColor-default))',
    cursor: 'default',
  },
  '.rv-deleted-numbers': { display: 'flex', flexDirection: 'column' },
  // GitHub's blue "+" next to the number under the pointer. It straddles the
  // gutter edge and stops short of the +/- sign column (`.cm-line::before`).
  '.cm-lineNumbers .cm-gutterElement:not(.rv-gutter-del):hover::after': {
    content: '"+"',
    position: 'absolute',
    right: '-6px',
    top: '1px',
    width: '18px',
    height: '18px',
    lineHeight: '18px',
    textAlign: 'center',
    borderRadius: '6px',
    color: 'var(--fgColor-onEmphasis)',
    backgroundColor: 'var(--bgColor-accent-emphasis)',
    fontWeight: '600',
    zIndex: '2',
  },
  '.cm-gutterElement.rv-gutter-selected': {
    backgroundColor: 'var(--bgColor-attention-muted) !important',
  },
  '.rv-line-selected': {
    backgroundColor: 'var(--bgColor-attention-muted) !important',
  },

  // Folded unchanged lines.
  '.rv-fold': {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    height: '32px',
    padding: '0 12px',
    color: 'var(--diffBlob-hunkLine-fgColor, var(--fgColor-muted))',
    backgroundColor: 'var(--diffBlob-hunkLine-bgColor, var(--bgColor-accent-muted))',
    fontFamily: 'var(--fontStack-sansSerif)',
    cursor: 'pointer',
  },
  '.rv-fold:hover .rv-fold__button': {
    color: 'var(--diffBlob-hunkNum-fgColor-hover, var(--fgColor-onEmphasis))',
    backgroundColor: 'var(--diffBlob-hunkNum-bgColor-hover, var(--bgColor-accent-emphasis))',
  },
  '.rv-fold__button': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '28px',
    height: '24px',
    border: 'none',
    borderRadius: '6px',
    color: 'var(--diffBlob-expander-iconColor, var(--fgColor-muted))',
    background: 'transparent',
    cursor: 'pointer',
  },
  '.rv-fold__label': { fontSize: '12px' },

  // Comment cards inside the document.
  '.rv-block': {
    padding: '8px 16px 8px 16px',
    backgroundColor: 'var(--bgColor-default)',
    borderTop: 'var(--borderWidth-thin) solid var(--borderColor-muted)',
    borderBottom: 'var(--borderWidth-thin) solid var(--borderColor-muted)',
    fontFamily: 'var(--fontStack-sansSerif)',
    whiteSpace: 'normal',
    cursor: 'auto',
  },
});

export const githubHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--codeMirror-syntax-fgColor-comment)' },
    {
      tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.self],
      color: 'var(--codeMirror-syntax-fgColor-keyword)',
    },
    { tag: [t.string, t.special(t.string), t.regexp, t.character], color: 'var(--codeMirror-syntax-fgColor-string)' },
    {
      tag: [t.number, t.bool, t.null, t.atom, t.constant(t.variableName), t.definition(t.propertyName), t.attributeName, t.unit],
      color: 'var(--codeMirror-syntax-fgColor-constant)',
    },
    {
      tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName)), t.tagName, t.macroName],
      color: 'var(--codeMirror-syntax-fgColor-entity)',
    },
    { tag: [t.typeName, t.className, t.namespace, t.labelName], color: 'var(--codeMirror-syntax-fgColor-variable)' },
    { tag: [t.definition(t.variableName)], color: 'var(--codeMirror-syntax-fgColor-constant)' },
    { tag: [t.meta, t.processingInstruction, t.annotation], color: 'var(--codeMirror-syntax-fgColor-support)' },
    { tag: t.heading, fontWeight: '600', color: 'var(--codeMirror-syntax-fgColor-constant)' },
    { tag: t.strong, fontWeight: '600' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.link, textDecoration: 'underline' },
    { tag: t.invalid, color: 'var(--fgColor-danger)' },
  ]),
);
