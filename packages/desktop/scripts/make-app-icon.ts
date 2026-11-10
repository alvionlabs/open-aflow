// `pnpm --filter @openaflow/desktop exec tsx scripts/make-app-icon.ts`: the exe and installer icon, from the app icon.
// The output is committed. app-icon.test.ts checks that this script gives those same bytes.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const THIS_FILE = fileURLToPath(import.meta.url)
const pkg = join(dirname(THIS_FILE), '..')
const SOURCE = join(pkg, '..', 'web', 'public', 'icons', 'icon-512.png')
const SOURCE_SIZE = 512
const PNG_FROM = 256

export const APP_ICON_SIZES = [16, 32, 48, 256]

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))

/** An area filter, weighted by alpha, in integers up to the last division, so the result is exact on any machine. */
function shrink(source: Buffer, size: number): Buffer {
  const out = Buffer.alloc(size * size * 4)
  const shared = gcd(SOURCE_SIZE, size)
  // One source pixel is `unit` wide on a grid that both sizes fit, and one output pixel is `span` wide.
  const unit = size / shared
  const span = SOURCE_SIZE / shared
  const overlap = (at: number, start: number) => Math.min((at + 1) * unit, start + span) - Math.max(at * unit, start)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [left, top] = [x * span, y * span]
      let [r, g, b, a] = [0, 0, 0, 0]
      for (let sy = Math.floor(top / unit); sy * unit < top + span; sy++) {
        for (let sx = Math.floor(left / unit); sx * unit < left + span; sx++) {
          const i = (sy * SOURCE_SIZE + sx) * 4
          const weight = overlap(sx, left) * overlap(sy, top) * source[i + 3]!
          r += source[i]! * weight
          g += source[i + 1]! * weight
          b += source[i + 2]! * weight
          a += weight
        }
      }
      const o = (y * size + x) * 4
      if (a > 0) {
        out[o] = Math.round(r / a)
        out[o + 1] = Math.round(g / a)
        out[o + 2] = Math.round(b / a)
      }
      out[o + 3] = Math.round(a / (span * span))
    }
  }
  return out
}

/** A 32-bit BMP entry: BGRA from the bottom row up, then an all-zero mask, as the alpha channel carries the shape. */
function bmpEntry(rgba: Buffer, size: number): Buffer {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8)
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(size * size * 4, 20)
  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4
      const to = ((size - 1 - y) * size + x) * 4
      pixels[to] = rgba[from + 2]!
      pixels[to + 1] = rgba[from + 1]!
      pixels[to + 2] = rgba[from]!
      pixels[to + 3] = rgba[from + 3]!
    }
  }
  const maskRow = Math.ceil(size / 32) * 4
  return Buffer.concat([header, pixels, Buffer.alloc(maskRow * size)])
}

/** Stored, not compressed: zlib's output differs between Node versions. */
function pngEntry(rgba: Buffer, size: number): Buffer {
  const png = new PNG({ width: size, height: size })
  rgba.copy(png.data)
  return PNG.sync.write(png, { deflateLevel: 0, filterType: 0, colorType: 6 })
}

export function renderAppIcon(): Buffer {
  const source = PNG.sync.read(readFileSync(SOURCE))
  if (source.width !== SOURCE_SIZE || source.height !== SOURCE_SIZE) throw new Error(`the app icon must be ${SOURCE_SIZE} px`)
  const images = APP_ICON_SIZES.map((size) => {
    const rgba = shrink(source.data, size)
    return { size, bytes: size >= PNG_FROM ? pngEntry(rgba, size) : bmpEntry(rgba, size) }
  })

  const head = Buffer.alloc(6 + images.length * 16)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(images.length, 4)
  let offset = head.length
  images.forEach(({ size, bytes }, i) => {
    const at = 6 + i * 16
    head[at] = size === 256 ? 0 : size
    head[at + 1] = size === 256 ? 0 : size
    head.writeUInt16LE(1, at + 4)
    head.writeUInt16LE(32, at + 6)
    head.writeUInt32LE(bytes.length, at + 8)
    head.writeUInt32LE(offset, at + 12)
    offset += bytes.length
  })
  return Buffer.concat([head, ...images.map((image) => image.bytes)])
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === THIS_FILE) {
  const target = join(pkg, 'assets', 'icon.ico')
  writeFileSync(target, renderAppIcon())
  console.log(`openaflow: wrote ${target}`)
}
