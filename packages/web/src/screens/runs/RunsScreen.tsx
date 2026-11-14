import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { buildFixPipeline, buildFlow, buildPipeline, type Board, type RunSummary } from '@openaflow/model'
import type { StreamState } from '../../board-stream.ts'
import { hashFor, type View } from '../../selection.ts'
import { ConfirmModal } from '../../components/ConfirmModal.tsx'
import { returnFocus } from '../../components/modal.ts'
import { Icon } from '../../theme/icons.tsx'
import { BoardScreen } from '../board/BoardScreen.tsx'
import { AddRepoDialog } from './AddRepoDialog.tsx'
import { AutoContinueButton } from './AutoContinueButton.tsx'
import { BarMenu } from './BarMenu.tsx'
import { Flow } from './Flow.tsx'
import { Chip } from './Chip.tsx'
import { elsewhere } from './elsewhere.ts'
import { LogTab } from './LogTab.tsx'
import { NextStepCard } from './NextStepCard.tsx'
import { focusOnArrival } from './open-focus.ts'
import {
  INITIAL as FORGET_IDLE,
  createForgetFlow,
  forgetTarget,
  forgetView,
  hashAfterForget,
  navigateAfterForget,
  type ForgetState,
} from './forget-flow.ts'
import { nextSteps } from './next-step.ts'
import { runHeader } from './plan-view.ts'
import { switchView } from './resume-flow.ts'
import { MENU_TRIGGER_ID } from './BarMenu.tsx'
import {
  INITIAL as REMOVE_IDLE,
  confirmView as removeView,
  createRemoveFlow,
  hashAfterRemove,
  moreButtonId,
  navigateAfterRemove,
  removeTarget,
  repoOfRun,
  type RemoveState,
} from './remove-flow.ts'
import { RunHeader } from './RunHeader.tsx'
import { RunsList } from './RunsList.tsx'
import { SideHandle } from './SideHandle.tsx'
import { UrgentBanner } from './UrgentBanner.tsx'
import { readWidth, saveWidth } from './sidebar-width.ts'
import { readTab, saveTab, shownTab, type Tab, type TabStorage } from './tab-memory.ts'
import { WaitingTab } from './WaitingTab.tsx'
import { banners, connectionStatus, POD_INSTALL, tabPress } from './view.ts'
import './runs.css'

type Props = {
  board: Board | undefined
  stream: StreamState
  runs: RunSummary[]
  selected: RunSummary | undefined
  view: View
  slice: string | undefined
  /** The open agent of a fix run. */
  agent?: string | undefined
  now: number
  /** Where the open tab is remembered; the page's local storage when not given. */
  storage?: TabStorage | undefined
  /** Sets the run the page falls back to while a remove is in flight (`resolveSelection`'s fallback); undefined clears it. */
  planFallback?: (hash: string | undefined) => void
  /** Moves the page to a hash now ('' for none). */
  navigate?: (hash: string) => void
}

/** The page's local storage, or nothing where there is none or it throws. */
function pageStorage(): TabStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

const TAB_LABELS: Record<Tab, string> = { waiting: 'Waiting', log: 'Log' }
const TABS: Tab[] = ['waiting', 'log']

export function RunsScreen({ board, stream, runs, selected, view, slice, agent, now, storage, planFallback, navigate }: Props) {
  const store = useRef(storage ?? pageStorage())
  const [stored, setStored] = useState<Tab | undefined>(() => readTab(store.current))
  const [picking, setPicking] = useState(false)
  const [sideWidth, setSideWidth] = useState(() => readWidth(store.current))
  const repoButton = useRef<HTMLButtonElement>(null)
  const runTitle = useRef<HTMLHeadingElement>(null)
  // The hash the urgent banner's Open run went to, so focus lands on that run's title.
  const focusFor = useRef<string | undefined>(undefined)

  const repo = repoOfRun(board?.repos ?? [], selected)
  const isFix = selected?.fix !== undefined
  const fixPipeline = repo && isFix && selected?.plan !== undefined ? buildFixPipeline(repo, selected.plan, now) : undefined
  const pipeline = repo && !isFix && selected?.plan !== undefined ? buildPipeline(repo, selected.plan, now) : undefined
  const header = runHeader(selected, repo, now, board?.transcriptDays)
  const steps = nextSteps(selected, repo, now)
  const shown = shownTab(stored, { view })
  const notices = banners(board, stream)
  const lost = connectionStatus(stream)
  const autoSwitch = switchView(selected, board)
  const runKey = selected ? hashFor(selected) : 'none'
  // Screen 1 only: the wave board and the engineer view have no urgent banner.
  const urgentSlot = board !== undefined && selected !== undefined && repo !== undefined && view !== 'board'
  const urgent = urgentSlot ? elsewhere(runs, board, selected, now) : undefined

  useEffect(() => {
    const pending = focusFor.current
    focusFor.current = undefined
    if (focusOnArrival(pending, runKey)) runTitle.current?.focus()
  }, [runKey])
  // A plan's full flow (Think → You → sprints → Check → Ship); a fix run's Build, Review, Ship.
  const stages = fixPipeline?.stages ?? (repo && pipeline && selected?.plan !== undefined ? (buildFlow(repo, selected.plan, now) ?? []) : [])

  // Remove repo, from the header's ⋯ or a sidebar card's ⋯: both open the one confirm modal.
  // After a removal the page moves on when the open run's repo left.
  const [removeState, setRemoveState] = useState<RemoveState>(REMOVE_IDLE)
  const latest = useRef({ planFallback, navigate, selected })
  latest.current = { planFallback, navigate, selected }
  const removeFlow = useMemo(
    () =>
      createRemoveFlow(setRemoveState, (target, after) => {
        // `after` was planned when Remove was pressed: the new Board may have reached the page first, and
        // the user may have opened another run meanwhile, which stays.
        const go = navigateAfterRemove(latest.current.selected, target, after)
        if (go !== undefined) latest.current.navigate?.(go)
        latest.current.planFallback?.(undefined)
      }),
    [],
  )
  useEffect(() => removeFlow.cancel(), [runKey, removeFlow])
  // A failed or cancelled remove leaves no fallback behind.
  useEffect(() => {
    if (removeState.kind !== 'removing') latest.current.planFallback?.(undefined)
  }, [removeState.kind])
  /** Remove pressed: plan where the page goes from the runs and the selection now, before the Board changes. */
  const pressRemove = () => {
    if (removeState.kind !== 'confirm' && removeState.kind !== 'error') return
    const after = hashAfterRemove(runs, selected, removeState.target)
    planFallback?.(after)
    removeFlow.remove(after)
  }
  const repos = board?.repos ?? []
  const toRemove = removeTarget(repo, { repos, runs, returnTo: MENU_TRIGGER_ID })
  const sideTarget = (run: RunSummary) => removeTarget(repoOfRun(repos, run), { repos, runs, returnTo: moreButtonId(run) })

  // Forget this run, from the header's ⋯ only, when forgetCheck allows it. The modal keeps the target taken at open.
  const [forgetState, setForgetState] = useState<ForgetState>(FORGET_IDLE)
  const forgetFlow = useMemo(
    () =>
      createForgetFlow(setForgetState, (target, after) => {
        const go = navigateAfterForget(latest.current.selected, target, after)
        if (go !== undefined) latest.current.navigate?.(go)
        latest.current.planFallback?.(undefined)
      }),
    [],
  )
  // A run change cancels: when the new Board comes first, the page has already moved to the planned run.
  useEffect(() => forgetFlow.cancel(), [runKey, forgetFlow])
  useEffect(() => {
    if (forgetState.kind !== 'forgetting') latest.current.planFallback?.(undefined)
  }, [forgetState.kind])
  const pressForget = () => {
    if (forgetState.kind !== 'confirm' && forgetState.kind !== 'error') return
    const after = hashAfterForget(runs, selected, forgetState.target)
    planFallback?.(after)
    forgetFlow.forget(after)
  }
  const toForget = header ? forgetTarget(repo, selected, header.title, now) : undefined

  // One confirm modal on the screen: at most one of the two is open, since the modal makes the page inert.
  const removing = removeView(removeState)
  const forgetting = forgetView(forgetState)
  const modal = removing
    ? { key: 'remove', view: removing, onConfirm: pressRemove, onCancel: () => removeFlow.cancel() }
    : forgetting
      ? { key: 'forget', view: forgetting, onConfirm: pressForget, onCancel: () => forgetFlow.cancel() }
      : undefined
  // The modal sends focus to its ⋯ button; when that left with its card, focus falls to the header's ⋯.
  const modalOpen = modal !== undefined
  const wasOpen = useRef(false)
  useEffect(() => {
    if (wasOpen.current && !modalOpen) setTimeout(() => returnFocus(MENU_TRIGGER_ID, document), 0)
    wasOpen.current = modalOpen
  }, [modalOpen])

  const press = (t: Tab) => {
    const next = tabPress(shown, t, view)
    saveTab(store.current, next.save)
    setStored(next.save)
    if (next.leave && selected) window.location.hash = hashFor(selected)
  }
  const commitWidth = (w: number) => {
    setSideWidth(w)
    saveWidth(store.current, w)
  }
  const closePicker = () => {
    setPicking(false)
    repoButton.current?.focus()
  }

  const menu = (
    <BarMenu
      key={runKey}
      portBase={selected?.portBase}
      {...(toForget ? { forget: { onPick: () => forgetFlow.open(toForget) } } : {})}
      {...(toRemove ? { remove: { onPick: () => removeFlow.open(toRemove) } } : {})}
    />
  )
  // The run header's right end: Auto-continue (plan and fix runs) just left of the ⋯ menu. Keyed by run, so a
  // failed save's message stays with its own run. Its own key: the ⋯ menu beside it is keyed by run too.
  const headerActions = (
    <div className="run-actions">
      {selected?.plan !== undefined && autoSwitch && <AutoContinueButton key={`auto:${runKey}`} target={{ repoId: selected.repoId, run: selected.plan }} on={autoSwitch.on} />}
      {menu}
    </div>
  )

  return (
    <div className="screen">
      <div className="screen-body" style={{ '--side-width': `${sideWidth}px` } as CSSProperties}>
        <aside className="side" id="side">
          <div className="side-head">
            <span className="logo">
              <i aria-hidden="true" />
              OpenAFlow
            </span>
            {lost && (
              <span className={`status ${lost.cls}`} role="status">
                {lost.label}
              </span>
            )}
          </div>
          <RunsList
            runs={runs}
            selected={selected}
            repos={repos}
            removable={(r) => sideTarget(r) !== undefined}
            onRemove={(r) => {
              const t = sideTarget(r)
              if (t) removeFlow.open(t)
            }}
            auto={(r) => switchView(r, board)?.on === true}
          />
          <div className="side-foot">
            <button ref={repoButton} className="btn lead add-repo" type="button" aria-haspopup="dialog" onClick={() => setPicking(true)}>
              <Icon name="plus" />
              Add repo
            </button>
          </div>
        </aside>
        <SideHandle width={sideWidth} onResize={setSideWidth} onCommit={commitWidth} />
        <main className={view === 'board' ? 'main wide' : 'main'}>
          {urgentSlot && (
            <div className="urgent-slot" role="status">
              {urgent && <UrgentBanner at={urgent} onOpen={(href) => (focusFor.current = href)} />}
            </div>
          )}
          {notices.length > 0 && (
            <div className="banners">
              {notices.map((b) => (
                <p key={b.chip.label} className="banner" data-tone={b.chip.cls} role="status">
                  <Chip chip={b.chip} />
                  <span>{b.text}</span>
                </p>
              ))}
            </div>
          )}
          {!board ? (
            <p className="muted">{stream === 'lost' ? 'Waiting for the server…' : 'Connecting to the server…'}</p>
          ) : !selected || !repo ? (
            <div className="empty">
              <div className="run-top">
                <h1 className="run-name">No repos yet</h1>
                {menu}
              </div>
              <p className="muted">Press Add repo in the sidebar and pick a repo's folder to see its pod runs.</p>
              <p className="muted">Runs come from pod, a Claude Code plugin. {POD_INSTALL}</p>
            </div>
          ) : view === 'board' && pipeline && selected.plan !== undefined ? (
            <>
              {header && <RunHeader header={header} actions={headerActions} />}
              <p className="back">
                <a href={hashFor(selected)}>Back to the run</a>
              </p>
              <BoardScreen repo={repo} plan={selected.plan} {...(slice === undefined ? {} : { slice })} now={now} />
            </>
          ) : (
            <>
              {header && (
                <RunHeader header={header} titleRef={runTitle} actions={headerActions} {...(pipeline ? { boardHref: hashFor(selected, 'board') } : {})} />
              )}
              <Flow key={`flow:${runKey}`} stages={stages} />
              {steps && <NextStepCard key={runKey} repo={repo} run={selected} card={steps.card} />}
              <div className="tabs" role="group" aria-label="More about this run">
                {TABS.map((t) => (
                  <button key={t} className="tab" type="button" aria-expanded={shown === t} aria-controls={shown === t ? `tab-${t}` : undefined} onClick={() => press(t)}>
                    {TAB_LABELS[t]}
                    {t === 'waiting' && <span className="n">{steps?.rest.length ?? 0}</span>}
                  </button>
                ))}
              </div>
              {shown && (
                <div id={`tab-${shown}`} className="tab-slot">
                  {shown === 'waiting' && <WaitingTab key={runKey} repo={repo} run={selected} items={steps?.rest ?? []} />}
                  {shown === 'log' && (
                    <LogTab
                      repo={repo}
                      run={selected}
                      {...(pipeline ? { pipeline } : {})}
                      {...(fixPipeline ? { fixPipeline } : {})}
                      {...(view === 'agent' && agent !== undefined ? { agent } : {})}
                      now={now}
                      actions={board.actions ?? []}
                    />
                  )}
                </div>
              )}
            </>
          )}
        </main>
      </div>
      {modal && <ConfirmModal key={modal.key} {...modal.view} onConfirm={modal.onConfirm} onCancel={modal.onCancel} />}
      {picking && <AddRepoDialog repoPaths={board?.repos.map((r) => r.path) ?? []} onClose={closePicker} />}
    </div>
  )
}
