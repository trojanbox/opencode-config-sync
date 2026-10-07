export type ConfigSyncErrorCode =
  | "NOT_CONFIGURED"
  | "GIT_ERROR"
  | "CONFLICT"
  | "SECRET_DETECTED"
  | "UNSAFE_SYMLINK"
  | "LIMIT_EXCEEDED"
  | "INVALID_STATE"
  | "ABORTED"

export class ConfigSyncError extends Error {
  readonly code: ConfigSyncErrorCode
  readonly details?: unknown

  constructor(code: ConfigSyncErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = "ConfigSyncError"
    this.code = code
    this.details = details
  }
}

export function errorSummary(error: unknown): string {
  if (error instanceof ConfigSyncError) {
    const detail = error.details === undefined ? "" : `\n${JSON.stringify(error.details, null, 2)}`
    return `[${error.code}] ${error.message}${detail}`
  }
  if (error instanceof Error) return error.stack ?? error.message
  return String(error)
}
