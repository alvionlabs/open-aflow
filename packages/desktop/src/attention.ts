import type { Board } from '@pod-board/model'

export type AttentionItem = { id: string; tier: 'blocked' | 'merge' | 'reply'; run: string; title: string; hash: string }

export function attentionItems(_board: Board, _now: number): AttentionItem[] {
  return []
}
