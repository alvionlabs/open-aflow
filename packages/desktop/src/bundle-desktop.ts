// Bundles an Electron main-process entry into one CommonJS file. `electron` stays external: Electron
// answers that require itself, and under Node the npm package would download its binary.

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { build } from 'esbuild'

/** `testFeed` keeps the update test feed's code, for `pnpm package --test-feed` only. */
export async function bundleDesktop(o: { entry: string; outfile: string; testFeed?: boolean }): Promise<{ externalImports: string[] }> {
  await mkdir(dirname(o.outfile), { recursive: true })
  const result = await build({
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    define: { __OPENAFLOW_TEST_FEED__: String(o.testFeed === true) },
    logLevel: 'warning',
    entryPoints: [o.entry],
    outfile: o.outfile,
    metafile: true,
  })
  // `pnpm package` reads the bundle's packages from this.
  await writeFile(`${o.outfile}.meta.json`, JSON.stringify({ workingDir: process.cwd(), metafile: result.metafile }))
  const imports = Object.values(result.metafile.outputs).flatMap((output) => output.imports)
  return { externalImports: [...new Set(imports.filter((i) => i.external).map((i) => i.path))].sort() }
}
