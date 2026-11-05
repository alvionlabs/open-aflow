// Stub, replaced in the next commit.
export type LogFs = { size(file: string): number; append(file: string, text: string): void; rename(from: string, to: string): void }
export const LOG_FILE = 'stub'
export const LOG_MAX_BYTES = 0
export const logLines = (_args: unknown[]): string[] => []
export const createLogFile = (_o: { file: string; fs: LogFs; now(): Date; maxBytes?: number }) => ({ write: (_args: unknown[]) => {} })
