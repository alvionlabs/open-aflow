import { Icon } from '../../theme/icons.tsx'
import type { Elsewhere } from './elsewhere.ts'
import { opensHere } from './open-focus.ts'
import { nextStatus } from './view.ts'
import './urgent-banner.css'

/** `onOpen` gets the run's hash, and only for a click that opens it in this tab. */
type Props = { at: Elsewhere; onOpen?: (href: string) => void }

/**
 * Another run's more urgent item, as one line: its status, title, where it is, `+N more`, and
 * "Open run". Other items stack behind it, as one or two empty layers, however many there are.
 * Navigation only: the item's own action stays on that run's Next step card.
 */
export function UrgentBanner({ at, onOpen }: Props) {
  const status = nextStatus(at.item.status)
  return (
    <div className="urgent">
      {at.more >= 1 && <span className="urgent-layer urgent-layer-1" aria-hidden="true" />}
      {at.more >= 2 && <span className="urgent-layer urgent-layer-2" aria-hidden="true" />}
      <span className={`status ${status.cls}`}>{status.label}</span>
      <span className="urgent-text">
        <span className="urgent-title">{at.item.title}</span> <span className="urgent-where muted">
          {/* The repo hides when the banner is narrow: the run's name is enough there. */}
          {at.repo !== undefined && (
            <span className="urgent-at">
              · <span className="urgent-repo">{at.repo}</span>{' '}
            </span>
          )}
          · {at.name}
        </span>
      </span>
      {at.more > 0 && (
        <>
          {' '}
          <span className="urgent-more">+{at.more} more</span>
        </>
      )}
      <a className="btn sm quiet trail urgent-open" href={at.href} aria-label={`Open run ${at.name}`} onClick={(e) => opensHere(e) && onOpen?.(at.href)}>
        Open run
        <Icon name="arrow-right" />
      </a>
    </div>
  )
}
