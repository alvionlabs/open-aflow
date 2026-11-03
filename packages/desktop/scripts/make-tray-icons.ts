// `pnpm --filter @pod-board/desktop exec tsx scripts/make-tray-icons.ts`: the tray's icons, from the app icon.
// The output is committed. tray-assets.test.ts checks that this script gives those same bytes.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const THIS_FILE = fileURLToPath(import.meta.url)
const pkg = join(dirname(THIS_FILE), '..')
const SOURCE = join(pkg, '..', 'web', 'public', 'icons', 'icon-512.png')
const TOKENS = join(pkg, '..', 'web', 'src', 'theme', 'tokens.css')
const SOURCE_SIZE = 512

export const TRAY_ICONS = [
  { name: 'tray.png', size: 16, dot: false },
  { name: 'tray@2x.png', size: 32, dot: false },
  { name: 'tray-dot.png', size: 16, dot: true },
  { name: 'tray-dot@2x.png', size: 32, dot: true },
]

/** The dot's size, as a part of the icon: its radius, and the clear ring that keeps it apart from the icon. */
const DOT_RADIUS = 0.22
const DOT_RING = 0.06

export function darkNeedsYou(css: string): string {
  const value = /\[data-theme="dark"\]\s*\{[^}]*--needs-you:\s*(#[0-9a-fA-F]{6})/.exec(css)?.[1]
  if (value === undefined) throw new Error('no dark --needs-you in tokens.css')
  return value.toLowerCase()
}

/** An integer box filter, weighted by alpha, so the result is exact on any machine. */
function shrink(source: PNG, size: number): PNG {
  const out = new PNG({ width: size, height: size })
  const block = SOURCE_SIZE / size
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let [r, g, b, a] = [0, 0, 0, 0]
      for (let sy = y * block; sy < (y + 1) * block; sy++) {
        for (let sx = x * block; sx < (x + 1) * block; sx++) {
          const i = (sy * SOURCE_SIZE + sx) * 4
          const alpha = source.data[i + 3]!
          r += source.data[i]! * alpha
          g += source.data[i + 1]! * alpha
          b += source.data[i + 2]! * alpha
          a += alpha
        }
      }
      const o = (y * size + x) * 4
      if (a > 0) {
        out.data[o] = Math.round(r / a)
        out.data[o + 1] = Math.round(g / a)
        out.data[o + 2] = Math.round(b / a)
      }
      out.data[o + 3] = Math.round(a / (block * block))
    }
  }
  return out
}

/** Hard edges, so each dot pixel is the token's exact color. */
function addDot(png: PNG, color: string): void {
  const size = png.width
  const radius = size * DOT_RADIUS
  const ring = radius + size * DOT_RING
  const center = size - radius
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(color.slice(at, at + 2), 16)) as [number, number, number]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x + 0.5 - center, y + 0.5 - center)
      if (distance > ring) continue
      const o = (y * size + x) * 4
      const inDot = distance <= radius
      png.data[o] = inDot ? r : 0
      png.data[o + 1] = inDot ? g : 0
      png.data[o + 2] = inDot ? b : 0
      png.data[o + 3] = inDot ? 255 : 0
    }
  }
}

export function renderTrayIcons(): Record<string, Buffer> {
  const source = PNG.sync.read(readFileSync(SOURCE))
  if (source.width !== SOURCE_SIZE || source.height !== SOURCE_SIZE) throw new Error(`the app icon must be ${SOURCE_SIZE} px`)
  const color = darkNeedsYou(readFileSync(TOKENS, 'utf8'))
  const out: Record<string, Buffer> = {}
  for (const { name, size, dot } of TRAY_ICONS) {
    const png = shrink(source, size)
    if (dot) addDot(png, color)
    // Stored, not compressed: zlib's output differs between Node versions, and these files are tiny.
    out[name] = PNG.sync.write(png, { deflateLevel: 0, filterType: 0, colorType: 6 })
  }
  return out
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === THIS_FILE) {
  const assets = join(pkg, 'assets')
  mkdirSync(assets, { recursive: true })
  for (const [name, bytes] of Object.entries(renderTrayIcons())) writeFileSync(join(assets, name), bytes)
  console.log(`pod-board: wrote the tray icons in ${assets}`)
}
