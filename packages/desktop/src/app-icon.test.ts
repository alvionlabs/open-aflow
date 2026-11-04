import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import { describe, expect, test } from 'vitest'
import { APP_ICON_SIZES, renderAppIcon } from '../scripts/make-app-icon.ts'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
const ICON = join(pkg, 'assets', 'icon.ico')
const SOURCE = join(pkg, '..', 'web', 'public', 'icons', 'icon-512.png')

type Entry = { size: number; bytes: Buffer }

function parseIco(ico: Buffer): Entry[] {
  expect(ico.readUInt16LE(0)).toBe(0)
  expect(ico.readUInt16LE(2)).toBe(1)
  const entries: Entry[] = []
  for (let i = 0; i < ico.readUInt16LE(4); i++) {
    const at = 6 + i * 16
    const offset = ico.readUInt32LE(at + 12)
    entries.push({ size: ico[at]! === 0 ? 256 : ico[at]!, bytes: ico.subarray(offset, offset + ico.readUInt32LE(at + 8)) })
  }
  return entries
}

const isPng = (b: Buffer) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))

/** Stored deflate blocks only, so the bytes don't depend on Node's zlib. BTYPE sits in the first block's header. */
const isStoredPng = (b: Buffer) => (b[b.indexOf('IDAT') + 4 + 2]! & 0b110) === 0

describe('app icon', () => {
  test('icon sizes and repeatable bytes', () => {
    expect(APP_ICON_SIZES).toEqual([16, 32, 48, 256])
    expect(existsSync(ICON)).toBe(true)
    const committed = readFileSync(ICON)
    expect(parseIco(committed).map((e) => e.size)).toEqual([16, 32, 48, 256])
    expect(renderAppIcon().equals(committed)).toBe(true)
    expect(renderAppIcon().equals(renderAppIcon())).toBe(true)
  })

  test('each image is an uncompressed BMP or a stored PNG', () => {
    const entries = parseIco(renderAppIcon())
    expect(entries).toHaveLength(4)
    for (const { size, bytes } of entries) {
      if (isPng(bytes)) {
        expect(isStoredPng(bytes), `${size}`).toBe(true)
        const png = PNG.sync.read(Buffer.from(bytes))
        expect([png.width, png.height]).toEqual([size, size])
      } else {
        expect(bytes.readUInt32LE(0), `${size}`).toBe(40)
        expect(bytes.readInt32LE(4)).toBe(size)
        expect(bytes.readInt32LE(8)).toBe(size * 2)
        expect(bytes.readUInt16LE(14)).toBe(32)
        expect(bytes.readUInt32LE(16)).toBe(0)
      }
    }
  })

  test('the images come from the app icon', () => {
    const source = PNG.sync.read(readFileSync(SOURCE))
    const at = (x: number, y: number) => [...source.data.subarray((y * 512 + x) * 4, (y * 512 + x) * 4 + 4)]
    const entries = parseIco(renderAppIcon())
    expect(entries).toHaveLength(4)

    // The 256 image's corner is clear, and its upper area is the source's plain color.
    const big = PNG.sync.read(Buffer.from(entries.find((e) => e.size === 256)!.bytes))
    expect(big.data[3]).toBe(0)
    expect([...big.data.subarray((44 * 256 + 128) * 4, (44 * 256 + 128) * 4 + 4)]).toEqual(at(256, 88))

    // 48 isn't a whole-number share of 512, so this size proves the resample. Bottom-up BGRA, after the 40-byte header.
    const small = entries.find((e) => e.size === 48)!.bytes
    const pixel = (x: number, y: number) => {
      const o = 40 + ((47 - y) * 48 + x) * 4
      return [small[o + 2], small[o + 1], small[o], small[o + 3]]
    }
    expect(pixel(0, 0)[3]).toBe(0)
    expect(pixel(24, 8)).toEqual(at(256, 88))
  })
})
