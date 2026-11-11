// SPIKE ONLY. Appends each hook event to $OPENAFLOW_SPIKE_HOOKLOG/events.jsonl. Never blocks.
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
let input = ''
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', () => {
  const dir = process.env.OPENAFLOW_SPIKE_HOOKLOG
  if (!dir) return
  let p = {}
  try { p = JSON.parse(input) } catch {}
  mkdirSync(dir, { recursive: true })
  const { hook_event_name: event, session_id, transcript_path, source, notification_type, message, tool_name, prompt } = p
  appendFileSync(join(dir, 'events.jsonl'), JSON.stringify({ event, session_id, transcript_path, source, notification_type, message, tool_name, prompt, at: Date.now() }) + '\n')
})
