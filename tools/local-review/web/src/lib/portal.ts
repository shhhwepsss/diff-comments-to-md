/**
 * True while a Primer dialog or side sheet is open: its keys are its own, so
 * no global shortcut may act while it is up.
 */
export function portalOpen(): boolean {
  return Boolean(document.getElementById('__primerPortalRoot__')?.childElementCount);
}
