export type BundleMeta = { workingDir: string; metafile: { inputs: Record<string, unknown>; outputs: Record<string, unknown> } }
export function packageRootsFromMetafile(_meta: BundleMeta): string[] {
  return []
}
export function productionClosure(_pkgDir: string): string[] {
  return []
}
export function renderNotices(_o: { roots: string[]; overrides: Record<string, string>; extras: { title: string; text: string }[] }): string {
  return ''
}
