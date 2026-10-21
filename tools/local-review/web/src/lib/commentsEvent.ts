/**
 * Comments of the open PR were changed behind the review's back (a review
 * session's cleanup deleted the ones left by an earlier session). The review
 * listens and reads them again; the session does not know the review exists.
 */
export const COMMENTS_CHANGED_EVENT = 'local-review:comments-changed';

export function announceCommentsChanged(): void {
  window.dispatchEvent(new Event(COMMENTS_CHANGED_EVENT));
}
