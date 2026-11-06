// Screen 3's tool timeline, from GET /api/agents/:repoId/:agentId/timeline.
// Fetches only when the key changes. A transcript write changes the agent's
// `lastAt` on the Board, so a new key follows each board event and the timeline
// stays live without its own polling. At most one request is in flight; a key
// change during one fetches again once it returns, and a response for an older
// key is dropped. An error keeps the last timeline of the same agent.

import type { AgentTimeline } from '@open-aflow/model'

export type TimelineKey = { repoId: string; agentId: string; lastAt?: number; ended: boolean }
export type JsonReply = { status: number; body: unknown }
export type FetchJson = (url: string) => Promise<JsonReply>

export type TimelineState =
  | { kind: 'idle' }
  | { kind: 'loading'; timeline?: AgentTimeline }
  | { kind: 'ready'; timeline: AgentTimeline }
  | { kind: 'missing' }
  | { kind: 'error'; timeline?: AgentTimeline }

export const timelineUrl = (k: TimelineKey) =>
  `/api/agents/${encodeURIComponent(k.repoId)}/${encodeURIComponent(k.agentId)}/timeline`

/** GET as JSON through the page's own origin; the body only on a 2xx. */
export const fetchJsonVia =
  (fetchFn: typeof fetch = fetch): FetchJson =>
  async (url) => {
    const res = await fetchFn(url, { cache: 'no-store' })
    return { status: res.status, body: res.ok ? await res.json() : undefined }
  }

const sameKey = (a: TimelineKey | undefined, b: TimelineKey | undefined) =>
  a === b ||
  (a !== undefined && b !== undefined && a.repoId === b.repoId && a.agentId === b.agentId && a.lastAt === b.lastAt && a.ended === b.ended)

const sameAgent = (a: TimelineKey, b: TimelineKey) => a.repoId === b.repoId && a.agentId === b.agentId

/** A timeline-shaped body for this agent: enough to render without throwing. */
function asTimeline(body: unknown, agentId: string): AgentTimeline | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const t = body as Partial<AgentTimeline>
  if (t.agentId !== agentId || !Array.isArray(t.events) || typeof t.total !== 'number') return undefined
  if (typeof t.tests !== 'object' || t.tests === null) return undefined
  return body as AgentTimeline
}

export function createTimelineLoader(fetchJson: FetchJson, onState: (s: TimelineState) => void) {
  let want: TimelineKey | undefined
  /** The key of the request in flight, if any. */
  let flying: TimelineKey | undefined
  /** The key the shown timeline came from, and the timeline. */
  let have: { key: TimelineKey; timeline: AgentTimeline } | undefined
  let stopped = false

  const emit = (s: TimelineState) => {
    if (!stopped) onState(s)
  }
  /** The last timeline, when it belongs to the wanted agent. */
  const kept = () => (have && want && sameAgent(have.key, want) ? { timeline: have.timeline } : {})

  const settle = (key: TimelineKey, s: TimelineState) => {
    flying = undefined
    if (stopped) return
    if (sameKey(key, want)) emit(s)
    else if (want) start(want)
  }

  const start = (key: TimelineKey) => {
    flying = key
    emit({ kind: 'loading', ...kept() })
    fetchJson(timelineUrl(key)).then(
      (reply) => {
        if (reply.status === 404) {
          if (sameKey(key, want)) have = undefined
          return settle(key, { kind: 'missing' })
        }
        const timeline = reply.status >= 200 && reply.status < 300 ? asTimeline(reply.body, key.agentId) : undefined
        if (!timeline) return settle(key, { kind: 'error', ...kept() })
        if (sameKey(key, want)) have = { key, timeline }
        settle(key, { kind: 'ready', timeline })
      },
      () => settle(key, { kind: 'error', ...kept() }),
    )
  }

  return {
    show(key: TimelineKey | undefined) {
      if (stopped || sameKey(key, want)) return
      want = key
      if (!key) {
        have = undefined
        emit({ kind: 'idle' })
        return
      }
      if (flying) {
        // Wait for it; `settle` takes it if the key comes back, else fetches the latest.
        if (!sameKey(flying, key)) emit({ kind: 'loading', ...kept() })
        return
      }
      start(key)
    },
    stop() {
      stopped = true
    },
  }
}
