// Builds the production app folder: one ESM file with every dependency inside, and the web build
// beside it. The folder runs when moved anywhere with `node server.mjs`.

import { cp, mkdir, rm, stat } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), 'main-production.ts')

/** ESM has no `require`, and esbuild's shim for a CommonJS dependency's `require('fs')` calls this one. */
const REQUIRE_IMPORT = 'node:module'
const REQUIRE_BANNER = `import { createRequire as __bundleCreateRequire } from '${REQUIRE_IMPORT}'; const require = __bundleCreateRequire(import.meta.url);`

export const BUNDLE_OPTIONS = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: REQUIRE_BANNER },
  logLevel: 'warning',
} as const

const holds = (parent: string, child: string): boolean => {
  const rel = relative(parent, child)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && rel !== child
}

/** Rejects, before anything is removed, when there's no web build or emptying `outDir` would reach it. */
async function checkFolders(webDist: string, outDir: string): Promise<void> {
  const page = await stat(join(webDist, 'index.html')).catch(() => null)
  if (!page?.isFile()) throw new Error(`no web build: index.html is missing in ${webDist}`)
  if (holds(outDir, webDist) || holds(webDist, outDir)) {
    throw new Error(`the output folder ${outDir} overlaps the web build ${webDist}`)
  }
}

export async function bundleApp(o: { webDist: string; outDir: string }): Promise<{ externalImports: string[] }> {
  await checkFolders(o.webDist, o.outDir)
  await rm(o.outDir, { recursive: true, force: true })
  await mkdir(o.outDir, { recursive: true })

  const outfile = join(o.outDir, 'server.mjs')
  const result = await build({ ...BUNDLE_OPTIONS, entryPoints: [ENTRY], outfile, metafile: true })
  await cp(o.webDist, join(o.outDir, 'web'), { recursive: true })

  const imports = Object.values(result.metafile.outputs).flatMap((output) => output.imports)
  const external = imports.filter((i) => i.external).map((i) => i.path)
  return { externalImports: [...new Set([REQUIRE_IMPORT, ...external])].sort() }
}
