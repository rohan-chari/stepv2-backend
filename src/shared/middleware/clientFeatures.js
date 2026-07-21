// Capability-based gating for features old app binaries can't render.
//
// The app sends `X-Client-Features: characters` (comma-separated, lowercase)
// from builds that know how to draw purchasable base characters (corgi, …).
// Anything that omits the header — every shipped binary that predates the
// feature — resolves to "no features", so CHARACTER-slot shop items are
// filtered out of its catalog and equipped payloads and it keeps rendering
// the default capybara. This is per-capability, unlike the release-channel
// header which only distinguishes TestFlight from prod.
function resolveClientFeatures(headerValue) {
  if (typeof headerValue !== "string") return new Set();
  return new Set(
    headerValue
      .split(",")
      .map((feature) => feature.trim().toLowerCase())
      .filter(Boolean)
  );
}

// Express middleware: stamp req.clientFeatures from the request header.
function extractClientFeatures(req, _res, next) {
  req.clientFeatures = resolveClientFeatures(req.headers["x-client-features"]);
  next();
}

module.exports = { resolveClientFeatures, extractClientFeatures };
