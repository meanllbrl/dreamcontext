/**
 * Typed failures for the whiteboard store. Each carries the HTTP status the Wave 2 server
 * route maps it to, so the route never has to re-derive "is this a 400 or a 422" from a
 * message string, and the CLI exits non-zero with the same message.
 */

export class WhiteboardError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = new.target.name;
    this.status = status;
  }
}

/** The board file exists but its drawing block is missing or unparseable (D12). Never written over. */
export class WhiteboardCorruptError extends WhiteboardError {
  constructor(message: string) { super(message, 422); }
}

/** An element, widget payload or request body failed validation (security invariants, D10). */
export class WhiteboardValidationError extends WhiteboardError {
  constructor(message: string) { super(message, 400); }
}

/** A request body above the byte cap. */
export class WhiteboardTooLargeError extends WhiteboardError {
  constructor(message: string) { super(message, 413); }
}

/**
 * No board at that slug — a bad slug, a missing board, or a symlinked path (never followed,
 * reported as absent so a probe learns nothing about what the link points at).
 */
export class WhiteboardNotFoundError extends WhiteboardError {
  constructor(message: string) { super(message, 404); }
}

/** Another writer held the board's lock past the wait budget. Retryable. */
export class WhiteboardLockError extends WhiteboardError {
  constructor(message: string) { super(message, 503); }
}
