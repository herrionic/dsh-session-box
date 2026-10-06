/** Stable error shape thrown by every client call. */
export class SessionBoxClientError extends Error {
  readonly code: string;
  /** Optional machine-readable details (e.g. VERSION_CONFLICT `current`). */
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "SessionBoxClientError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
