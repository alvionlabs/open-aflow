/** The parts of a click that say where the browser opens a link. */
export type OpenClick = Pick<MouseEvent, 'button' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'defaultPrevented'>

/**
 * Whether a click on a link opens it in this tab: a primary click with no modifier that no
 * handler prevented. Ctrl, Meta, Shift, Alt and middle clicks open a new tab or window, or save.
 */
export function opensHere(e: OpenClick): boolean {
  return e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && !e.defaultPrevented
}

/**
 * Whether the run title takes focus when the shown run becomes `runKey`, given the hash Open run
 * waits for. Only that run: a run opened another way (sidebar, Back) keeps focus where it is.
 */
export function focusOnArrival(pending: string | undefined, runKey: string): boolean {
  return pending !== undefined && pending === runKey
}
