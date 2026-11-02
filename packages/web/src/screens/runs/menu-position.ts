// Where a sidebar card's fixed ⋯ menu sits: under its button with right edges aligned, 8 px inside
// the viewport's right edge; above the button when it would run off the bottom and fits above.

const GAP = 4
const EDGE = 8

export function menuPosition(
  trigger: { top: number; bottom: number; right: number },
  menuHeight: number,
  viewport: { width: number; height: number },
): { top: number; right: number } {
  const right = Math.max(EDGE, viewport.width - trigger.right)
  const below = trigger.bottom + GAP
  const above = trigger.top - GAP - menuHeight
  const flip = below + menuHeight > viewport.height - EDGE && above >= EDGE
  return { top: flip ? above : below, right }
}
