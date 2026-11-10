// Two real continued pod agents from openaflow's /pod:fix run fix-show-fix-runs (PR #23), as
// shapes only: record types, timestamps, the isMeta and origin flags, block types, and the
// SubagentHandback name, in file order. Every text is a placeholder; the first prompt is a made-up
// dispatch in the real field shape, so the agents join their fix run. Cut from the transcripts of
// agents a0b2da9a7a9669669 (pod:reviewer: round 1, then continued for round 2) and
// a31b714fcabe030d3 (pod:engineer: the build, then continued for the fix pass, then again).
// The fix pass (18:19–18:54) keeps six padding tool results, one every 5 minutes, so its active time
// reads as the real transcript's (34.7 min): the cut left gaps longer than the idle-gap rule allows.

type Rec = { type: string; timestamp: string; message: { content: unknown } & Record<string, unknown> } & Record<string, unknown>

const REVIEWER_DISPATCH = ['kind: fix', 'round: 1', 'PR: https://github.com/o/r/pull/23', 'Branch: fix-show-fix-runs', 'Merge-target: pod-staging'].join('\n')
const ENGINEER_DISPATCH = ['Standalone /pod:fix slice.', '', '- Merge target: pod-staging', '- Branch: fix-show-fix-runs'].join('\n')

const withDispatch = (recs: Rec[], prompt: string): Rec[] =>
  recs.map((r, i) => (i === 0 ? { ...r, message: { ...r.message, content: prompt } } : r))

export const CONTINUED_REVIEWER: Rec[] = withDispatch([
  {"type":"user","timestamp":"2026-10-20T18:10:36.702Z","message":{"role":"user","content":"PROMPT"}},
  {"type":"user","timestamp":"2026-10-20T18:10:36.719Z","isMeta":true,"message":{"role":"user","content":"PROMPT"}},
  {"type":"assistant","timestamp":"2026-10-20T18:10:39.758Z","message":{"id":"msg_14","model":"claude-opus-5-5","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":10},"content":[{"type":"text","text":"TEXT"}]}},
  {"type":"assistant","timestamp":"2026-10-20T18:18:50.743Z","message":{"id":"msg_176","model":"claude-opus-5-5","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":10},"content":[{"type":"tool_use","id":"toolu_176","name":"Bash","input":{}}]}},
  {"type":"assistant","timestamp":"2026-10-20T18:19:26.620Z","message":{"id":"msg_182","model":"claude-opus-5-5","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":10},"content":[{"type":"tool_use","id":"toolu_182","name":"SubagentHandback","input":{}}]}},
  {"type":"user","timestamp":"2026-10-20T18:19:26.924Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_x","content":"RESULT"}]}},
  {"type":"user","timestamp":"2026-10-20T18:55:27.483Z","isMeta":true,"origin":{"kind":"coordinator"},"message":{"role":"user","content":"PROMPT"}},
  {"type":"assistant","timestamp":"2026-10-20T18:55:34.542Z","message":{"id":"msg_187","model":"claude-opus-5-5","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":10},"content":[{"type":"text","text":"TEXT"}]}},
  {"type":"assistant","timestamp":"2026-10-20T19:01:45.260Z","message":{"id":"msg_274","model":"claude-opus-5-5","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":10},"content":[{"type":"tool_use","id":"toolu_274","name":"Bash","input":{}}]}},
  {"type":"assistant","timestamp":"2026-10-20T19:02:11.630Z","message":{"id":"msg_280","model":"claude-opus-5-5","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":10},"content":[{"type":"tool_use","id":"toolu_280","name":"SubagentHandback","input":{}}]}},
  {"type":"user","timestamp":"2026-10-20T19:02:11.904Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_x","content":"RESULT"}]}},
  {"type":"assistant","timestamp":"2026-10-20T19:02:27.036Z","message":{"id":"msg_287","model":"claude-opus-5-5","stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":10},"content":[{"type":"text","text":"TEXT"}]}},
], REVIEWER_DISPATCH)

export const CONTINUED_ENGINEER: Rec[] = withDispatch([
  {"type":"user","timestamp":"2026-10-20T17:25:53.517Z","message":{"role":"user","content":"PROMPT"}},
  {"type":"user","timestamp":"2026-10-20T17:25:53.540Z","isMeta":true,"message":{"role":"user","content":"PROMPT"}},
  {"type":"assistant","timestamp":"2026-10-20T17:26:02.986Z","message":{"id":"msg_16","model":"claude-opus-5-5","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":10},"content":[{"type":"text","text":"TEXT"}]}},
  {"type":"assistant","timestamp":"2026-10-20T18:08:09.142Z","message":{"id":"msg_1000","model":"claude-opus-5-5","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":10},"content":[{"type":"tool_use","id":"toolu_1000","name":"Bash","input":{}}]}},
  {"type":"assistant","timestamp":"2026-10-20T18:08:49.831Z","message":{"id":"msg_1006","model":"claude-opus-5-5","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":10},"content":[{"type":"tool_use","id":"toolu_1006","name":"SubagentHandback","input":{}}]}},
  {"type":"user","timestamp":"2026-10-20T18:08:50.152Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_x","content":"RESULT"}]}},
  {"type":"user","timestamp":"2026-10-20T18:19:37.869Z","isMeta":true,"origin":{"kind":"coordinator"},"message":{"role":"user","content":"PROMPT"}},
  {"type":"assistant","timestamp":"2026-10-20T18:19:41.534Z","message":{"id":"msg_1011","model":"claude-opus-5-5","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":10},"content":[{"type":"text","text":"TEXT"}]}},
  {"type":"user","timestamp":"2026-10-20T18:25:00.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_pad","content":"RESULT"}]}},
  {"type":"user","timestamp":"2026-10-20T18:30:00.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_pad","content":"RESULT"}]}},
  {"type":"user","timestamp":"2026-10-20T18:35:00.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_pad","content":"RESULT"}]}},
  {"type":"user","timestamp":"2026-10-20T18:40:00.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_pad","content":"RESULT"}]}},
  {"type":"user","timestamp":"2026-10-20T18:45:00.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_pad","content":"RESULT"}]}},
  {"type":"user","timestamp":"2026-10-20T18:50:00.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_pad","content":"RESULT"}]}},
  {"type":"assistant","timestamp":"2026-10-20T18:53:58.739Z","message":{"id":"msg_1220","model":"claude-opus-5-5","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":10},"content":[{"type":"tool_use","id":"toolu_1220","name":"Bash","input":{}}]}},
  {"type":"assistant","timestamp":"2026-10-20T18:54:18.835Z","message":{"id":"msg_1225","model":"claude-opus-5-5","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":10},"content":[{"type":"tool_use","id":"toolu_1225","name":"SubagentHandback","input":{}}]}},
  {"type":"user","timestamp":"2026-10-20T18:54:19.144Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_x","content":"RESULT"}]}},
  {"type":"user","timestamp":"2026-10-20T23:37:19.588Z","isMeta":true,"origin":{"kind":"coordinator"},"message":{"role":"user","content":"PROMPT"}},
  {"type":"assistant","timestamp":"2026-10-20T23:37:23.780Z","message":{"id":"msg_1229","model":"claude-opus-5-5","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":10},"content":[{"type":"text","text":"TEXT"}]}},
  {"type":"assistant","timestamp":"2026-10-20T23:39:00.573Z","message":{"id":"msg_1267","model":"claude-opus-5-5","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":10},"content":[{"type":"tool_use","id":"toolu_1267","name":"Bash","input":{}}]}},
], ENGINEER_DISPATCH)

/** The transcript as it stood at `at` (ISO time): the records written by then, as JSONL. */
export const jsonlAt = (recs: Rec[], at: string): string =>
  recs.filter((r) => Date.parse(r.timestamp) <= Date.parse(at)).map((r) => JSON.stringify(r)).join('\n') + '\n'
