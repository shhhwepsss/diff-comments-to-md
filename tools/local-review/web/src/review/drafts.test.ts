import { describe, expect, it } from 'vitest';
import { createDraftStore, editDraftKey, NEW_GENERAL_DRAFT } from './drafts';

describe('createDraftStore', () => {
  it('returns undefined for a key that was never typed into', () => {
    expect(createDraftStore().get(NEW_GENERAL_DRAFT)).toBeUndefined();
  });

  it('keeps the latest text per key until it is cleared', () => {
    const drafts = createDraftStore();
    drafts.set(NEW_GENERAL_DRAFT, 'нач');
    drafts.set(NEW_GENERAL_DRAFT, 'начало мысли');
    drafts.set(editDraftKey('a'), 'правка a');
    expect(drafts.get(NEW_GENERAL_DRAFT)).toBe('начало мысли');
    expect(drafts.get(editDraftKey('a'))).toBe('правка a');

    drafts.clear(NEW_GENERAL_DRAFT);
    expect(drafts.get(NEW_GENERAL_DRAFT)).toBeUndefined();
    expect(drafts.get(editDraftKey('a'))).toBe('правка a');
  });

  it('keeps an emptied edit as an empty string, not as "no draft"', () => {
    // Otherwise reopening would silently bring back the saved text.
    const drafts = createDraftStore();
    drafts.set(editDraftKey('a'), '');
    expect(drafts.get(editDraftKey('a'))).toBe('');
  });

  it('gives every review its own drafts', () => {
    const one = createDraftStore();
    const two = createDraftStore();
    one.set(NEW_GENERAL_DRAFT, 'только в первом');
    expect(two.get(NEW_GENERAL_DRAFT)).toBeUndefined();
  });

  it('does not mix up the new-comment draft with edit drafts', () => {
    expect(editDraftKey('new')).not.toBe(NEW_GENERAL_DRAFT);
    expect(editDraftKey('a')).not.toBe(editDraftKey('b'));
  });
});
