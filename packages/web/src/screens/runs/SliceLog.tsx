import { useId } from 'react'
import type { LogGroup } from '@open-aflow/model'
import { Chip } from './Chip.tsx'
import { DocTitle } from './DocTitle.tsx'
import { confidenceTag, logBlocks, rowFigures, type Chip as ChipView } from './view.ts'

type Props = { log: LogGroup[]; sprints: { slug: string; status: string }[]; current: { slug: string; chip: ChipView } | undefined }

/**
 * The slice log: one faint block per sprint, named by its heading (`Sprint N · <slug>`, its state beside
 * it; the current sprint's is the run's own chip), with one table whose row groups are the waves (`Wave N` and its status, then its slices).
 */
export function SliceLog({ log, sprints, current }: Props) {
  const id = useId()
  if (log.length === 0) return <p className="muted note">No slice log yet. It fills in once a sprint is drafted.</p>
  return (
    <div className="log-frame" role="region" aria-label="Slice log" tabIndex={0}>
      {logBlocks(log, sprints, current).map((b, i) => (
        <section className="log-group" aria-labelledby={`${id}-${i}`} key={b.key}>
          <div className="log-sprint">
            <h3 className="log-sprint-name" id={`${id}-${i}`}>
              {b.title}
            </h3>
            {b.chip && <Chip chip={b.chip} />}
          </div>
          <table className="slice-log" aria-labelledby={`${id}-${i}`}>
            {b.waves.map((w) => (
              <tbody className="log-wave" key={w.key}>
                <tr className="grp">
                  <th scope="rowgroup">{w.label}</th>
                  <td>
                    <Chip chip={w.chip} />
                  </td>
                </tr>
                {w.rows.map((row) => (
                  <tr key={row.code}>
                    <td>
                      <span className="code">{row.code}</span> · <DocTitle text={row.title} />
                      {row.model && <span className="muted"> · {row.model}</span>}
                      {rowFigures(row) && <span className="figures"> · {rowFigures(row)}</span>}
                      {confidenceTag(row) && <span className="chip tag">{confidenceTag(row)}</span>}
                    </td>
                    {/* The status rail: a state only, never figures, so it never wraps. */}
                    <td>{row.live && <Chip chip={{ cls: 's-run', label: 'running' }} />}</td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </section>
      ))}
    </div>
  )
}
