// SPIKE ONLY. One xterm.js terminal. It shows the selected run: live through its MessagePort, or the saved screen.
import { Terminal } from '@xterm/xterm'

type Run = { id: string; repo: string; sessionId: string; stopReason: string | null; termId: string | null; screen: string | null; hostAlarm: boolean }
const api = (window as any).spike as {
  runs(): Promise<Run[]>
  resume(id: string): Promise<unknown>
  start(): Promise<unknown>
  attach(termId: string): void
  onRuns(fn: (r: Run[]) => void): void
}

let term: Terminal
let port: MessagePort | undefined
let attachedTerm: string | null = null
let shownStopped: string | null = null
let selected: string | null = null
let exited = false

function freshTerm() {
  port?.close()
  port = undefined
  term?.dispose()
  const el = document.getElementById('term')!
  el.innerHTML = ''
  term = new Terminal({ cols: 120, rows: 32, scrollback: 5000 })
  term.open(el)
  term.onData((d) => port?.postMessage({ op: 'write', data: d }))
  ;(window as any).__term = term
}

;(window as any).__bufferLines = () => {
  const b = term.buffer.active
  const out: string[] = []
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '')
  while (out.length && out[out.length - 1] === '') out.pop()
  return out
}
;(window as any).__state = () => ({ attachedTerm, shownStopped, selected, exited, replayed })
let replayed = 0

window.addEventListener('message', (e) => {
  if (e.data?.type !== 'spike:port' || e.data.id !== attachedTerm) return
  port = e.ports[0]
  port.onmessage = (m) => {
    const d = m.data
    if (d.op === 'replay') {
      replayed++
      term.write(d.data)
      if (d.exited) exited = true
    } else if (d.op === 'data') term.write(d.data)
    else if (d.op === 'exit') exited = true
  }
  port.postMessage({ op: 'resize', cols: 120, rows: 32 })
})

function render(runs: Run[]) {
  document.getElementById('banner')!.style.display = runs.some((r) => r.hostAlarm) ? 'block' : 'none'
  if (!selected || !runs.some((r) => r.id === selected)) selected = runs[runs.length - 1]?.id ?? null
  const box = document.getElementById('runs')!
  box.innerHTML = ''
  for (const r of runs) {
    const s = document.createElement('span')
    s.className = 'run' + (r.id === selected ? ' sel' : '')
    s.dataset.run = r.id
    s.textContent = `${r.id} ${r.stopReason ?? 'live'} `
    s.onclick = () => {
      selected = r.id
      render(runs)
    }
    if (r.stopReason) {
      const b = document.createElement('button')
      b.textContent = 'Resume'
      b.dataset.resume = r.id
      b.onclick = (e) => {
        e.stopPropagation()
        selected = r.id
        void api.resume(r.id)
      }
      s.append(b)
    }
    box.append(s)
  }
  const r = runs.find((x) => x.id === selected)
  if (!r) return
  if (r.termId && r.termId !== attachedTerm) {
    freshTerm()
    exited = false
    attachedTerm = r.termId
    shownStopped = null
    api.attach(r.termId)
  } else if (!r.termId && shownStopped !== r.id) {
    freshTerm()
    attachedTerm = null
    shownStopped = r.id
    if (r.screen) term.write(r.screen)
  }
}

document.getElementById('new')!.onclick = () => void api.start()
freshTerm()
api.onRuns(render)
void api.runs().then(render)
