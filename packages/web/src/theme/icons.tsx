/**
 * The app's icons: 16 px SVGs drawn in currentColor, 1.5 px strokes (1.75 beside a
 * label, set in base.css), hidden from
 * assistive tech (the button's label or aria-label names the action). Use these,
 * never a text glyph such as `+`, `⋯`, `✓`, `→` or `↑`.
 */
import type { ReactNode } from 'react'

export type IconName =
  | 'plus'
  | 'more'
  | 'check'
  | 'chevron-right'
  | 'chevron-down'
  | 'arrow-up'
  | 'arrow-right'
  | 'folder'
  | 'close'
  | 'dot'
  | 'circle'
  | 'alert'
  | 'blocked'
  | 'fast-forward'
  | 'pause'

/** Stroked shapes, drawn on a 16 × 16 grid. */
const STROKED: Record<Exclude<IconName, 'more' | 'dot'>, ReactNode> = {
  plus: <path d="M8 3v10M3 8h10" />,
  check: <path d="M3.5 8.5l3 3 6-7" />,
  'chevron-right': <path d="M6 3.5L10.5 8 6 12.5" />,
  'chevron-down': <path d="M3.5 6L8 10.5 12.5 6" />,
  'arrow-up': <path d="M8 13V3.5M3.5 8L8 3.5 12.5 8" />,
  'arrow-right': <path d="M3 8h9.5M8 3.5L12.5 8 8 12.5" />,
  folder: <path d="M2 4.5c0-.6.4-1 1-1h3.2l1.5 1.5H13c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1v-7.5z" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  // Status marks: a ring for a step not reached yet, a ring with ! for one that needs you, a struck ring for blocked.
  circle: <circle cx="8" cy="8" r="4.5" />,
  alert: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.75v3.75M8 11.25v.01" />
    </>
  ),
  blocked: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M3.75 12.25l8.5-8.5" />
    </>
  ),
  // Auto-continue: on goes on by itself (fast-forward), off waits for you (pause).
  'fast-forward': <path d="M2 3.5l5.5 4.5L2 12.5zM8.5 3.5L14 8l-5.5 4.5z" />,
  pause: <path d="M5.5 3.5v9M10.5 3.5v9" />,
}

export const ICON_NAMES: readonly IconName[] = [...(Object.keys(STROKED) as IconName[]), 'more', 'dot']

export function Icon({ name }: { name: IconName }) {
  const common = { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true, focusable: false } as const
  if (name === 'more') {
    // Three filled dots read better than stroked rings at this size.
    return (
      <svg {...common} fill="currentColor">
        <circle cx="3" cy="8" r="1.25" />
        <circle cx="8" cy="8" r="1.25" />
        <circle cx="13" cy="8" r="1.25" />
      </svg>
    )
  }
  if (name === 'dot') {
    // A running step: a filled dot, sized like the ring of a waiting one.
    return (
      <svg {...common} fill="currentColor">
        <circle cx="8" cy="8" r="4" />
      </svg>
    )
  }
  return (
    <svg {...common} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      {STROKED[name]}
    </svg>
  )
}
