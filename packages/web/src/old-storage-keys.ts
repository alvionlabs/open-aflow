// Not built yet.

export type KeyStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function moveOldKeys(_storage: KeyStorage | null | undefined): void {}
