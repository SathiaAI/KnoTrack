// KtError class + ERROR_CODES map. See docs/TRD.md §3.1 for the exact
// envelope shape and the transport-level delivery rules (401 vs the rest).

export const ERROR_CODES = {
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION_ERROR: 422,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface KtErrorEnvelope {
  error: {
    code: ErrorCode;
    http_status_equivalent: number;
    message: string;
    details?: Record<string, unknown>;
  };
}

export class KtError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'KtError';
    this.code = code;
    this.details = details;
  }

  toEnvelope(): KtErrorEnvelope {
    const errorBody: KtErrorEnvelope['error'] = {
      code: this.code,
      http_status_equivalent: ERROR_CODES[this.code],
      message: this.message,
    };
    if (this.details) {
      errorBody.details = this.details;
    }
    return { error: errorBody };
  }
}

export function notFound(message: string, details?: Record<string, unknown>): KtError {
  return new KtError('NOT_FOUND', message, details);
}

export function conflict(message: string, details?: Record<string, unknown>): KtError {
  return new KtError('CONFLICT', message, details);
}

export function validationError(message: string, details?: Record<string, unknown>): KtError {
  return new KtError('VALIDATION_ERROR', message, details);
}

export function internalError(message: string, details?: Record<string, unknown>): KtError {
  return new KtError('INTERNAL_ERROR', message, details);
}
