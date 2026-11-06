import { describe, expect, test } from 'vitest'
import config from '../vite.config.ts'

// `pnpm dev` puts the session token in the page, so a framed page's own token and Origin pass the
// guards. Only these headers stop a click in a frame. The values match production's (web-app.ts).
const NO_FRAMING = { 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY' }

describe('the Vite config refuses framing', () => {
  test('on the dev server', () => {
    expect((config as { server?: { headers?: object } }).server?.headers).toMatchObject(NO_FRAMING)
  })

  test('on the preview server', () => {
    expect((config as { preview?: { headers?: object } }).preview?.headers).toMatchObject(NO_FRAMING)
  })
})

describe('the dev page token', () => {
  test("reads the token from the server's live config folder, the same choice the server makes", async () => {
    const { readFileSync } = await import('node:fs')
    const text = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8')
    expect(text).toMatch(/tokenMetaPlugin\(\(\) => liveConfigDir\(process\.env, process\.platform, homedir\(\)\)\)/)
  })
})
