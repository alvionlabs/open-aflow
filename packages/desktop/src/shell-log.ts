// The shell's log file: what the console shows, kept small, with no entry text and no token. The rules are in
// pod-docs/feature-details/desktop.md.

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

export const LOG_FILE = 'desktop.log'
/** One file up to about this size, and one old file: at most about 512 KB. */
export const LOG_MAX_BYTES = 256 * 1024
const LINE_MAX = 500
const TOKEN = /token/i
const LEFT_OUT = '[left out: names a token]'

export type LogFs = { size(file: string): number; append(file: string, text: string): void; rename(from: string, to: string): void }

export const nodeLogFs: LogFs = {
  size: (file) => statSync(file).size,
  append: (file, text) => {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, text)
  },
  rename: (from, to) => renameSync(from, to),
}

/** An error keeps only its name, because its message can hold what the app read. Other values keep only their type. */
const wordOf = (arg: unknown): string => {
  if (typeof arg === 'string') return arg
  if (arg instanceof Error) return arg.name
  return `[${typeof arg}]`
}

export function logLines(args: unknown[]): string[] {
  return args
    .map(wordOf)
    .join(' ')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => (TOKEN.test(line) ? LEFT_OUT : line.slice(0, LINE_MAX)))
}

export function createLogFile(o: { file: string; fs: LogFs; now(): Date; maxBytes?: number }): { write(args: unknown[]): void } {
  const maxBytes = o.maxBytes ?? LOG_MAX_BYTES
  const sizeOf = () => {
    try {
      return o.fs.size(o.file)
    } catch {
      return 0 // no file yet
    }
  }
  return {
    write(args) {
      // A log must never stop the app.
      try {
        const stamp = o.now().toISOString()
        const lines = logLines(args)
        if (lines.length === 0) return
        if (sizeOf() >= maxBytes) o.fs.rename(o.file, `${o.file}.1`)
        o.fs.append(o.file, lines.map((line) => `${stamp} ${line}\n`).join(''))
      } catch {
        // Nothing more to do: the console still has the line.
      }
    },
  }
}

type ConsoleLike = Pick<Console, 'log' | 'error' | 'warn'>

/** Each console line also goes to the file. The console itself keeps working as before. */
export function teeConsole(target: ConsoleLike, file: { write(args: unknown[]): void }): void {
  for (const method of ['log', 'error', 'warn'] as const) {
    const original = target[method].bind(target)
    target[method] = (...args: unknown[]) => {
      original(...args)
      file.write(args)
    }
  }
}
