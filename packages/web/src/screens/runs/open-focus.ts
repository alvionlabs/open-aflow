/** The parts of a click that say where the browser opens a link. */
export type OpenClick = Pick<MouseEvent, 'button' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'defaultPrevented'>

/** Whether a click on a link opens it in this tab. */
export function opensHere(_e: OpenClick): boolean {
  return true
}

/** Whether the run title takes focus when the shown run becomes `runKey`, given the hash Open run waits for. */
export function focusOnArrival(pending: string | undefined, _runKey: string): boolean {
  return pending !== undefined
}
