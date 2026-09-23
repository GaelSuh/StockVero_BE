export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class ValidationError extends ApiError {
  constructor(message: string) {
    super(400, message, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message: string = 'Unauthorized') {
    super(401, message, 'UNAUTHORIZED');
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends ApiError {
  constructor(message: string = 'Forbidden') {
    super(403, message, 'FORBIDDEN');
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends ApiError {
  constructor(resource: string) {
    super(404, `${resource} not found`, 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends ApiError {
  constructor(message: string) {
    super(409, message, 'CONFLICT');
    this.name = 'ConflictError';
  }
}

/**
 * Whether an error means "the database could not be reached", as opposed to
 * "the database answered and the data was wrong".
 *
 * This distinction decides an HTTP status, and getting it wrong is expensive.
 * Prisma's connectivity failures (P1001 unreachable, P1002 timed out, P1008
 * operation timed out, P1017 connection closed) are thrown from the same call
 * sites as ordinary query results, so a `catch` that cannot tell them apart
 * reports an infrastructure outage as whatever that catch block's default is.
 * In the auth middleware that default was 401, which signed every user out of
 * the platform the moment the database hiccuped — see the note there.
 *
 * Serverless Postgres makes this routine rather than exotic: a suspended Neon
 * instance cold-starting is exactly this error.
 */
const PRISMA_CONNECTIVITY_CODES = new Set(['P1000', 'P1001', 'P1002', 'P1008', 'P1010', 'P1017']);

export function isDatabaseUnreachable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { name?: string; code?: unknown; errorCode?: unknown; message?: unknown };

  const code = typeof e.code === 'string' ? e.code : typeof e.errorCode === 'string' ? e.errorCode : null;
  if (code && PRISMA_CONNECTIVITY_CODES.has(code)) return true;

  // Thrown when the client cannot establish a connection at all; it carries
  // errorCode rather than code, and older versions carry neither.
  if (e.name === 'PrismaClientInitializationError') return true;
  if (e.name === 'PrismaClientRustPanicError') return true;

  return typeof e.message === 'string' && /can't reach database server/i.test(e.message);
}
