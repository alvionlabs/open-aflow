import type { ReactNode, Ref } from 'react'
import { Icon } from '../../theme/icons.tsx'
import type { RunHeader as Header } from './plan-view.ts'

/**
 * The run's header: the run's title and its muted meta line, and `actions` (Auto-continue and the ⋯ menu) at the
 * right end; then the progress row: the strip (one segment per flow step), `Wave N of M`, and, at its right end,
 * `Open the wave board` when `boardHref` is given. The title takes focus from script only (`titleRef`), after the
 * urgent banner opens this run.
 */
export function RunHeader({ header, actions, boardHref, titleRef }: { header: Header; actions?: ReactNode; boardHref?: string; titleRef?: Ref<HTMLHeadingElement> }) {
  const done = header.segments.filter((s) => s === 'done').length
  const total = header.segments.length
  return (
    <header className="run-header">
      <div className="run-top">
        <div className="run-title">
          <h1 ref={titleRef} className="run-name" tabIndex={-1}>
            {header.title}
          </h1>
          {header.meta && <p className="run-sub muted">{header.meta}</p>}
        </div>
        {actions}
      </div>
      {(total > 0 || header.wave !== undefined || boardHref !== undefined) && (
        <div className="run-meta">
          {total > 0 && (
            <span className="strip" role="img" aria-label={`${done} of ${total} steps done`}>
              {header.segments.map((s, i) => (
                <i key={i} className={s} />
              ))}
            </span>
          )}
          {header.wave !== undefined && <span className="mono muted run-wave">{header.wave}</span>}
          {boardHref !== undefined && (
            <a className="btn sm trail quiet board-link" href={boardHref} aria-label="Open the wave board">
              <span className="board-link-long">Open the wave board</span>
              <span className="board-link-short">Wave board</span>
              <Icon name="arrow-right" />
            </a>
          )}
        </div>
      )}
    </header>
  )
}
