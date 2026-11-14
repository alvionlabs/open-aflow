import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../../theme/icons.tsx'
import { TOGGLE_INITIAL, createToggleFlow, toggleView, type RunTarget, type ToggleState, type ToggleView } from './resume-flow.ts'

const ERROR_ID = 'auto-continue-error'

/**
 * The Auto-continue toggle button: pressed (a blue tint and a fast-forward icon) when on, plain with a muted pause
 * icon when off. Off while saving; a failed save's message shows under it.
 */
export function AutoContinueButtonView({ view, onPress }: { view: ToggleView; onPress: () => void }) {
  return (
    <span className="auto-toggle">
      <button
        className="btn sm lead auto-button"
        type="button"
        aria-pressed={view.on}
        disabled={view.disabled}
        aria-describedby={view.error ? ERROR_ID : undefined}
        onClick={onPress}
      >
        <Icon name={view.on ? 'fast-forward' : 'pause'} />
        Auto-continue
      </button>
      {view.error && (
        <span id={ERROR_ID} className="auto-continue-error" role="alert">
          {view.error}
        </span>
      )}
    </span>
  )
}

/** The run header's Auto-continue button: one press posts the opposite of what it shows (`createToggleFlow`). */
export function AutoContinueButton({ target, on }: { target: RunTarget; on: boolean }) {
  const [state, setState] = useState<ToggleState>(TOGGLE_INITIAL)
  const flow = useMemo(() => createToggleFlow(target, setState), [target.repoId, target.run])
  useEffect(() => flow.board(on), [flow, on])
  return <AutoContinueButtonView view={toggleView(on, state)} onPress={() => flow.press()} />
}
