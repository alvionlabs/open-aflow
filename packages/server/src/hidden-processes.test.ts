import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

// A process started with no `windowsHide` opens a console window when its parent has none, as under a test
// run from an agent or the desktop shell. This scan reads the source as text: it finds each call of a function a
// file imports from `child_process`, or starts inside a helper script a test writes, and needs `windowsHide` in the call.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const FOLDERS = ['packages/server/src', 'packages/server/scripts', 'packages/desktop/src', 'packages/desktop/scripts']
const SOURCE = /\.(?:ts|tsx|mjs|cjs|js)$/
const STARTS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'])
/** A call's own text is at most this long; past it the scan can't find the call's end, and says so. */
const CALL_MAX = 1500
/** Options built just above the call, each with `windowsHide` in the file: the call only spreads them. */
const SPREADS = ['...opts', '...options']

/**
 * Files that start the app's own windowed exe. It has no console to open, and `windowsHide` starts it with SW_HIDE,
 * which Windows applies to its first ShowWindow: the window never shows. Only here may a call say `windowsHide: false`.
 */
const WINDOWED = ['packages/desktop/src/install-check.ts', 'packages/desktop/src/real-toast.test.ts']

/** The names a file imports from `child_process`, in an import line or a helper's text. */
function startNames(text: string): string[] {
  const names = new Set<string>()
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](?:node:)?child_process['"]/g)) {
    for (const part of m[1]!.split(',')) {
      const [name, alias] = part.trim().split(/\s+as\s+/)
      if (STARTS.has(name!)) names.add(alias ?? name!)
    }
  }
  return [...names]
}

/** Each call with no `windowsHide`, as `name at line N`. Brackets count from the call's own `(`. */
function unhiddenStarts(text: string, windowed = false): string[] {
  const out: string[] = []
  const names = startNames(text)
  if (names.length === 0) return out
  for (const m of text.matchAll(new RegExp(`(?<![.\\w])(${names.join('|')})\\(`, 'g'))) {
    const start = m.index + m[0].length
    let depth = 1
    let end = start
    while (depth > 0 && end < text.length && end - start < CALL_MAX) {
      if (text[end] === '(') depth++
      if (text[end] === ')') depth--
      end++
    }
    const call = text.slice(start, end)
    const hidden = depth === 0 && (call.includes('windowsHide: true') || (windowed && call.includes('windowsHide: false')) || (SPREADS.some((s) => call.includes(s)) && text.includes('windowsHide: true')))
    if (!hidden) out.push(`${m[1]} at line ${text.slice(0, m.index).split('\n').length}`)
  }
  return out
}

function sources(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' || name === 'dist' || name === 'out' ? [] : sources(path)
    return SOURCE.test(name) ? [path] : []
  })
}

describe('every process start hides its window', () => {
  test('the scan finds a call with no windowsHide, and passes one with it', () => {
    const head = "import { spawn, spawnSync as run, type ChildProcess } from 'node:child_process'\n"
    expect(unhiddenStarts(`${head}spawn(a, [b], { stdio: 'ignore' })`)).toEqual(['spawn at line 2'])
    expect(unhiddenStarts(`${head}\n\nrun(a, ['-e', 'f(1)'])`)).toEqual(['run at line 4'])
    expect(unhiddenStarts(`${head}spawn(a, [b], { windowsHide: true })`)).toEqual([])
    // Not a process start: a method of the same name, or a file with no such import.
    expect(unhiddenStarts(`${head}pool.spawn(a)`)).toEqual([])
    expect(unhiddenStarts('spawn(a)')).toEqual([])
    // A call whose end it can't find counts as not hidden.
    expect(unhiddenStarts(`${head}spawn('(', { windowsHide: true })`)).toEqual(['spawn at line 2'])
    // A helper script a test writes, as text, is read the same way.
    expect(unhiddenStarts(`"import { spawn } from 'node:child_process'",\n"const c = spawn(a, [b], { env })"`)).toEqual(['spawn at line 2'])
    // `windowsHide: false` counts only in a file that starts the app's own exe.
    expect(unhiddenStarts(`${head}spawn(a, [b], { windowsHide: false })`)).toEqual(['spawn at line 2'])
    expect(unhiddenStarts(`${head}spawn(a, [b], { windowsHide: false })`, true)).toEqual([])
    expect(unhiddenStarts(`${head}spawn(a, [b])`, true)).toEqual(['spawn at line 2'])
  })

  test('none in the server or the desktop shell, or in their tests and scripts', () => {
    const found = FOLDERS.flatMap((f) => sources(join(ROOT, f)))
      .filter((path) => !path.endsWith('hidden-processes.test.ts'))
      .flatMap((path) => {
        const name = relative(ROOT, path).replaceAll('\\', '/')
        return unhiddenStarts(readFileSync(path, 'utf8'), WINDOWED.includes(name)).map((hit) => `${name}: ${hit}`)
      })
    expect(found).toEqual([])
  })

  test("the install proof starts the app's exe with its window able to show", () => {
    // Hidden, the proof's window check times out on a sound app, and its check that a login start shows no window means nothing.
    const text = readFileSync(join(ROOT, 'packages/desktop/src/install-check.ts'), 'utf8')
    expect(text).toMatch(/spawn\(join\(place\.installDir, EXE_NAME\), args, \{[^}]*windowsHide: false[^}]*\}\)/)
  })
})
