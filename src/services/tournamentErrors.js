// One error type for every tournament command. Carries an HTTP statusCode and a
// stable machine-readable `code` (§6.9) the route layer serializes alongside the
// human `error` copy old clients read.
class TournamentError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = "TournamentError";
    if (statusCode) this.statusCode = statusCode;
    if (code) this.code = code;
  }
}

module.exports = { TournamentError };
