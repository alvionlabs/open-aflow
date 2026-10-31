import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { BoardRepo, RunSummary } from '@pod-board/model'
import { AnswerForm } from './AnswerForm.tsx'
import { INITIAL, createAnswerFlow, formView, type AnswerState } from './answer-flow.ts'
import { MergeConfirm, mergeButtonId, useMergeFlow } from './MergeConfirm.tsx'
import type { NextItem } from './next-step.ts'
import { answerNote } from './queue-view.ts'
import { ReplyPanel } from './ReplyPanel.tsx'
import { INITIAL_RESOLVE, createResolveFlow, triageTarget, type ResolveState } from './resolve-flow.ts'
import { TriageButton, TriageError, TriageLine } from './Triage.tsx'
import { nextStatus } from './view.ts'

type Props = { repo: BoardRepo; run: RunSummary; card: NextItem }

/**
 * The Next step card: its label, status, title, detail and one action. Answer and Merge open their
 * panel in place under the card, with the card's own flows, so a result stays after the Board moves
 * the item on. The reply slot is always mounted for a run with a plan, so a Continue or Go result
 * stays when the Board drops the reply. Key it per run.
 */
export function NextStepCard({ repo, run, card }: Props) {
  const [answer, setAnswer] = useState<AnswerState>(INITIAL)
  const answerFlow = useMemo(() => createAnswerFlow(setAnswer), [])
  const [merge, mergeFlow] = useMergeFlow()
  const [resolve, setResolve] = useState<ResolveState>(INITIAL_RESOLVE)
  const resolveFlow = useMemo(() => createResolveFlow(setResolve), [])
  const answerButton = useRef<HTMLButtonElement>(null)
  const titleId = useId()

  const answerLine = answer.kind === 'idle' ? undefined : answer.target.line
  const quote = formView(answer)?.entry
  // Focus goes back to the card's Answer button when the form closes, if it's still there.
  useEffect(() => {
    if (answerLine === undefined) return
    return () => answerButton.current?.focus()
  }, [answerLine])

  const a = card.action
  const status = nextStatus(card.status)
  const calm = card.tier === 'nothing'
  // One queue write at a time: Answer, Close and Keep wait for each other.
  const saving = answer.kind === 'saving' || resolve.kind === 'saving'
  const triage = a.kind === 'answer' ? triageTarget(card.entry, repo.id) : undefined
  return (
    <>
      <section className={calm ? 'card calm next-step' : 'card next-step'} aria-labelledby={titleId}>
        <div className="next-top">
          <span className="eyebrow">Next step</span>
          <span className={`status ${status.cls}`}>{status.label}</span>
        </div>
        {/* A queue entry's kind, as a dot and word like the Waiting rows. */}
        {card.kind && (
          <p className="next-kind mono">
            <span className={`status ${card.kind.cls} wait-kind`}>{card.kind.label}</span>
          </p>
        )}
        <h2 id={titleId} className="next-title">
          <CardTitle title={card.title} link={card.titleLink} />
        </h2>
        {/* A reply's rows each say why, so its detail would only repeat the first one. */}
        {card.detail && a.kind !== 'reply' && <p className="next-detail">{card.detail}</p>}
        {a.kind === 'answer' && card.entry && <TriageLine row={card.entry} />}
        {a.kind === 'answer' && (
          <div className="inplace-actions next-acts">
            <button
              ref={answerButton}
              className="btn primary"
              type="button"
              aria-expanded={answerLine === a.line}
              disabled={saving}
              onClick={() => answerFlow.open({ repoId: a.repoId, line: a.line, ...(card.entry ? { entry: card.entry.text } : {}) })}
            >
              Answer
            </button>
            {triage && <TriageButton target={triage} state={resolve} flow={resolveFlow} busy={saving} size="md" />}
          </div>
        )}
        {a.kind === 'merge' && (
          <div className="inplace-actions next-acts">
            <button
              id={mergeButtonId(a.number)}
              className="btn primary"
              type="button"
              aria-expanded={merge.kind !== 'idle' && merge.target.number === a.number}
              disabled={merge.kind === 'merging'}
              onClick={() => mergeFlow.open({ repoId: a.repoId, number: a.number })}
            >
              Merge
            </button>
          </div>
        )}
        {run.plan !== undefined && (
          <ReplyPanel key="reply-panel" view={a.kind === 'reply' ? a.panel : undefined} target={{ repoId: repo.id, run: run.plan }} framed={false} />
        )}
      </section>
      {/* The form quotes the entry it opened for, never the card's current one: the Board can move the card on. */}
      {answer.kind !== 'idle' && <AnswerForm state={answer} flow={answerFlow} note={answerNote(run)} {...(quote === undefined ? {} : { entry: quote })} />}
      {/* A failed Close or Keep stays under the card, even after the Board moves the card on. */}
      <TriageError state={resolve} flow={resolveFlow} />
      {merge.kind !== 'idle' && <MergeConfirm state={merge} flow={mergeFlow} label={`PR #${merge.target.number}`} />}
    </>
  )
}

/** The title, with `link.text` (the first time it appears) as a link. */
function CardTitle({ title, link }: { title: string; link: NextItem['titleLink'] }) {
  const at = link ? title.indexOf(link.text) : -1
  if (!link || at < 0) return <>{title}</>
  return (
    <>
      {title.slice(0, at)}
      <a href={link.href}>{link.text}</a>
      {title.slice(at + link.text.length)}
    </>
  )
}
