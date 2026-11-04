import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { parse } from 'yaml'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (name: string) => {
  const file = join(ROOT, '.github', 'workflows', name)
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, unknown> }
type Job = { 'runs-on'?: string; needs?: string | string[]; permissions?: Record<string, string>; env?: unknown; steps?: Step[] }
type Workflow = { name?: string; on?: Record<string, { tags?: string[]; branches?: string[] }>; permissions?: unknown; env?: unknown; jobs?: Record<string, Job> }

const text = read('release.yml')
const flow = (parse(text) ?? {}) as Workflow
const stepsOf = (job: string) => flow.jobs?.[job]?.steps ?? []
const allSteps = () => Object.keys(flow.jobs ?? {}).flatMap(stepsOf)
const indexOfRun = (steps: Step[], pattern: RegExp) => steps.findIndex((s) => pattern.test(s.run ?? ''))

/** GitHub's filter glob, as far as this file uses it: `[0-9]+` repeats and the rest is literal. */
const matchesGlob = (glob: string, ref: string) => new RegExp(`^${glob.replaceAll('.', '\\.')}$`).test(ref)

describe('release.yml', () => {
  test('runs on a version tag only', () => {
    expect(flow.name).toBe('release')
    expect(Object.keys(flow.on ?? {})).toEqual(['push'])
    expect(Object.keys(flow.on?.push ?? {})).toEqual(['tags'])
    const globs = flow.on?.push?.tags ?? []
    expect(globs).toHaveLength(1)
    const matches = (ref: string) => globs.some((glob) => matchesGlob(glob, ref))
    expect(matches('v1.2.3')).toBe(true)
    expect(matches('v10.20.30')).toBe(true)
    for (const ref of ['v1.2', 'v1.2.3-beta', 'v1.2.3.4', '1.2.3', 'vx.y.z']) expect(matches(ref), ref).toBe(false)
  })

  test('every job runs on windows-latest, with Node 22, and pnpm from packageManager', () => {
    expect(Object.keys(flow.jobs ?? {}).sort()).toEqual(['build', 'publish'])
    for (const job of Object.values(flow.jobs ?? {})) expect(job['runs-on']).toBe('windows-latest')
    const build = stepsOf('build')
    const node = build.find((s) => s.uses?.startsWith('actions/setup-node@'))
    expect(node?.with?.['node-version']).toBe(22)
    const pnpm = build.find((s) => s.uses?.startsWith('pnpm/action-setup@'))
    expect(pnpm).toBeDefined()
    expect(pnpm?.with?.version).toBeUndefined()
    expect(indexOfRun(build, /pnpm install --frozen-lockfile/)).toBeGreaterThanOrEqual(0)
  })

  test('actions are pinned', () => {
    const lines = text.split('\n').filter((l) => /^\s*(?:-\s*)?uses:/.test(l))
    expect(lines.length).toBeGreaterThanOrEqual(5)
    for (const line of lines) expect(line).toMatch(/uses:\s*[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+\s*$/)
  })

  test('no dependency cache', () => {
    const node = stepsOf('build').find((s) => s.uses?.startsWith('actions/setup-node@'))
    // setup-node can turn on its own cache from the packageManager field unless this is false.
    expect(node?.with?.['package-manager-cache']).toBe(false)
    expect(node?.with?.cache).toBeUndefined()
    const pnpm = stepsOf('build').find((s) => s.uses?.startsWith('pnpm/action-setup@'))
    expect(pnpm?.with?.cache ?? false).toBe(false)
    expect(allSteps().filter((s) => s.uses?.startsWith('actions/cache'))).toEqual([])
  })

  test('checkout keeps no credentials', () => {
    const checkouts = allSteps().filter((s) => s.uses?.startsWith('actions/checkout@'))
    expect(checkouts).toHaveLength(1)
    expect(checkouts[0]?.with?.['persist-credentials']).toBe(false)
  })

  test('least-privilege token', () => {
    expect(flow.permissions).toEqual({})
    expect(flow.jobs?.build?.permissions).toEqual({ contents: 'read' })
    expect(flow.jobs?.publish?.permissions).toEqual({ contents: 'write' })
    // The token is on one step only: the one that makes the release.
    const tokened = allSteps().filter((s) => /github\.token|secrets\./.test(JSON.stringify(s)))
    expect(tokened).toHaveLength(1)
    expect(tokened[0]?.run).toMatch(/gh release create/)
    expect(stepsOf('publish')).toContain(tokened[0])
    expect(flow.env).toBeUndefined()
    expect(flow.jobs?.publish?.env).toBeUndefined()
    expect(flow.jobs?.build?.env).toBeUndefined()
  })

  test('publish waits for the check', () => {
    expect(flow.jobs?.publish?.needs).toBe('build')
    const steps = stepsOf('publish')
    expect(steps.length).toBeGreaterThan(0)
    expect(steps.filter((s) => s.uses?.startsWith('actions/checkout@'))).toEqual([])
    // No code from the repo: only the download and gh itself.
    expect(steps.filter((s) => /\bpnpm\b|\bnode\b|\btsx\b/.test(s.run ?? ''))).toEqual([])
  })

  test('build checks and never publishes', () => {
    const build = stepsOf('build')
    const tag = indexOfRun(build, /release:check "--tag=\$env:TAG"/)
    const verify = indexOfRun(build, /^pnpm verify$/m)
    const pack = indexOfRun(build, /^pnpm package$/m)
    const check = indexOfRun(build, /^pnpm release:check packages\/desktop\/release$/m)
    const upload = build.findIndex((s) => s.uses?.startsWith('actions/upload-artifact@'))
    expect(tag).toBeGreaterThanOrEqual(0)
    expect(verify).toBeGreaterThan(tag)
    expect(pack).toBeGreaterThan(verify)
    expect(check).toBeGreaterThan(pack)
    expect(upload).toBeGreaterThan(check)
    expect(build.filter((s) => /gh release|--publish|GH_TOKEN|GITHUB_TOKEN/.test(JSON.stringify(s)))).toEqual([])
    // The tag reaches the shell through env, never pasted into a script.
    expect(build[tag]?.env?.TAG).toBe('${{ github.ref_name }}')
    expect(allSteps().filter((s) => (s.run ?? '').includes('${{'))).toEqual([])
  })

  test('only the three named files are uploaded, and a missing one fails', () => {
    const upload = stepsOf('build').find((s) => s.uses?.startsWith('actions/upload-artifact@'))
    expect(upload?.with?.['if-no-files-found']).toBe('error')
    const paths = String(upload?.with?.path ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .sort()
    expect(paths).toEqual(['packages/desktop/release/latest.yml', 'packages/desktop/release/pod-board-setup-*.exe', 'packages/desktop/release/pod-board-setup-*.exe.blockmap'])
  })

  test('a normal release', () => {
    const create = stepsOf('publish').find((s) => /gh release create/.test(s.run ?? ''))
    expect(create?.run).toMatch(/gh release create "\$env:TAG"/)
    // --verify-tag: a release never makes a tag of its own.
    expect(create?.run).toMatch(/--verify-tag/)
    expect(create?.env?.GH_TOKEN).toBe('${{ github.token }}')
    for (const step of allSteps()) expect(JSON.stringify(step)).not.toMatch(/--draft|--prerelease|--clobber|draft:|prerelease:/)
  })
})

describe('pod-ci.yml', () => {
  test('verify stays free of packaging', () => {
    const ci = parse(read('pod-ci.yml')) as Workflow
    const steps = ci.jobs?.verify?.steps ?? []
    const install = steps.find((s) => /pnpm install/.test(s.run ?? ''))
    expect(install?.env?.ELECTRON_SKIP_BINARY_DOWNLOAD).toBe('1')
    expect(steps.some((s) => s.run === 'pnpm verify')).toBe(true)
    expect(steps.filter((s) => /package|test:install|release:check|electron-builder/.test(s.run ?? ''))).toEqual([])
    const scripts = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
    expect(scripts.verify).not.toMatch(/package|test:install|release:check/)
  })
})
