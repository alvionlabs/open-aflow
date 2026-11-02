import { Fragment, type ReactNode } from 'react'
import type { BoardRepo, RunSummary } from '@pod-board/model'
import { hashFor } from '../../selection.ts'
import { moreButtonId, moreName, repoOfRun } from './remove-flow.ts'
import { RunMoreMenu } from './RunMoreMenu.tsx'
import { runCard, runChip } from './view.ts'

type Props = {
  runs: RunSummary[]
  selected: RunSummary | undefined
  repos: BoardRepo[]
  /** Whether a run's card gets the ⋯ button: its repo can be removed. */
  removable?: (run: RunSummary) => boolean
  /** Remove repo, picked from a card's ⋯ menu. */
  onRemove?: (run: RunSummary) => void
  /** The remove confirm, under the card it was opened from. */
  panelFor?: (run: RunSummary) => ReactNode
}

/**
 * The runs: one card each with the run header's name, its state as a dot and a word, and its repo as a muted
 * line with the `fix` tag. Beside each card's link, never inside it, a ⋯ button when its repo can be removed. A
 * hyphen is a line break opportunity, so a hyphenated word gets its own box to stay whole.
 */
export function RunsList({ runs, selected, repos, removable, onRemove, panelFor }: Props) {
  return (
    <nav className="runs" aria-label="Runs">
      <span className="eyebrow runs-head">Runs</span>
      {runs.length > 0 && (
        <ul className="run-list">
          {runs.map((r) => {
            const href = hashFor(r)
            const state = runChip(r.state)
            const card = runCard(r, repoOfRun(repos, r))
            const fix = r.fix !== undefined
            const more = onRemove && removable?.(r)
            return (
              // Two repos can share an id (and so a hash); the repo name keeps the keys apart.
              <li key={`${href}|${r.repo}`} className="run-item">
                <div className="run-wrap">
                  <a className="run" href={href} aria-current={r === selected ? 'true' : undefined}>
                    <span className="run-body">
                      <b>
                        {card.name.split(' ').map((word, i) => (
                          <Fragment key={i}>
                            {i > 0 && ' '}
                            {word.includes('-') ? <span className="run-word">{word}</span> : word}
                          </Fragment>
                        ))}
                      </b>
                      <span className={`status ${state.cls}`}>{state.label}</span>
                      <span className="run-line">
                        {card.repo !== undefined && <span className="run-repo muted">{card.repo}</span>}
                        {fix && <span className="chip tag">fix</span>}
                      </span>
                    </span>
                  </a>
                  {more && <RunMoreMenu runName={moreName(card.name, r.repo)} triggerId={moreButtonId(r)} onRemove={() => onRemove(r)} />}
                </div>
                {panelFor?.(r)}
              </li>
            )
          })}
        </ul>
      )}
    </nav>
  )
}
