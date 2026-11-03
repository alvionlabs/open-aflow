import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { COPIED, COPIED_MS, COPY_FAILED, copyText, type CopyResult } from '../../copy.ts'
import { Icon } from '../../theme/icons.tsx'
import { Chip } from './Chip.tsx'
import type { ReplyPanelView } from './reply-view.ts'
import { RESUME_INITIAL, createResumeFlow, resumeView, type ResumeFlow, type ResumeState, type ResumeView, type RunTarget } from './resume-flow.ts'

/** A quiet Copy button. `Copied` for COPIED_MS; on a failed copy, the text shown selected to copy by hand. */
function CopyButton({ text, what }: { text: string; what: string }) {
  const [result, setResult] = useState<CopyResult | undefined>()
  const fieldRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (result !== 'copied') return
    const t = setTimeout(() => setResult(undefined), COPIED_MS)
    return () => clearTimeout(t)
  }, [result])
  useEffect(() => {
    if (result === 'failed') fieldRef.current?.select()
  }, [result])

  return (
    <span className="reply-copy">
      <button className="btn quiet" type="button" aria-label={`Copy ${what}`} onClick={() => void copyText(text).then(setResult)}>
        {result === 'copied' ? COPIED : 'Copy'}
      </button>
      {result === 'copied' && (
        <span className="sr-only" role="status">
          {COPIED}
        </span>
      )}
      {result === 'failed' && (
        <span className="reply-failed" role="alert">
          <input ref={fieldRef} className="input" readOnly value={text} aria-label={what} onFocus={(e) => e.currentTarget.select()} />
          <span className="note">{COPY_FAILED}</span>
        </span>
      )}
    </span>
  )
}

const SEND_LABEL = { continue: 'Continue', go: 'Go' } as const

/** The result of the last Continue or Go, in place: its status, chip and words, or the error, with Close. */
function ResumeOutcome({ view, flow }: { view: ResumeView; flow: ResumeFlow }) {
  if (view.status) {
    return (
      <p className="muted resume-outcome" role="status">
        {view.status}
      </p>
    )
  }
  if (!view.result && !view.error) return null
  return (
    <div className="resume-outcome">
      {view.result && (
        <p className="resume-result" role="status">
          <Chip chip={view.result.chip} />
          <span>{view.result.words}</span>
          {view.result.note && <span className="note">{view.result.note}</span>}
        </p>
      )}
      {view.error && (
        <p className="resume-error" role="alert">
          {view.error}
        </p>
      )}
      <button className="btn quiet" type="button" onClick={() => flow.close()}>
        Close
      </button>
    </div>
  )
}

/**
 * The chat to paste a reply in: the session line, `cd` and `claude --resume`, each with Copy; or the
 * no-session note. A folder with no safe `cd` shows as plain text, with no Copy.
 */
export function ReplyChat({ view }: { view: ReplyPanelView }) {
  const s = view.session
  if (!s) return <p className="note reply-chat">{view.noSession}</p>
  return (
    <div className="reply-chat">
      <p className="note reply-session">
        Paste it in <span className="mono">{s.line}</span>
        {s.time && <span> · {s.time}</span>}
      </p>
      {s.cd ? (
        <div className="reply-cmd">
          <code className="mono">{s.cd}</code>
          <CopyButton text={s.cd} what="cd command" />
        </div>
      ) : (
        <p className="note reply-folder">
          Open this folder yourself: <span className="mono">{s.path}</span>
        </p>
      )}
      {s.resume && (
        <div className="reply-cmd">
          <code className="mono">{s.resume}</code>
          <CopyButton text={s.resume} what="resume command" />
        </div>
      )}
    </div>
  )
}

/** `Run it yourself`: a closed disclosure over the chat to paste the reply in. */
function RunItYourself({ view }: { view: ReplyPanelView }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <div className="reply-yourself">
      <button className="btn quiet sm trail" type="button" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen((o) => !o)}>
        Run it yourself
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
      </button>
      {open && (
        <div id={id}>
          <ReplyChat view={view} />
        </div>
      )}
    </div>
  )
}

/**
 * The reply pod waits for on the selected run, and the chat to paste it in. A row the board may
 * send, on a run with a session the runner accepts, gets Continue or Go beside its Copy; it sends
 * only on a press. Every row keeps Copy. The last send's result stays
 * after the Board drops the reply, until you close it. The chat to paste it in sits behind
 * `Run it yourself`. `framed={false}` drops the frame and the heading, for use inside a card.
 */
export function ReplyPanel({ view, target, framed = true }: { view: ReplyPanelView | undefined; target: RunTarget; framed?: boolean }) {
  const [state, setState] = useState<ResumeState>(RESUME_INITIAL)
  const flow = useMemo(() => createResumeFlow(target, setState), [target.repoId, target.run])
  const resume = resumeView(state, view?.session?.resume)
  const outcome = <ResumeOutcome view={resume} flow={flow} />
  const cls = framed ? 'inplace reply-panel' : 'reply-panel bare'
  if (!view) return resume.word ? <section className={cls} aria-label="Reply pod waits for">{outcome}</section> : null
  const shownUnderRow = view.rows.some((r) => r.send !== undefined && r.send === resume.word)
  return (
    <section className={cls} aria-label="Reply pod waits for">
      {framed && <span className="eyebrow">Reply pod waits for</span>}
      <ul className="reply-list">
        {view.rows.map((r) => (
          <li key={r.key} className="reply-item">
            <div className="reply-row">
              <code className="mono reply-word">{r.word}</code>
              <span className="reply-why">{r.why}</span>
              <span className="reply-actions">
                <CopyButton text={r.word} what={r.word} />
                {r.send && (
                  <button className="btn primary" type="button" disabled={resume.busy} onClick={() => flow.press(r.send!)}>
                    {SEND_LABEL[r.send]}
                  </button>
                )}
              </span>
            </div>
            {r.send !== undefined && r.send === resume.word && outcome}
          </li>
        ))}
      </ul>
      {!shownUnderRow && outcome}
      <RunItYourself view={view} />
    </section>
  )
}

