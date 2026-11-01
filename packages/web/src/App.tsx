import { useEffect, useMemo, useState } from 'react'
import { buildFixPipeline, listRuns, type Board, type RunSummary } from '@pod-board/model'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import { createBoardStream, healthProbe, type StreamState } from './board-stream.ts'
import { boardSlices } from './screens/board/board-view.ts'
import { RunsScreen } from './screens/runs/RunsScreen.tsx'
import { resolveSelection, startClock } from './selection.ts'

export function App() {
  const [board, setBoard] = useState<Board>()
  const [stream, setStream] = useState<StreamState>('connecting')
  const [now, setNow] = useState(() => Date.now())
  const [hash, setHash] = useState(() => window.location.hash)

  useEffect(() => {
    const s = createBoardStream(
      () => new EventSource('/api/events'),
      (b) => {
        setBoard(b)
        setNow(Date.now())
      },
      setStream,
      { probe: () => healthProbe() },
    )
    return () => s.stop()
  }, [])
  useEffect(() => startClock(setNow), [])
  useEffect(() => {
    const onHash = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  return (
    <ErrorBoundary resetKey={board?.generatedAt}>
      <BoardView board={board} stream={stream} now={now} hash={hash} setHash={setHash} />
    </ErrorBoundary>
  )
}

type BoardViewProps = { board: Board | undefined; stream: StreamState; now: number; hash: string; setHash: (h: string) => void }

/** Everything computed from the Board, inside the error boundary so a throw here can't unmount the stream. */
function BoardView({ board, stream, now, hash, setHash }: BoardViewProps) {
  const runs = useMemo(() => (board ? listRuns(board, now) : []), [board, now])
  const slicesOf = (run: RunSummary) =>
    run.plan === undefined ? [] : boardSlices(board?.repos.find((r) => r.id === run.repoId), run.plan, now)
  const agentsOf = (run: RunSummary) => {
    const repo = board?.repos.find((r) => r.id === run.repoId)
    const fix = repo && run.plan !== undefined ? buildFixPipeline(repo, run.plan, now) : undefined
    return fix?.log.filter((x) => x.engineer).map((x) => x.agentId) ?? []
  }
  const selection = resolveSelection(runs, hash, slicesOf, agentsOf)

  useEffect(() => {
    if (!board || selection.hash === undefined || selection.hash === hash) return
    // An empty hash drops the `#` too: replaceState with '#' would keep it.
    window.history.replaceState(null, '', selection.hash === '' ? window.location.pathname + window.location.search : selection.hash)
    setHash(selection.hash)
  }, [board, selection.hash, hash])

  return (
    <RunsScreen board={board} stream={stream} runs={runs} selected={selection.run} view={selection.view} slice={selection.slice} agent={selection.agent} now={now} />
  )
}
