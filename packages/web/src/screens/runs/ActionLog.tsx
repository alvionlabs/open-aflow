import type { ActionEntry } from '@openaflow/model'
import { Chip } from './Chip.tsx'
import { ACTION_LOG_CAP, NO_ACTIONS, actionLogRows } from './action-log-view.ts'

/** The quiet list of the board's actions, newest first, under Other activity. */
export function ActionLog({ entries, now }: { entries: ActionEntry[] | undefined; now: number }) {
  const rows = actionLogRows(entries, now)
  return (
    <section className="other action-log" aria-label="Action log">
      <span className="eyebrow">
        Action log <span className="note">· newest {ACTION_LOG_CAP}</span>
      </span>
      {rows.length === 0 ? (
        <p className="muted note">{NO_ACTIONS}</p>
      ) : (
        <ul className="other-list">
          {rows.map((r) => (
            <li key={r.key}>
              <span className="mono">
                {r.repo} · {r.target}
              </span>
              <span className="other-meta">
                <span className="mono note">{r.time}</span>
                <Chip chip={r.chip} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
