import { Fragment } from 'react'
import type { BoardRepo, RunSummary } from '@openaflow/model'
import { hashFor } from '../../selection.ts'
import { Icon } from '../../theme/icons.tsx'
import { moreButtonId, moreName, repoOfRun } from './remove-flow.ts'
import { RunMoreMenu } from './RunMoreMenu.tsx'
import { runTag } from './plan-view.ts'
import { runCard, runChip } from './view.ts'

type Props = {
  runs: RunSummary[]
  selected: RunSummary | undefined
  repos: BoardRepo[]
  /** Whether a run's card gets the ⋯ button: its repo can be removed. */
  removable?: (run: RunSummary) => boolean
  /** Remove repo, picked from a card's ⋯ menu: it opens the screen's confirm modal. */
  onRemove?: (run: RunSummary) => void
  /** Whether the board sends `continue` for this run by itself (`switchView`): the card gets the fast-forward icon. */
  auto?: (run: RunSummary) => boolean
}

/** A line break opportunity after each `_`, which browsers don't give; a hyphen already has one. */
const breakAfterUnderscores = (text: string) =>
  text.split('_').map((part, i, all) => (
    <Fragment key={i}>
      {part}
      {i < all.length - 1 && (
        <>
          _<wbr />
        </>
      )}
    </Fragment>
  ))

/**
 * The runs: one card each with the run header's name (then, while auto-continue is on, a fast-forward icon in the
 * card's top-right corner, on the title row), its state as a dot and a word, and its repo as a muted line with the `task` or `fix` tag (`runTag`). Beside each card's link, never inside it, a ⋯ button when its repo can be removed. A
 * hyphen or an underscore is a line break opportunity, so such a word gets its own box to stay whole when it fits.
 */
export function RunsList({ runs, selected, repos, removable, onRemove, auto }: Props) {
  return (
    <nav className="runs" aria-label="Runs">
      <span className="eyebrow runs-head">Runs</span>
      {runs.length > 0 && (
        <ul className="run-list">
          {runs.map((r) => {
            const href = hashFor(r)
            const state = runChip(r.state)
            const card = runCard(r, repoOfRun(repos, r))
            const tag = runTag(r)
            const more = onRemove && removable?.(r)
            const isAuto = auto?.(r) === true
            // In plain text: a <wbr> would read as a space in the link's accessible name.
            const label = [card.name, state.label, isAuto ? 'auto-continue on' : undefined, card.repo, tag].filter((part) => part !== undefined).join(' ')
            return (
              // Two repos can share an id (and so a hash); the repo name keeps the keys apart.
              <li key={`${href}|${r.repo}`} className="run-item">
                <div className="run-wrap">
                  <a className="run" href={href} aria-current={r === selected ? 'true' : undefined} aria-label={label}>
                    <span className="run-body">
                      <b>
                        {card.name.split(' ').map((word, i) => (
                          <Fragment key={i}>
                            {i > 0 && ' '}
                            {/[-_]/.test(word) ? <span className="run-word">{breakAfterUnderscores(word)}</span> : word}
                          </Fragment>
                        ))}
                      </b>
                      {isAuto && (
                        <span className="run-auto" role="img" aria-label="Auto-continue on" title="Auto-continue on">
                          <Icon name="fast-forward" />
                        </span>
                      )}
                      <span className={`status ${state.cls}`}>{state.label}</span>
                      <span className="run-line">
                        {card.repo !== undefined && <span className="run-repo muted">{breakAfterUnderscores(card.repo)}</span>}
                        {tag && <span className="chip tag">{tag}</span>}
                      </span>
                    </span>
                  </a>
                  {more && <RunMoreMenu runName={moreName(card.name, r.repo)} triggerId={moreButtonId(r)} onRemove={() => onRemove(r)} />}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </nav>
  )
}
