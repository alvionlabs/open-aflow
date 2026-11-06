import { Component, type ReactNode } from 'react'
import { nextBoundaryState, RENDER_FAILED, type BoundaryState } from './error-boundary.ts'
import { Chip } from './screens/runs/Chip.tsx'

type Props = { resetKey: unknown; children: ReactNode }

/** Shows a notice in place of a render that threw, and tries again when `resetKey` changes. */
export class ErrorBoundary extends Component<Props, BoundaryState> {
  override state: BoundaryState = { failed: false, key: this.props.resetKey }

  static getDerivedStateFromError(): Partial<BoundaryState> {
    return { failed: true }
  }

  static getDerivedStateFromProps(props: Props, state: BoundaryState): BoundaryState {
    return nextBoundaryState(state, props.resetKey)
  }

  override componentDidCatch(err: unknown): void {
    console.error('open-aflow render:', err)
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <main className="main">
        <p className="banner" data-tone={RENDER_FAILED.chip.cls} role="alert">
          <Chip chip={RENDER_FAILED.chip} />
          <span>{RENDER_FAILED.text}</span>
        </p>
      </main>
    )
  }
}
