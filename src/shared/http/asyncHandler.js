// Wraps an async Express handler so a thrown error / rejected promise lands in
// next(err) — i.e. the central error middleware — instead of becoming an
// unhandled rejection. Existing routes keep their hand-rolled try/catch until
// they migrate (audit Phase 2); new routes should use this.
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
