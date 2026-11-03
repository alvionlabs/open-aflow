import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { DEFAULT_STATE, readWindowState, saveWindowState } from './window-state.ts'

const DISPLAYS = [{ x: 0, y: 0, width: 1920, height: 1040 }]

describe('window state', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'pod-board-state-')))
    file = join(dir, 'window-state.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const readWith = (text: string, displays = DISPLAYS) => {
    writeFileSync(file, text)
    return readWindowState(file, displays)
  }
  const saved = (o: object) => JSON.stringify({ x: 100, y: 100, width: 1000, height: 700, maximized: false, ...o })

  test('reads the window state', () => {
    expect(DEFAULT_STATE).toEqual({ width: 1280, height: 800, maximized: false })
    // Missing, and bad JSON.
    expect(readWindowState(file, DISPLAYS)).toEqual(DEFAULT_STATE)
    expect(readWith('{not json')).toEqual(DEFAULT_STATE)
    // Bad numbers. More cases are in the next test.
    expect(readWith(saved({ width: 'wide' }))).toEqual(DEFAULT_STATE)
    // Off-screen.
    expect(readWith(saved({ x: 5000, y: 100 }))).toEqual(DEFAULT_STATE)
    // On a display: reads back.
    expect(readWith(saved({}))).toEqual({ x: 100, y: 100, width: 1000, height: 700, maximized: false })
    // Below the minimum: rises to it.
    expect(readWith(saved({ width: 300, height: 200 }))).toEqual({ x: 100, y: 100, width: 800, height: 600, maximized: false })
  })

  test('other JSON and bad numbers read as the default', () => {
    for (const text of ['null', '5', '[]', '"x"', '{}']) expect(readWith(text), text).toEqual(DEFAULT_STATE)
    for (const bad of [{ x: 'a' }, { y: null }, { width: '1000' }, { height: true }, { width: 0 }, { height: -5 }, { width: 1e999 }, { x: 1e999 }, { width: 1e9 }]) {
      expect(readWith(saved(bad)), JSON.stringify(bad)).toEqual(DEFAULT_STATE)
    }
  })

  test('a window keeps its place only while enough of it shows', () => {
    // A corner of 100 x 50 on a display is enough to grab.
    expect(readWith(saved({ x: 1820, y: 990 }))).toMatchObject({ x: 1820, y: 990 })
    expect(readWith(saved({ x: 1821, y: 990 }))).toEqual(DEFAULT_STATE)
    expect(readWith(saved({ x: 1820, y: 991 }))).toEqual(DEFAULT_STATE)
    // No displays: nothing is on one.
    expect(readWith(saved({}), [])).toEqual(DEFAULT_STATE)
  })

  test('a window on a second display reads back while that display is there', () => {
    const left = { x: -1920, y: 0, width: 1920, height: 1040 }
    expect(readWith(saved({ x: -1500 }), [...DISPLAYS, left])).toMatchObject({ x: -1500 })
    expect(readWith(saved({ x: -1500 }), DISPLAYS)).toEqual(DEFAULT_STATE)
  })

  test('fractions round, and maximized is a plain yes or no', () => {
    expect(readWith(saved({ x: 100.4, width: 1000.6 }))).toMatchObject({ x: 100, width: 1001 })
    expect(readWith(saved({ maximized: true }))).toMatchObject({ maximized: true })
    expect(readWith(saved({ maximized: 'yes' }))).toMatchObject({ maximized: false })
  })

  test('saves and reads back', () => {
    saveWindowState(file, { x: -10, y: 20, width: 900, height: 650, maximized: true })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ x: -10, y: 20, width: 900, height: 650, maximized: true })
    expect(readWindowState(file, [{ x: -100, y: 0, width: 1920, height: 1040 }])).toEqual({ x: -10, y: 20, width: 900, height: 650, maximized: true })
  })

  test('a failed save never throws', () => {
    writeFileSync(file, 'a file, not a folder')
    expect(() => saveWindowState(join(file, 'inner', 'window-state.json'), { x: 0, y: 0, width: 900, height: 650, maximized: false })).not.toThrow()
  })

  test('a save makes its folder', () => {
    const inner = join(dir, 'new', 'window-state.json')
    saveWindowState(inner, { x: 0, y: 0, width: 900, height: 650, maximized: false })
    expect(readWindowState(inner, DISPLAYS)).toMatchObject({ width: 900 })
  })

  test('a folder in the file place reads as the default', () => {
    expect(readWindowState(dir, DISPLAYS)).toEqual(DEFAULT_STATE)
  })
})
