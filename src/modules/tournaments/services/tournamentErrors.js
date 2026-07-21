const { AppError } = require("../../../shared/errors/AppError");

// One error type for every tournament command. Now an AppError subclass so the
// central error middleware (shared/http/errorMiddleware) serializes it; the
// legacy (message, statusCode, code) constructor signature is preserved so the
// ~42 throw sites (and the ErrorClass-injection callers in raceBuyIns /
// validateRaceConfig) stay unchanged.
class TournamentError extends AppError {
  constructor(message, statusCode, code) {
    super(message, code, statusCode || 400);
    // No default code: several throw sites pass none, and shipped clients read
    // bodies without a `code` key there (res.json drops undefined). AppError's
    // INTERNAL_ERROR default would add the key and change the wire shape.
    this.code = code;
  }
}

module.exports = { TournamentError };
