import { describe, expect, test } from 'vitest'
import { activatorClsid, hashFromActivation, toastXml } from './toast-activation.ts'

const toast = (over: Partial<{ title: string; body: string; hash: string }> = {}) => ({ title: 'A run', body: 'Merge PR #5', hash: '#/repo/fix-a', ...over })
const launchOf = (xml: string) => /<toast launch="([^"]*)"/.exec(xml)?.[1]
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

describe('toast xml', () => {
  test('the toast carries its run, so a click from the notification center can find it', () => {
    const xml = toastXml(toast())
    expect(xml).toMatch(/^<toast launch="[^"]+" activationType="foreground">/)
    expect(hashFromActivation(unescape(launchOf(xml)!))).toBe('#/repo/fix-a')
    expect(xml).toContain('<binding template="ToastGeneric"><text>A run</text><text>Merge PR #5</text></binding>')
  })

  test('text and hash are escaped', () => {
    const xml = toastXml(toast({ title: `a<b>&"c'`, body: '</text><evil/>', hash: `#/r&x/"y'<z>` }))
    expect(xml).not.toContain('<evil/>')
    expect(xml).toContain('<text>a&lt;b&gt;&amp;&quot;c&apos;</text>')
    expect(hashFromActivation(unescape(launchOf(xml)!))).toBe(`#/r&x/"y'<z>`)
  })

  test('a control character, which XML can not hold, leaves the text', () => {
    expect(toastXml(toast({ title: 'a\u0001b\u001fc', body: 'x\ty\nz\u0000' }))).toContain('<text>abc</text><text>x\ty\nz</text>')
  })
})

describe('characters Windows refuses in a toast', () => {
  test('U+FFFE and U+FFFF leave the text', () => {
    expect(toastXml(toast({ title: 'a￾b', body: 'c￿d' }))).toContain('<text>ab</text><text>cd</text>')
  })

  test('a surrogate with no partner leaves the text, on either side', () => {
    expect(toastXml(toast({ title: 'a\uD83Db', body: 'c\uDE00d' }))).toContain('<text>ab</text><text>cd</text>')
    // Two in the wrong order are no pair, and one at the very end has nothing after it.
    expect(toastXml(toast({ title: 'a\uDE00\uD83Db', body: 'c\uD83D' }))).toContain('<text>ab</text><text>c</text>')
  })

  test('the same characters leave the hash', () => {
    const xml = toastXml(toast({ hash: '#/repo/￿fix\uD83D-a' }))
    expect(hashFromActivation(unescape(launchOf(xml)!))).toBe('#/repo/fix-a')
  })

  test('an emoji, U+0085, tab, newline, and CR stay', () => {
    expect(toastXml(toast({ title: 'ok \u{1F600} done', body: 'a\u0085b\tc\nd\re' }))).toContain('<text>ok \u{1F600} done</text><text>a\u0085b\tc\nd\re</text>')
  })
})

describe('the run from an activation', () => {
  test.each([
    ['empty: a toast from a version before this one', ''],
    ['no prefix', '#/repo/fix-a'],
    ['another prefix', 'http://evil.example/#/repo'],
    ['the prefix alone', 'pod-board-toast:'],
    ['not a board hash', 'pod-board-toast:javascript:alert(1)'],
    ['a hash with no path', 'pod-board-toast:#repo'],
  ])('%s opens the window on no run', (_name, args) => {
    expect(hashFromActivation(args)).toBeUndefined()
  })
})

describe('the activator the app registers', () => {
  const EXE = 'C:\\Users\\a\\AppData\\Local\\Programs\\open-aflow\\Open AFlow.exe'
  const CLSID = '{D6B1EDA6-9DC7-427D-B544-15863FECE7EB}'

  test("the shortcut's own CLSID, the one Windows calls for every toast", () => {
    expect(activatorClsid({ target: EXE, toastActivatorClsid: CLSID }, EXE)).toBe(CLSID)
    // Windows paths have no case.
    expect(activatorClsid({ target: EXE.toUpperCase(), toastActivatorClsid: CLSID }, EXE)).toBe(CLSID)
  })

  test("another exe's shortcut is left alone: a dev run or a proof never takes the installed app's activator", () => {
    expect(activatorClsid({ target: 'E:\\dev\\electron.exe', toastActivatorClsid: CLSID }, EXE)).toBeUndefined()
  })

  test('no shortcut, or one with no CLSID yet: Electron picks one and stamps it at the first toast', () => {
    expect(activatorClsid(undefined, EXE)).toBeUndefined()
    expect(activatorClsid({ target: EXE }, EXE)).toBeUndefined()
    expect(activatorClsid({ target: EXE, toastActivatorClsid: '' }, EXE)).toBeUndefined()
  })
})
