import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const web = join(dirname(fileURLToPath(import.meta.url)), '..')
const pub = join(web, 'public')

const html = () => readFileSync(join(web, 'index.html'), 'utf8')

describe('no install offer', () => {
  it('index.html links no manifest and no touch icon, and names no other host', () => {
    expect(html()).not.toMatch(/rel="manifest"/)
    expect(html()).not.toMatch(/apple-touch-icon/)
    expect(html()).not.toMatch(/(https?:)?\/\/[\w.-]+/i)
  })

  it('public/ has no manifest file, so the server has nothing to serve at /manifest.webmanifest', () => {
    expect(existsSync(join(pub, 'manifest.webmanifest'))).toBe(false)
    expect(readdirSync(pub).filter((n) => /manifest/i.test(n))).toEqual([])
  })

  it('keeps the icons other code reads, and drops the one only the manifest used', () => {
    // icon-512 is the desktop app and tray icon source; icon-192 is the tab icon.
    expect(existsSync(join(pub, 'icons/icon-512.png'))).toBe(true)
    expect(existsSync(join(pub, 'icons/icon-192.png'))).toBe(true)
    expect(existsSync(join(pub, 'icons/icon-maskable-512.png'))).toBe(false)
    expect(html()).toMatch(/<link rel="icon"[^>]*href="\/icons\/icon-192\.png"/)
  })
})

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return cssFiles(p)
    return name.endsWith('.css') ? [p] : []
  })
}

describe('screens use only tokens', () => {
  it('screen CSS has no hex, rgb, or hsl colour literal', () => {
    expect(existsSync(join(web, 'src/screens'))).toBe(true)
    const files = cssFiles(join(web, 'src/screens'))
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      const css = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
      expect(css, f).not.toMatch(/#[0-9a-f]{3,8}\b/i)
      expect(css, f).not.toMatch(/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i)
    }
  })
})
