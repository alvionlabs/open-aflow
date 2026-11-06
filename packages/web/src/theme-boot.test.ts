import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { THEME_KEY } from './theme/theme.ts'

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8')

/** Every `<script>` tag in index.html, in order, with its attributes and body. */
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].map((m) => ({
  attrs: m[1]!,
  body: m[2]!,
  at: m.index,
}))
const inline = scripts.filter((s) => !/\bsrc\s*=/.test(s.attrs))
const moduleScript = scripts.find((s) => /type\s*=\s*["']module["']/.test(s.attrs) && /\bsrc\s*=/.test(s.attrs))

type Calls = [string, ...string[]][]

/** Runs the boot script against a fake root and a storage reached through `get` (which may throw). */
function boot(get: () => { getItem(key: string): string | null } | null): Calls {
  const calls: Calls = []
  const documentElement = {
    setAttribute: (name: string, value: string) => void calls.push(['set', name, value]),
    removeAttribute: (name: string) => void calls.push(['remove', name]),
  }
  const window = {} as Record<string, unknown>
  Object.defineProperty(window, 'localStorage', { get })
  const context = { window, document: { documentElement } }
  Object.defineProperty(context, 'localStorage', { get })
  runInNewContext(inline[0]!.body, context)
  return calls
}

const store = (values: Record<string, string>) => () => ({ getItem: (k: string) => values[k] ?? null })

describe('theme boot', () => {
  it('applies the stored theme before render', () => {
    expect(inline).toHaveLength(1)
    expect(moduleScript).toBeDefined()
    // It runs before the module script, in the head, and loads nothing.
    expect(inline[0]!.at).toBeLessThan(moduleScript!.at)
    expect(inline[0]!.at).toBeLessThan(html.indexOf('</head>'))
    expect(inline[0]!.body).not.toMatch(/https?:|\/\/|import\s*\(/)
    // It reads THEME_KEY, by that exact name.
    expect(inline[0]!.body).toMatch(new RegExp(`['"]${THEME_KEY}['"]`))

    // A stored Light or Dark pick is applied as is.
    expect(boot(store({ [THEME_KEY]: 'dark' }))).toEqual([['set', 'data-theme', 'dark']])
    expect(boot(store({ [THEME_KEY]: 'light' }))).toEqual([['set', 'data-theme', 'light']])

    // System sets nothing, so the media query decides.
    expect(boot(store({ [THEME_KEY]: 'system' }))).toEqual([])

    // The first load after the rename paints the pick stored under the old key; the new key wins when both are set.
    const OLD_KEY = 'pod-board-theme'
    expect(boot(store({ [OLD_KEY]: 'light' }))).toEqual([['set', 'data-theme', 'light']])
    expect(boot(store({ [OLD_KEY]: 'system' }))).toEqual([])
    expect(boot(store({ [OLD_KEY]: 'light', [THEME_KEY]: 'dark' }))).toEqual([['set', 'data-theme', 'dark']])

    // Nothing usable stored: dark, the default.
    const dark = [['set', 'data-theme', 'dark']]
    expect(boot(store({}))).toEqual(dark)
    expect(boot(store({ [THEME_KEY]: 'blue' }))).toEqual(dark)
    expect(boot(store({ [THEME_KEY]: 'Light' }))).toEqual(dark)
    expect(boot(store({ [THEME_KEY]: '' }))).toEqual(dark)
    expect(boot(store({ theme: 'light' }))).toEqual(dark)
    expect(boot(() => null)).toEqual(dark)

    // Storage that throws, on access or on read: dark, and no error.
    expect(
      boot(() => {
        throw new Error('blocked')
      }),
    ).toEqual(dark)
    expect(
      boot(() => ({
        getItem: () => {
          throw new Error('denied')
        },
      })),
    ).toEqual(dark)
  })

  it('paints the stored theme before the app CSS loads', () => {
    // In dev, Vite injects the CSS from the module script, so until then the browser's own
    // canvas shows. color-scheme follows data-theme (and the system) so a Dark pick paints dark.
    const head = html.slice(0, html.indexOf('</head>'))
    expect(head).toMatch(/<meta\s+name="color-scheme"\s+content="light dark"\s*\/?>/)
    const style = [...head.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]!).join('\n')
    expect(style).toMatch(/:root\[data-theme="dark"\]\s*\{\s*color-scheme:\s*dark;?\s*\}/)
    expect(style).toMatch(/:root\[data-theme="light"\]\s*\{\s*color-scheme:\s*light;?\s*\}/)
    // No colours outside the theme files.
    expect(style).not.toMatch(/#[0-9a-f]{3,8}\b|rgb|hsl/i)
    // The browser's own bar matches the page: black in dark, white in light.
    expect(head).toMatch(/<meta name="theme-color" media="\(prefers-color-scheme: dark\)" content="#000000"/)
    expect(head).toMatch(/<meta name="theme-color" media="\(prefers-color-scheme: light\)" content="#ffffff"/)
    // The body face is fetched early, and from the app.
    expect(head).toMatch(/<link rel="preload" href="\/fonts\/geist-400\.woff2" as="font" type="font\/woff2" crossorigin \/>/)
  })
})
