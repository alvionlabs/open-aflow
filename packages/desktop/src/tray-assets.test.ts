import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import { describe, expect, test } from 'vitest'
import { darkNeedsYou, renderTrayIcons, TRAY_ICONS } from '../scripts/make-tray-icons.ts'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
const tokens = readFileSync(join(pkg, '..', 'web', 'src', 'theme', 'tokens.css'), 'utf8')
const assetPath = (name: string) => join(pkg, 'assets', name)
const committed = (name: string) => readFileSync(assetPath(name))

const hex = (n: number) => n.toString(16).padStart(2, '0')
const pixelAt = (png: PNG, x: number, y: number) => {
  const i = (y * png.width + x) * 4
  return { color: `#${hex(png.data[i]!)}${hex(png.data[i + 1]!)}${hex(png.data[i + 2]!)}`, alpha: png.data[i + 3]! }
}
const pixelsOf = (png: PNG, color: string) => {
  let n = 0
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const p = pixelAt(png, x, y)
      if (p.color === color && p.alpha === 255) n++
    }
  }
  return n
}

describe('tray icons', () => {
  test('tray icons come from the app icon', () => {
    const color = darkNeedsYou(tokens)
    expect(color).toBe('#f5a623')
    expect(TRAY_ICONS).toEqual([
      { name: 'tray.png', size: 16, dot: false },
      { name: 'tray@2x.png', size: 32, dot: false },
      { name: 'tray-dot.png', size: 16, dot: true },
      { name: 'tray-dot@2x.png', size: 32, dot: true },
    ])

    const rendered = renderTrayIcons()
    const again = renderTrayIcons()
    for (const { name, size, dot } of TRAY_ICONS) {
      expect(existsSync(assetPath(name)), name).toBe(true)
      // Each icon has its size.
      const png = PNG.sync.read(committed(name))
      expect([png.width, png.height], name).toEqual([size, size])
      // Running the script again gives the same bytes, also on another Node's zlib.
      expect(rendered[name]!.equals(again[name]!), name).toBe(true)
      expect(rendered[name]!.equals(committed(name)), name).toBe(true)
      if (dot) {
        // The dot sits in the bottom-right corner, in the token's exact color.
        expect(pixelAt(png, size - 4, size - 4), name).toEqual({ color, alpha: 255 })
        expect(pixelsOf(png, color), name).toBeGreaterThanOrEqual(size === 16 ? 20 : 80)
      } else {
        expect(pixelsOf(png, color), name).toBe(0)
      }
    }
  })

  test('the dot changes only its own corner', () => {
    for (const [plain, withDot, size] of [['tray.png', 'tray-dot.png', 16], ['tray@2x.png', 'tray-dot@2x.png', 32]] as const) {
      expect(existsSync(assetPath(plain)), plain).toBe(true)
      const a = PNG.sync.read(committed(plain))
      const b = PNG.sync.read(committed(withDot))
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (x >= size / 2 && y >= size / 2) continue
          expect(pixelAt(b, x, y), `${plain} ${x},${y}`).toEqual(pixelAt(a, x, y))
        }
      }
    }
  })

  test('the icon comes from the app icon, at its colors', () => {
    expect(existsSync(assetPath('tray@2x.png'))).toBe(true)
    const png = PNG.sync.read(committed('tray@2x.png'))
    // The app icon's rounded corner is clear, and its upper area is its plain blue.
    expect(pixelAt(png, 0, 0).alpha).toBe(0)
    const source = PNG.sync.read(readFileSync(join(pkg, '..', 'web', 'public', 'icons', 'icon-512.png')))
    expect(pixelAt(png, 16, 5)).toEqual(pixelAt(source, 256, 88))
  })

  test('the dark value is read from the dark block, not the light one', () => {
    expect(darkNeedsYou(':root { --needs-you: #111111; } [data-theme="dark"] { --x: 1; --needs-you: #222222; }')).toBe('#222222')
    expect(() => darkNeedsYou(':root { --needs-you: #111111; }')).toThrow(/needs-you/)
  })
})
