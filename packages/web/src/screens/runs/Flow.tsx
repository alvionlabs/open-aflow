import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { Stage } from '@openaflow/model'
import { Icon } from '../../theme/icons.tsx'
import { backPath, downPath, headPath, stepPath } from '../board/geometry.ts'
import { flowColumns, flowEdges, foldLine } from './plan-view.ts'

type Props = { stages: Stage[] }
type Line = { key: string; d: string; head: string; walked: boolean; dashed: boolean }

/**
 * The run's flow: a heading row, then row i holds every column's i-th step card, so cards in a row share
 * one height. One path of quiet lines joins the steps in order (down inside a column, across to the next
 * column's first card), measured from the cards on the page and redrawn when they move, like the wave
 * board's lines. On phones (CSS, ≤ 480 px) it starts folded to one line naming the current step; the line
 * opens and folds it. Nothing is remembered: the caller keys it by run, so every load and run starts folded.
 */
export function Flow({ stages }: Props) {
  const [open, setOpen] = useState(false)
  const listId = useId()
  // Stable across this component's own renders (the lines' state), so drawing doesn't loop.
  const columns = useMemo(() => flowColumns(stages), [stages])
  const edges = useMemo(() => flowEdges(columns), [columns])
  const fold = foldLine(columns)
  const rows = Math.max(0, ...columns.map((c) => c.steps.length))

  const gridRef = useRef<HTMLDivElement>(null)
  const cardRefs = useRef(new Map<string, HTMLElement>())
  const [lines, setLines] = useState<Line[]>([])
  const [size, setSize] = useState({ w: 0, h: 0 })

  const draw = useCallback(() => {
    const el = gridRef.current
    if (!el) return
    const origin = el.getBoundingClientRect()
    // Folded on a phone: nothing laid out to measure. The observer draws again once it opens.
    if (origin.width === 0) return
    const next: Line[] = []
    for (const e of edges) {
      const a = cardRefs.current.get(e.from)?.getBoundingClientRect()
      const b = cardRefs.current.get(e.to)?.getBoundingClientRect()
      if (!a || !b) continue
      const d = e.kind === 'down' ? downPath(a, b, origin) : e.kind === 'back' ? backPath(a, b, origin) : stepPath(a, b, origin)
      const head =
        e.kind === 'down'
          ? headPath((b.left + b.right) / 2 - origin.left, b.top - origin.top, 'down')
          : e.kind === 'back'
            ? headPath(b.right - origin.left, b.top + (b.bottom - b.top) / 3 - origin.top, 'left')
            : headPath(b.left - origin.left, (b.top + b.bottom) / 2 - origin.top, 'right')
      next.push({ key: `${e.from}>${e.to}`, d, head, walked: e.walked, dashed: e.dashed })
    }
    // Walked lines go last, so they sit on top.
    next.sort((x, y) => Number(x.walked) - Number(y.walked))
    setLines(next)
    setSize({ w: origin.width, h: origin.height })
  }, [edges])

  useLayoutEffect(() => {
    draw()
    const el = gridRef.current
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => draw())
    if (el) observer?.observe(el)
    window.addEventListener('resize', draw)
    let live = true
    void document.fonts?.ready.then(() => live && draw())
    return () => {
      live = false
      observer?.disconnect()
      window.removeEventListener('resize', draw)
    }
  }, [draw])

  if (columns.length === 0) return null
  const gridStyle = { '--flow-cols': columns.length, '--flow-rows': rows } as CSSProperties
  return (
    <section className={open ? 'flow-frame open' : 'flow-frame'} aria-label="Run flow">
      {fold && (
        <button className="flow-fold" data-state={fold.state} type="button" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>
          <span className="flow-mark" aria-hidden="true">
            <Icon name={fold.mark} />
          </span>
          <span className="flow-fold-text">
            {`${fold.label} · ${fold.detail}`}
            <span className="sr-only">{` (${fold.word}), all steps`}</span>
          </span>
          <span className="flow-fold-chevron" aria-hidden="true">
            <Icon name="chevron-down" />
          </span>
        </button>
      )}
      {/* The columns scroll sideways on narrow screens, so their box takes focus for the keyboard. */}
      <div className="flow-scroll" id={listId} tabIndex={0}>
        <div className="flow" style={gridStyle} ref={gridRef}>
          <svg className="flow-lines" aria-hidden="true" width={size.w} height={size.h} viewBox={`0 0 ${size.w} ${size.h}`}>
            {lines.map((l) => (
              <g key={l.key}>
                <path d={l.d} className={[l.walked ? 'walked' : '', l.dashed ? 'dashed' : ''].join(' ').trim() || undefined} />
                <path d={l.head} className={l.walked ? 'walked' : undefined} />
              </g>
            ))}
          </svg>
          <ol className="flow-cols">
            {columns.map((col) => (
              <li key={col.key} className="flow-col">
                <h2 className="flow-cap">{col.caption}</h2>
                <ol className="flow-steps">
                  {col.steps.map((s) => (
                    <li
                      key={s.key}
                      ref={(el) => {
                        if (el) cardRefs.current.set(s.key, el)
                        else cardRefs.current.delete(s.key)
                      }}
                      className={`flow-step ${s.state}${s.highlight ? ' hi' : ''}${s.dim ? ' dim' : ''}`}
                    >
                      <span className="flow-mark" aria-hidden="true">
                        <Icon name={s.mark} />
                      </span>
                      <span className="flow-label">
                        {s.label}
                        <span className="sr-only"> ({s.word})</span>
                      </span>
                      <span className="flow-detail">{s.detail}</span>
                    </li>
                  ))}
                </ol>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  )
}
