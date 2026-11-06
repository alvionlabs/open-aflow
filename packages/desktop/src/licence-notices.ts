// THIRD-PARTY-NOTICES.txt: each package whose code ships, with its name, version, and licence text. A bundle's
// list comes from its esbuild metafile, so a removed dependency leaves the notices. The web build's list is the web
// package's production closure: extra packages are fine, and a missed one isn't.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { APP_NAME } from './shell-config.ts'

export type BundleMeta = { workingDir: string; metafile: { inputs: Record<string, unknown>; outputs: Record<string, unknown> } }
export type NoticeExtra = { title: string; text: string }

type Manifest = { name?: string; version?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }

const MODULES = 'node_modules/'
const LICENCE_FILE = /^(licen[cs]e|copying)(\.|-|$)/i
const RULE = '='.repeat(80)

const readManifest = (root: string) => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Manifest

/** The package folder of each input under node_modules. Only `inputs` are in the bundle. */
export function packageRootsFromMetafile(meta: BundleMeta): string[] {
  const roots = new Set<string>()
  for (const input of Object.keys(meta.metafile.inputs)) {
    // `<define:…>` is esbuild's own, and `(disabled):…` is a file it left out.
    if (input.startsWith('<') || input.startsWith('(')) continue
    const at = input.lastIndexOf(MODULES)
    if (at === -1) continue
    const parts = input.slice(at + MODULES.length).split('/')
    const name = parts[0]!.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1)
    roots.add(resolve(meta.workingDir, input.slice(0, at + MODULES.length), ...name))
  }
  return [...roots]
}

/** Node's own walk up the folders: each one's node_modules, from the package's real path. */
function resolveDependency(from: string, name: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync.native(candidate)
    if (dirname(dir) === dir) return undefined
  }
}

/** Every package a package needs in production. A workspace package is walked and not listed. */
export function productionClosure(pkgDir: string): string[] {
  const seen = new Set<string>()
  const listed: string[] = []
  const walk = (dir: string) => {
    if (seen.has(dir)) return
    seen.add(dir)
    if (dir.includes('node_modules')) listed.push(dir)
    const manifest = readManifest(dir)
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      const found = resolveDependency(dir, name)
      if (found === undefined) throw new Error(`${name}, a dependency of ${manifest.name ?? dir}, is not installed`)
      walk(found)
    }
    for (const name of Object.keys(manifest.optionalDependencies ?? {})) {
      const found = resolveDependency(dir, name)
      if (found !== undefined) walk(found)
    }
  }
  walk(realpathSync.native(pkgDir))
  return listed
}

function licenceText(root: string): string | undefined {
  const files = readdirSync(root)
    .filter((name) => LICENCE_FILE.test(name) && statSync(join(root, name)).isFile())
    .sort()
  const text = files.map((name) => readFileSync(join(root, name), 'utf8').trim()).filter((t) => t !== '')
  return text.length > 0 ? text.join('\n\n') : undefined
}

export function renderNotices(o: { roots: string[]; overrides: Record<string, string>; extras: NoticeExtra[] }): string {
  const entries = new Map<string, string>()
  const missing: string[] = []
  for (const root of o.roots) {
    const { name = root, version = 'unknown' } = readManifest(root)
    const title = `${name} ${version}`
    if (entries.has(title)) continue
    const text = licenceText(root) ?? o.overrides[name]
    if (text === undefined) missing.push(title)
    else entries.set(title, text)
  }
  if (missing.length > 0) throw new Error(`no licence file and no override for: ${missing.sort().join(', ')}`)

  const sections = [
    ...[...entries.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([title, text]) => ({ title, text })),
    ...o.extras,
  ]
  const body = sections.map(({ title, text }) => `${RULE}\n${title}\n${RULE}\n\n${text}\n`).join('\n')
  return `${APP_NAME} includes the third-party software named below.\n\n${body}`
}
