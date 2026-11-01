import { Icon } from '../../theme/icons.tsx'
import type { Elsewhere } from './elsewhere.ts'
import { opensHere } from './open-focus.ts'
import { nextStatus } from './view.ts'
import './urgent-banner.css'

/** `onOpen` gets the run's hash, and only for a click that opens it in this tab. */
type Props = { at: Elsewhere; onOpen?: (href: string) => void }

/**
 * Another run's more urgent item, as one line: its status, title, where it is, `+N more`, and
 * "Open run". Navigation only: the item's own action stays on that run's Next step card.
 */
export function UrgentBanner({ at, onOpen }: Props) {
  const status = nextStatus(at.item.status)
  return (
    <div className="urgent">
      <span className={`status ${status.cls}`}>{status.label}</span>
      <span className="urgent-text">
        <span className="urgent-title">{at.item.title}</span> <span className="urgent-where muted">
          {/* The repo hides on phones, as the draft: the run's name is enough there. */}
          {at.repo !== undefined && (
            <span className="urgent-at">
              · <span className="urgent-repo">{at.repo}</span>{' '}
            </span>
          )}
          · {at.name}
        </span>
        {at.more > 0 && (
          <>
            {' '}
            <span className="urgent-more muted">+{at.more} more</span>
          </>
        )}
      </span>
      <a className="btn sm trail urgent-open" href={at.href} aria-label={`Open run ${at.name}`} onClick={(e) => opensHere(e) && onOpen?.(at.href)}>
        Open run
        <Icon name="arrow-right" />
      </a>
    </div>
  )
}
