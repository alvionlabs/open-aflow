export type QuitFlow = { beforeQuit(e: { preventDefault(): void }): void; sessionEnd(): void }
export function createQuitFlow(_o: { stop(): Promise<unknown>; hide(): void; quit(): void }): QuitFlow {
  return { beforeQuit() {}, sessionEnd() {} }
}
