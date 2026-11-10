import { useEffect, useRef, useState } from 'react'
import type { AgentRun, BoardRepo, SliceModel } from '@openaflow/model'
import { createTimelineLoader, fetchJsonVia, type TimelineState } from '../../timeline-loader.ts'
import { Chip } from '../runs/Chip.tsx'
import type { Chip as ChipView } from '../runs/view.ts'
import { DocTitle } from '../runs/DocTitle.tsx'
import { engineerDetails, timelineRows } from './view.ts'
import './engineer.css'

/** `code · title` and a chip head the view: a slice card's, or a fix run's engineer. A fix run's engineer has no slice. */
type Props = { repo: BoardRepo; code: string; title: string; chip: ChipView; slice?: SliceModel; agent: AgentRun | undefined; now: number }

export function EngineerView({ repo, code, title, chip, slice, agent, now }: Props) {
  const [state, setState] = useState<TimelineState>({ kind: 'idle' })
  const loader = useRef<ReturnType<typeof createTimelineLoader>>(undefined)

  useEffect(() => {
    const l = createTimelineLoader(fetchJsonVia(), setState)
    loader.current = l
    return () => l.stop()
  }, [])

  const lastAt = agent?.lastAt
  const ended = agent?.ended ?? false
  useEffect(() => {
    const l = loader.current
    if (!l) return
    l.show(agent ? { repoId: repo.id, agentId: agent.id, ended, ...(lastAt === undefined ? {} : { lastAt }) } : undefined)
  }, [repo.id, agent?.id, lastAt, ended]) // the key's parts, not the agent object, which every Board event replaces

  const timeline = state.kind === 'ready' || state.kind === 'loading' || state.kind === 'error' ? state.timeline : undefined
  const details = engineerDetails(slice, agent, now, timeline?.tests)
  const view = timeline ? timelineRows(timeline) : undefined

  return (
    <div className="frame ev" aria-label={`Engineer for ${code}`} role="region">
      <div className="ev-side">
        <div className="ev-bar">
          <span className="ev-title">
            {code} · <DocTitle text={title} />
          </span>
          <Chip chip={chip} />
        </div>
        <dl className="ev-details">
          {details.map((d) => (
            <div key={d.label}>
              <dt>{d.label}</dt>
              <dd className={d.mono ? 'mono' : undefined}>{d.value}</dd>
            </div>
          ))}
        </dl>
        <div className="ev-actions">
          <button className="btn" type="button" disabled title="Phase 3">
            Step in (phase 3)
          </button>
        </div>
      </div>
      <div className="ev-side">
        <span className="eyebrow">Live timeline</span>
        {!agent ? (
          <p className="muted ev-note">No engineer has started on this slice yet.</p>
        ) : state.kind === 'missing' ? (
          <p className="muted ev-note">No transcript found for this engineer.</p>
        ) : !view ? (
          <p className="muted ev-note">{state.kind === 'error' ? "Can't load the timeline. It retries when the engineer writes again." : 'Loading the timeline…'}</p>
        ) : (
          <>
            {state.kind === 'error' && (
              <p className="ev-warn" role="status">
                <span className="chip s-you">stale</span> Can't load the newest steps. Showing the last ones read.
              </p>
            )}
            {view.rows.length === 0 ? (
              <p className="muted ev-note">No tool calls yet.</p>
            ) : (
              // The box scrolls from its bottom (column-reverse), so the newest row stays in sight.
              <div className="ev-scroll" tabIndex={0} role="group" aria-label="Tool calls, oldest first">
                <ol className="ev-log">
                  {view.earlier && <li className="ev-earlier">{view.earlier}</li>}
                  {view.rows.map((r) => (
                    <li key={r.key}>
                      <b>{r.time}</b>
                      <span className="ev-sum">
                        {r.summary}
                        {r.result && ' '}
                        {r.result && <span className={`ev-res ${r.result.cls}`}>{r.result.label}</span>}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
