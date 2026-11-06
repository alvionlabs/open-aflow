import { useEffect, useId, useRef } from 'react'
import { otherActivity, type ActionEntry, type BoardRepo, type FixPipeline, type Pipeline, type RunSummary } from '@open-aflow/model'
import { EngineerView } from '../engineer/EngineerView.tsx'
import { ActionLog } from './ActionLog.tsx'
import { Chip } from './Chip.tsx'
import { OtherActivity } from './OtherActivity.tsx'
import { SliceLog } from './SliceLog.tsx'
import { agentChip, agentLogRows, logRunChip } from './view.ts'
import './tabs.css'

type Props = { repo: BoardRepo; run: RunSummary; pipeline?: Pipeline; fixPipeline?: FixPipeline; agent?: string; now: number; actions: ActionEntry[] }

/** The Log tab: the slice log for a plan, or the agent log and the open engineer for a fix run; then Other activity and the Action log. */
export function LogTab({ repo, run, pipeline, fixPipeline, agent, now, actions }: Props) {
  return (
    <div className="tab-panel log-tab">
      {fixPipeline ? <FixLog repo={repo} run={run} pipeline={fixPipeline} agent={agent} now={now} /> : pipeline && <PlanLog repo={repo} run={run} pipeline={pipeline} />}
      <OtherActivity list={otherActivity(repo, now)} />
      <ActionLog entries={actions} now={now} />
    </div>
  )
}

/** A plan's slice log, with the plan's sprints for their numbers and states. */
function PlanLog({ repo, run, pipeline }: { repo: BoardRepo; run: RunSummary; pipeline: Pipeline }) {
  const plan = repo.model.plans.find((p) => p.slug === run.plan)
  // The current sprint wears the run's own chip, the one the runs list shows (an idle run reads waiting).
  const current = plan?.currentSprint === undefined ? undefined : { slug: plan.currentSprint, chip: logRunChip(run.state) }
  return <SliceLog log={pipeline.log} sprints={plan?.sprints ?? []} current={current} />
}

/** A fix run's agent log, and the open engineer's view below it. */
function FixLog({ repo, run, pipeline, agent, now }: { repo: BoardRepo; run: RunSummary; pipeline: FixPipeline; agent: string | undefined; now: number }) {
  const rows = agentLogRows(run, pipeline.log)
  // A resumed engineer has a row per turn; its view shows the latest one.
  const open = agent === undefined ? undefined : pipeline.log.findLast((x) => x.agentId === agent && x.engineer)
  const engineer = open && repo.agents.find((a) => a.id === open.agentId)

  const id = useId()
  const viewRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open) viewRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [open?.agentId]) // the open agent, not the row object, which every Board event replaces

  return (
    <>
      {rows.length === 0 ? (
        <p className="muted note">No agent has started on this fix yet.</p>
      ) : (
        <div className="log-frame" role="region" aria-label="Agent log" tabIndex={0}>
          <section className="log-group" aria-labelledby={id}>
            <div className="log-sprint">
              <h3 className="log-sprint-name" id={id}>
                Agents
              </h3>
            </div>
            <table className="slice-log agent-log" aria-labelledby={id}>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} aria-current={r.agentId === open?.agentId ? 'true' : undefined}>
                    <td>
                      {r.href ? <a href={r.href}>{r.label}</a> : r.label}
                      <span className="figures"> · {r.time}</span>
                    </td>
                    <td>
                      <Chip chip={r.chip} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      )}
      {open && (
        <div ref={viewRef}>
          <EngineerView key={open.agentId} repo={repo} code={open.role} title={pipeline.slug} chip={agentChip(open.state)} agent={engineer} now={now} />
        </div>
      )}
    </>
  )
}
