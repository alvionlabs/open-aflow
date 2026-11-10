import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type CSSProperties } from 'react'
import type { BoardRepo } from '@openaflow/model'
import { hashFor } from '../../selection.ts'
import { Chip } from '../runs/Chip.tsx'
import { DocTitle } from '../runs/DocTitle.tsx'
import { EngineerView } from '../engineer/EngineerView.tsx'
import { buildWaveBoard, CARD_EDGE, cardChip, engineerFor, filterState, type Card, type FilterState } from './board-view.ts'
import { edgePath } from './geometry.ts'
import './board.css'

type Props = { repo: BoardRepo; plan: string; slice?: string; now: number }
type Line = { key: string; d: string; critical: boolean }

export function BoardScreen({ repo, plan, slice, now }: Props) {
  const board = useMemo(() => buildWaveBoard(repo, plan, now), [repo, plan, now])
  const boardKey = `${repo.id}/${plan}/${board?.sprint ?? ''}`
  const [picked, setPicked] = useState<FilterState>()
  const filters = filterState.forSprint(picked, boardKey)

  const frameRef = useRef<HTMLDivElement>(null)
  const cardRefs = useRef(new Map<string, HTMLElement>())
  const [lines, setLines] = useState<Line[]>([])
  const [size, setSize] = useState({ w: 0, h: 0 })

  const draw = useCallback(() => {
    const el = frameRef.current
    if (!el || !board) return
    const origin = el.getBoundingClientRect()
    const next: Line[] = []
    for (const e of board.edges) {
      const a = cardRefs.current.get(e.from)?.getBoundingClientRect()
      const b = cardRefs.current.get(e.to)?.getBoundingClientRect()
      if (a && b) next.push({ key: `${e.from}>${e.to}`, d: edgePath(a, b, origin), critical: e.critical })
    }
    // Critical lines go last, so they sit on top where lines cross.
    next.sort((x, y) => Number(x.critical) - Number(y.critical))
    setLines(next)
    setSize({ w: origin.width, h: origin.height })
  }, [board])

  useLayoutEffect(() => {
    draw()
    const el = frameRef.current
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

  const openCard = board?.columns.flatMap((c) => c.cards).find((c) => c.code === slice)
  const engineer = openCard && board?.sprint !== undefined ? engineerFor(repo, plan, board.sprint, openCard.code) : undefined

  // Bring the engineer view into sight when a slice opens; on a narrow screen it sits below the board.
  const viewRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (openCard) viewRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [openCard?.code]) // the open slice, not the card object, which every Board event replaces

  if (!board) return null
  if (board.columns.length === 0) {
    return (
      <p className="muted board-empty">{board.sprint === undefined ? 'No sprint with a doc yet.' : `Sprint ${board.sprint} isn't drafted yet.`}</p>
    )
  }

  const open = (code: string) => {
    window.location.hash = hashFor({ repoId: repo.id, plan }, 'board', code)
  }
  const onCardKey = (e: KeyboardEvent, code: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      open(code)
    }
  }
  const onBoardKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && slice !== undefined) window.location.hash = hashFor({ repoId: repo.id, plan }, 'board')
  }
  const cardClass = (c: Card) =>
    ['card', 'wb-card', CARD_EDGE[c.state], c.critical && 'crit', filterState.isDimmed(filters, c) && 'dim', c.code === slice && 'on']
      .filter(Boolean)
      .join(' ')

  return (
    <section className="wave-board" aria-label="Wave board" onKeyDown={onBoardKey}>
      <div className="wb-head">
        <span className="eyebrow">{board.caption}</span>
        <div className="wb-filters" role="group" aria-label="Filter cards by state">
          {filterState.ORDER.map((s) => {
            const chip = cardChip(s)
            return (
              <button
                key={s}
                type="button"
                className={`chip ${chip.cls} wb-filter`}
                aria-pressed={filterState.isOn(filters, s)}
                onClick={() => setPicked(filterState.toggle(filters, s))}
              >
                {chip.label} <span className="mono">{board.counts[s]}</span>
              </button>
            )
          })}
        </div>
      </div>
      <div className="frame wb-frame" role="region" aria-label="Waves" tabIndex={0}>
        <div className="wb-board" ref={frameRef} style={{ '--wb-cols': board.columns.length } as CSSProperties}>
          <svg className="wb-lines" aria-hidden="true" width={size.w} height={size.h} viewBox={`0 0 ${size.w} ${size.h}`}>
            {lines.map((l) => (
              <path key={l.key} d={l.d} className={l.critical ? 'crit' : undefined} />
            ))}
          </svg>
          {board.columns.map((col) => (
            <div key={col.wave} className="wb-col">
              <h3>
                <span>Wave {col.wave}</span>
                <span>{col.status}</span>
              </h3>
              {col.cards.map((c) => (
                <div
                  key={c.code}
                  ref={(el) => {
                    if (el) cardRefs.current.set(c.code, el)
                    else cardRefs.current.delete(c.code)
                  }}
                  className={cardClass(c)}
                  role="button"
                  tabIndex={0}
                  aria-current={c.code === slice ? 'true' : undefined}
                  aria-label={`${c.code}: ${c.title}, ${cardChip(c.state).label}${c.critical ? ', on the critical path' : ''}`}
                  onClick={() => open(c.code)}
                  onKeyDown={(e) => onCardKey(e, c.code)}
                >
                  <div className="top">
                    <span className="code">{c.code}</span>
                    <Chip chip={cardChip(c.state)} />
                  </div>
                  <span className="name">
                    <DocTitle text={c.title} />
                  </span>
                  {c.meta !== '' && <span className="meta">{c.meta}</span>}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
      {openCard && (
        <div ref={viewRef}>
          <EngineerView
            key={openCard.code}
            repo={repo}
            code={openCard.code}
            title={openCard.title}
            chip={cardChip(openCard.state)}
            slice={openCard.slice}
            agent={engineer}
            now={now}
          />
        </div>
      )}
    </section>
  )
}
