export class DomainError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
  }
}

export function fail(code, message, status = 400) {
  throw new DomainError(code, message, status);
}

export function assertInvariant(condition, message) {
  if (!condition) throw new DomainError('internal_error', message, 500);
}
