const { AppError } = require("../errors/AppError");

// Central Express error handler (audit Phase 1). Mounted LAST in app.js.
// - AppError (and subclasses) → its statusCode with the standard JSON shape
//   { error, code, ...meta } — the same { error, code } contract routes
//   already hand-roll today, so migrated routes stay wire-compatible.
// - Anything else → logged and answered as an opaque 500. Legacy bespoke
//   errors that carry a statusCode still get mapped rather than 500ing so
//   Phase 2 can migrate routes incrementally.
function errorMiddleware(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: err.message,
      code: err.code,
      ...(err.meta || {}),
    });
  }

  // Legacy bespoke error classes set numeric statusCode/status themselves.
  const legacyStatus = Number(err && (err.statusCode || err.status));
  if (Number.isInteger(legacyStatus) && legacyStatus >= 400 && legacyStatus < 600) {
    return res.status(legacyStatus).json({
      error: err.message || "Request failed",
      ...(err.code ? { code: err.code } : {}),
    });
  }

  console.error("Unhandled error:", err);
  return res.status(500).json({ error: "Internal server error" });
}

module.exports = { errorMiddleware };
