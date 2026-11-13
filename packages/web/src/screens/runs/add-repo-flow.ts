// Add repo, with no DOM: AddRepoDialog.tsx only wires it.
//
// With the desktop bridge, the Windows folder dialog opens at once and no modal shows while it is up. Cancel
// closes; a folder posts at once, and a 201 closes. A refused post opens the modal with the error, the path,
// and Choose folder… (the dialog again). A dialog that can't open opens the modal and asks for a typed path.
// With no bridge (the browser build), the modal opens with an empty path field.
//
// Add is off while the modal shows a path error (already added, or not a folder); a change to the path clears
// it. After any other error, Add stays on, so the same path can be tried again.
//
// The modal is busy while a post or a dialog is out: Add, Choose folder…, and Cancel then do nothing, so one
// post runs at a time. After close, nothing more happens, and a late answer is dropped.

import { UNREACHABLE } from '../../actions-client.ts'
import { addError, type AddResult } from '../../add-repo.ts'
import type { PickFolder } from '../../desktop-bridge.ts'

export const BRIDGE_FAILED = "Couldn't open the folder dialog. Type the path instead."

/** The path field's example, in the form of the user's own system. The app and the browser run on one machine. */
export function pathHint(userAgent: string): string {
  if (/Windows/.test(userAgent)) return 'C:\\code\\my-repo'
  if (/Macintosh|Mac OS X/.test(userAgent)) return '/Users/you/code/my-repo'
  return '/home/you/code/my-repo'
}

export type AddRepoState =
  /** The folder dialog is up, or its folder is posting: no modal. */
  | { kind: 'picking' }
  /** The modal. `path` is the field as typed; `canChoose` shows Choose folder…. */
  | { kind: 'form'; path: string; busy: boolean; canChoose: boolean; error?: string; pathError?: boolean }
  | { kind: 'closed' }

export type AddRepoDeps = {
  /** The desktop folder dialog (`folderBridge()`); none in the browser build. */
  pick?: PickFolder | undefined
  post: (path: string) => Promise<AddResult>
  onClose: () => void
}

/** Add is on in an idle modal whose path isn't blank and that shows no path error. Typing clears the error. */
export function canAdd(s: AddRepoState): boolean {
  return s.kind === 'form' && !s.busy && !(s.error && s.pathError) && s.path.trim() !== ''
}

export type AddRepoFlow = ReturnType<typeof createAddRepoFlow>

export function createAddRepoFlow(deps: AddRepoDeps, onChange: (s: AddRepoState) => void) {
  const { pick } = deps
  let state: AddRepoState = pick ? { kind: 'picking' } : { kind: 'form', path: '', busy: false, canChoose: false }
  let started = false

  const set = (next: AddRepoState) => {
    if (state.kind === 'closed') return
    state = next
    onChange(state)
  }
  const close = () => {
    if (state.kind === 'closed') return
    set({ kind: 'closed' })
    deps.onClose()
  }
  /** The modal, keeping what isn't given. */
  const showForm = (patch: { path?: string; busy: boolean; error?: string | undefined; pathError?: boolean | undefined }) => {
    const path = patch.path ?? (state.kind === 'form' ? state.path : '')
    const next: AddRepoState = { kind: 'form', path, busy: patch.busy, canChoose: pick !== undefined }
    if (patch.error !== undefined) next.error = patch.error
    if (patch.error !== undefined && patch.pathError) next.pathError = true
    set(next)
  }

  /** Posts `path`; 201 closes, else the modal shows the error with `shown` in the field. */
  const post = async (path: string, shown: string) => {
    let result: AddResult
    try {
      result = await deps.post(path)
    } catch {
      result = { status: 0, error: UNREACHABLE }
    }
    if (state.kind === 'closed') return
    if (result.status === 201) close()
    else {
      const e = addError(result)
      showForm({ path: shown, busy: false, error: e.message, pathError: e.pathError })
    }
  }

  /** Opens the folder dialog; `onCancel` runs on cancel, `onFail` on a rejection. A folder posts at once. */
  const runPick = async (onCancel: () => void) => {
    let chosen: string | null
    try {
      chosen = await pick!()
    } catch {
      if (state.kind !== 'closed') showForm({ busy: false, error: BRIDGE_FAILED })
      return
    }
    if (state.kind === 'closed') return
    if (typeof chosen !== 'string' || chosen === '') return onCancel()
    if (state.kind === 'form') showForm({ path: chosen, busy: true })
    await post(chosen, chosen)
  }

  const busy = () => state.kind === 'picking' || (state.kind === 'form' && state.busy)

  return {
    state: () => state,
    /** Opens the folder dialog when there is a bridge. Once only: React's StrictMode runs effects twice. */
    start() {
      if (started || !pick || state.kind !== 'picking') return
      started = true
      void runPick(close)
    },
    type(text: string) {
      if (state.kind !== 'form' || state.busy) return
      set({ kind: 'form', path: text, busy: false, canChoose: state.canChoose })
    },
    async add() {
      if (!canAdd(state) || state.kind !== 'form') return
      const shown = state.path
      showForm({ busy: true })
      await post(shown.trim(), shown)
    },
    /** Choose folder…: the dialog again. Cancel there keeps the modal as it was. */
    choose() {
      if (!pick || state.kind !== 'form' || state.busy) return
      const before = state
      showForm({ busy: true, error: before.error, pathError: before.pathError })
      void runPick(() => set(before))
    },
    cancel() {
      if (busy()) return
      close()
    },
  }
}
