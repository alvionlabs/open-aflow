import { Icon } from '../../theme/icons.tsx'
import type { Elsewhere } from './elsewhere.ts'
import { nextStatus } from './view.ts'
import './urgent-banner.css'

type Props = { at: Elsewhere; onOpen?: () => void }

/**
 * Another run's more urgent item, as one line: its status, title, where it is, `+N more`, and
 * "Open run". Navigation only: the item's own action stays on that run's Next step card.
 */
export function UrgentBanner({ at, onOpen }: Props) {
  const status = nextStatus(at.item.status)
  const where = at.repo === undefined ? `· ${at.name}` : `· ${at.repo} · ${at.name}`
  return (
    <div className="urgent">
      <span className={`status ${status.cls}`}>{status.label}</span>
      <span className="urgent-text">
        <span className="urgent-title">{at.item.title}</span> <span className="urgent-where muted">{where}</span>
        {at.more > 0 && (
          <>
            {' '}
            <span className="urgent-more muted">+{at.more} more</span>
          </>
        )}
      </span>
      <a className="btn sm trail urgent-open" href={at.href} aria-label={`Open run ${at.name}`} onClick={onOpen}>
        Open run
        <Icon name="arrow-right" />
      </a>
    </div>
  )
}
