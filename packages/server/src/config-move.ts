// Not built yet.

export type MoveResult = 'copied' | 'none' | 'kept' | 'failed'

export type MoveOptions = {
  from: string | undefined
  to: string
  log?: (line: string) => void
  error?: (line: string) => void
  copy?: (from: string, to: string, filter: (source: string) => boolean) => Promise<void>
}

export async function moveOldConfig(_o: MoveOptions): Promise<MoveResult> {
  return 'none'
}
