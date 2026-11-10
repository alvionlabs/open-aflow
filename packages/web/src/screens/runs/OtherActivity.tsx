import { OTHER_CAP, OTHER_WINDOW_MS, type OtherAgent } from '@openaflow/model'
import { Chip } from './Chip.tsx'
import { otherRows } from './view.ts'

/** The quiet strip of the repo's agents tied to no run. Not a run: it counts nowhere. */
export function OtherActivity({ list }: { list: OtherAgent[] }) {
  if (list.length === 0) return null
  const hours = OTHER_WINDOW_MS / 3_600_000
  return (
    <section className="other" aria-label="Other activity">
      <span className="eyebrow">
        Other activity <span className="note">· last {hours} h, newest {OTHER_CAP}</span>
      </span>
      <ul className="other-list">
        {otherRows(list).map((r) => (
          <li key={r.key}>
            <span className="mono">{r.text}</span>
            <span className="other-meta">
              <span className="mono note">{r.time}</span>
              <Chip chip={r.chip} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
