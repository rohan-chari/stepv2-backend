// Build-based gating for test-only catalog items.
//
// The app sends `X-Release-Channel: testflight` only from TestFlight builds
// (it self-detects via the App Store sandbox receipt). Every other request —
// App Store builds, old app versions that predate this feature, anything that
// omits or fudges the header — resolves to "prod". "prod" is the safe default:
// it only ever sees launched items (testOnly = false), so no shipped binary can
// be surprised by a hidden item.
function resolveReleaseChannel(headerValue) {
  if (
    typeof headerValue === "string" &&
    headerValue.trim().toLowerCase() === "testflight"
  ) {
    return "testflight";
  }
  return "prod";
}

// Prisma where-fragment that hides test-only items from the prod channel and
// reveals everything to the testflight channel. The column is NOT NULL DEFAULT
// false, so `{ testOnly: false }` is exact and index-friendly.
function testOnlyFilter(channel) {
  return channel === "testflight" ? {} : { testOnly: false };
}

// Express middleware: stamp req.releaseChannel from the request header.
function extractReleaseChannel(req, _res, next) {
  req.releaseChannel = resolveReleaseChannel(req.headers["x-release-channel"]);
  next();
}

module.exports = { resolveReleaseChannel, testOnlyFilter, extractReleaseChannel };
