// Bundles an Electron main-process entry into one CommonJS file. `electron` stays external: Electron
// answers that require itself, and under Node the npm package would download its binary.

import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { build } from 'esbuild'

export async function bundleDesktop(o: { entry: string; outfile: string }): Promise<{ externalImports: string[] }> {
  await mkdir(dirname(o.outfile), { recursive: true })
  const result = await build({
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    logLevel: 'warning',
    entryPoints: [o.entry],
    outfile: o.outfile,
    metafile: true,
  })
  const imports = Object.values(result.metafile.outputs).flatMap((output) => output.imports)
  return { externalImports: [...new Set(imports.filter((i) => i.external).map((i) => i.path))].sort() }
}
