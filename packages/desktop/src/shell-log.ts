// The shell's log file: what the console shows, kept small, with no token and no home folder. The rules are in
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

/**
 * The text after the home folder makes it another folder: signs a folder name can hold, up to a letter or digit
 * (`Name2`, `Name+old`, `Name(2)`, `Name%20Smith`). A space, `,`, or `;` ends the path, and so does punctuation with no
 * letter or digit after it (`Name.`, `Name)`). A folder with a space can't be told from prose, so it swaps: a wrong swap
 * only mislabels a path, and a missed one leaks a name.
 */
const NAME_GOES_ON = '(?![^\\s\\\\/:*?"<>|,;]*[\\p{L}\\p{N}\\p{M}_])'
const SEPARATOR = '(?:[\\\\/]|%5C|%2F)+'

const percentEncoded = (char: string) => [...new TextEncoder().encode(char)].map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join('')

/** One character, plain or URL-encoded, as Node prints a stack frame's `file:///` URL. */
function charPattern(char: string): string {
  const plain = char.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
  if (/^[A-Za-z0-9_.~-]$/.test(char)) return plain
  const encoded = [...new Set([char, char.toLowerCase(), char.toUpperCase()])].map(percentEncoded)
  return `(?:${[plain, ...encoded].join('|')})`
}

/**
 * Finds the home folder in any spelling: any case, either slash, doubled backslashes as in JSON text, or URL-encoded.
 * Undefined with no home, or a drive root, which would match too much.
 */
function homePattern(home: string | undefined): RegExp | undefined {
  const parts = (home ?? '').split(/[\\/]+/).filter((part) => part !== '')
  if (parts.length < 2) return undefined
  const lead = /^[\\/]/.test(home!) ? SEPARATOR : ''
  const body = parts.map((part) => [...part].map(charPattern).join('')).join(SEPARATOR)
  return new RegExp(`${lead}${body}${NAME_GOES_ON}`, 'giu')
}

/** Each line for the file. The home folder holds the user's name, so it becomes `~`, before a cut can leave part of it. */
export function logLines(args: unknown[], home?: string): string[] {
  const pattern = homePattern(home)
  return args
    .map(wordOf)
    .join(' ')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => (pattern ? line.replace(pattern, () => '~') : line))
    .map((line) => (TOKEN.test(line) ? LEFT_OUT : line.slice(0, LINE_MAX)))
}

export function createLogFile(o: { file: string; fs: LogFs; now(): Date; maxBytes?: number; home?: string }): { write(args: unknown[]): void } {
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
        const lines = logLines(args, o.home)
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
