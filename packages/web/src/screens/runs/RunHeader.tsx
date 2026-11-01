import type { ReactNode, Ref } from 'react'
import type { RunHeader as Header } from './plan-view.ts'

/**
 * The run's header: the run's title and its muted meta line, and `actions` (the ⋯ menu) at the right end; then the progress strip (one segment per flow step) and `Wave N of M`.
 * The title takes focus from script only (`titleRef`), after the urgent banner opens this run.
 */
export function RunHeader({ header, actions, titleRef }: { header: Header; actions?: ReactNode; titleRef?: Ref<HTMLHeadingElement> }) {
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
      {(total > 0 || header.wave !== undefined) && (
        <div className="run-meta">
          {total > 0 && (
            <span className="strip" role="img" aria-label={`${done} of ${total} steps done`}>
              {header.segments.map((s, i) => (
                <i key={i} className={s} />
              ))}
            </span>
          )}
          {header.wave !== undefined && <span className="mono muted run-wave">{header.wave}</span>}
        </div>
      )}
    </header>
  )
}
