// Skeleton: the tests fail on assertions until the real code lands.
export type OwnerFile = { take(): boolean; check(): boolean; release(): void }
export const OWNER_FILE = 'auto-continue-owner.json'
export const createOwnerFile = (_o: { dir: string; pid?: number; alive?: (pid: number) => boolean; log?: (m: string) => void }): OwnerFile => ({
  take: () => false,
  check: () => false,
  release() {},
})
