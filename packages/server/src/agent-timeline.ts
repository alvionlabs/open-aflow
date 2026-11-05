// Serves one board agent's tool timeline. The agent must be on the current
// Board, and its file comes from that repo's transcript listing: the id is
// matched against the listing, never used to build a path. The timeline
// holds tool names and short summaries only (see the model's timeline.ts).

import { parseAgentTimeline, type AgentTimeline, type Board } from '@pod-board/model'
import { listAgentFiles, readAgentFile } from './transcript-files.ts'

export type TimelineSourceDeps = {
  board: () => Board
  claudeDir: string
  transcriptDays: number
  now: () => number
}

export type TimelineSource = {
  /** The agent's timeline, or undefined when the repo or agent isn't on the Board, the id is bad, or the file is gone. */
  timeline(repoId: string, agentId: string): Promise<AgentTimeline | undefined>
}

/** The agent ids the timeline route accepts. */
export const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/

export function createTimelineSource(deps: TimelineSourceDeps): TimelineSource {
  // No cache: the page asks again only when the agent's lastAt moves, so the file has changed
  // anyway, and a kept copy of every viewed transcript's text would only grow.
  return {
    async timeline(repoId, agentId) {
      if (!AGENT_ID.test(agentId)) return undefined
      const repo = deps.board().repos.find((r) => r.id === repoId)
      const agent = repo?.agents.find((a) => a.id === agentId)
      if (!repo || !agent) return undefined
      const files = await listAgentFiles(deps.claudeDir, repo.path, deps.transcriptDays, deps.now())
      const file = files.find((f) => f.id === agent.id && f.session === agent.session)
      if (!file) return undefined
      try {
        const { jsonl } = await readAgentFile(file)
        return parseAgentTimeline({ agentId: agent.id, jsonl, roots: [repo.path] })
      } catch {
        // Deleted between listing and reading.
        return undefined
      }
    },
  }
}
