export class ApiError extends Error {
  /** `code`: a stable name for a condition the client acts on, sent next to the sentence (the sentence may be reworded). */
  constructor(public readonly status: number, message: string, public readonly details?: unknown, public readonly code?: string) {
    super(message);
  }
}
