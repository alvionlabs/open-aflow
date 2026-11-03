import { useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react'
import { createSetupGate } from './setup-client.ts'
import { SETUP_NOTE, setupRows, type SetupRow, type SetupState, type ToolName } from './setup-view.ts'
import './setup.css'

type Gate = ReturnType<typeof createSetupGate>

/** Shows its children (the board) only once the gate says board, so nothing in them starts before that. */
export function SetupGate({ children }: { children: ReactNode }) {
  const [gate] = useState(() => createSetupGate())
  const state = useSyncExternalStore(gate.subscribe, gate.state)
  useEffect(() => gate.start(), [gate])
  if (state.view === 'checking') return null
  if (state.view === 'setup') return <SetupScreen setup={state.setup} gate={gate} />
  return <>{children}</>
}

function SetupScreen({ setup, gate }: { setup: SetupState; gate: Gate }) {
  return (
    <main className="setup">
      <div className="setup-head">
        <h1>Setup check</h1>
        <p className="setup-intro">Pod Board needs these tools before it can show your runs.</p>
      </div>
      <ul className="setup-rows">
        {setupRows(setup).map((row) => (
          <Row key={row.tool} row={row} busy={setup.busy} onSave={(text) => void gate.save(row.tool, text)} />
        ))}
      </ul>
      <div className="setup-actions">
        <button type="button" className="btn" disabled={setup.busy} onClick={() => void gate.recheck()}>
          Recheck
        </button>
        {setup.recheckError && <p className="setup-error">{setup.recheckError}</p>}
      </div>
      <p className="setup-note">{SETUP_NOTE}</p>
    </main>
  )
}

function Row({ row, busy, onSave }: { row: SetupRow; busy: boolean; onSave: (text: string) => void }) {
  return (
    <li className="setup-row">
      <span className={`status ${row.cls}`}>{row.word}</span>
      <span className="setup-name">{row.tool}</span>
      <div className="setup-what">
        {row.path !== undefined && <div className="setup-path">{row.path}</div>}
        {row.fix && (
          <div>
            {row.fix.lead}
            {row.fix.link && (
              <a href={row.fix.link.href} target="_blank" rel="noreferrer">
                {row.fix.link.label}
              </a>
            )}
            {row.fix.rest}
          </div>
        )}
      </div>
      {row.field && <PathField tool={row.tool} busy={busy} onSave={onSave} />}
      {row.error && <p className="setup-error">{row.error}</p>}
    </li>
  )
}

function PathField({ tool, busy, onSave }: { tool: ToolName; busy: boolean; onSave: (text: string) => void }) {
  const [text, setText] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    onSave(text)
  }
  return (
    <form className="setup-field" onSubmit={submit}>
      <input
        className="input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={`Path to ${tool}`}
        aria-label={`Path to ${tool}`}
        spellCheck={false}
      />
      <button type="submit" className="btn sm" disabled={busy}>
        Save
      </button>
    </form>
  )
}
