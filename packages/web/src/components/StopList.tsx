// The "what happened" list: what you did on this stop, with a thin left rule and one dot per item. A done item has a
// --ready ring and its time; the current one a filled --needs-you dot and "— now". The words carry the state, not the dot.
import './stop-list.css'

export type StopItem = { key: string; label: string; time: string; state: 'done' | 'current'; note?: string }

export function StopList({ items }: { items: StopItem[] }) {
  if (items.length === 0) return null
  return (
    <ol className="stop-list" aria-label="What happened">
      {items.map((item) => (
        <li key={item.key} className={`stop-item ${item.state}`} aria-current={item.state === 'current' ? 'step' : undefined}>
          {item.label}
          <span className="stop-when">{item.state === 'current' ? ' — now' : ` · ${item.time}`}</span>
          {item.note && <p className="muted stop-note">{item.note}</p>}
        </li>
      ))}
    </ol>
  )
}
