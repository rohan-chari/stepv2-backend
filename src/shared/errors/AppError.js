// Shared application error base class (audit Phase 1). Domain code throws
// these; the central error middleware (shared/http/errorMiddleware) maps them
// onto the wire. `code` is the machine-readable identifier clients may branch
// on; `meta` is optional extra context merged into the JSON body — never put
// secrets or internal state in it.
class AppError extends Error {
  constructor(message, code = "INTERNAL_ERROR", statusCode = 500, meta = undefined) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.meta = meta;
  }
}

class NotFoundError extends AppError {
  constructor(message = "Not found", code = "NOT_FOUND", meta = undefined) {
    super(message, code, 404, meta);
  }
}

class ValidationError extends AppError {
  constructor(message = "Invalid request", code = "VALIDATION_ERROR", meta = undefined) {
    super(message, code, 400, meta);
  }
}

class ForbiddenError extends AppError {
  constructor(message = "Forbidden", code = "FORBIDDEN", meta = undefined) {
    super(message, code, 403, meta);
  }
}

class ConflictError extends AppError {
  constructor(message = "Conflict", code = "CONFLICT", meta = undefined) {
    super(message, code, 409, meta);
  }
}

module.exports = {
  AppError,
  NotFoundError,
  ValidationError,
  ForbiddenError,
  ConflictError,
};
