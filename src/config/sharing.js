// Centralized config for shareable race links and the native deep-link
// verification files (Apple App Site Association + Android assetlinks). Values
// default to prod constants but are env-overridable for staging/local so the
// links resolve to the right host per environment.

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || "https://steptracker-api.org";

// iOS Universal Links: "<AppleTeamID>.<bundleId>". The apple-app-site-
// association file can only associate once the real Apple Team ID is set here
// (via the IOS_APP_ID env var on the server). The bundle id matches the iOS
// app's PRODUCT_BUNDLE_IDENTIFIER.
// Default is the real prod value (Apple Team ID 4NRKZL9H5J, from the Xcode
// project's DEVELOPMENT_TEAM + the iOS bundle id). Env-overridable for other
// environments. This is what makes the AASA file verify for Universal Links.
const IOS_APP_ID =
  process.env.IOS_APP_ID || "4NRKZL9H5J.com.rohanchari.steptracker";

// Android App Links: the package name + the signing cert SHA-256 fingerprint(s).
// Play App Signing means BOTH keys must be listed for App Links to verify across
// every channel:
//   * UPLOAD key  — set below (extracted from android/key.properties' keystore).
//     Used by internal-test / sideloaded builds you sign yourself.
//   * Play APP-SIGNING key — Google re-signs Play Store installs with ITS key,
//     so its SHA-256 MUST also be present or Play Store installs won't verify.
//     ⚠️ STILL TO ADD: get it from Play Console → App integrity → App signing →
//     "App signing key certificate" SHA-256, and append it (comma-separated) to
//     the default below or via the ANDROID_SHA256_FINGERPRINTS env var.
const ANDROID_PACKAGE =
  process.env.ANDROID_PACKAGE || "com.rohanchari.steptracker";
const DEFAULT_ANDROID_FINGERPRINTS = [
  // Upload key (android/key.properties → bara-upload-key.jks, alias "upload").
  "CF:06:4C:DD:CA:14:CB:6B:27:91:BC:86:77:39:EF:14:EC:0E:AE:13:3C:68:E2:71:30:E5:0D:0F:8B:EE:14:3A",
  // TODO: append the Play app-signing key SHA-256 from Play Console.
].join(",");
const ANDROID_SHA256_FINGERPRINTS = (
  process.env.ANDROID_SHA256_FINGERPRINTS || DEFAULT_ANDROID_FINGERPRINTS
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Store URLs for the landing-page CTA when the app isn't installed.
const APP_STORE_URL =
  process.env.APP_STORE_URL ||
  "https://apps.apple.com/us/app/bara-step-challenges/id6760504694";
const PLAY_STORE_URL =
  process.env.PLAY_STORE_URL ||
  `https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE}`;

// Open Graph share-card image for the link preview (the picture iMessage/social
// show). Optional: empty by default so no broken image is advertised. Point it
// at a 1200x630 PNG once one exists — e.g. OG_IMAGE_URL or the bundled
// /share-card.png served from public/. Must be an absolute URL.
const OG_IMAGE_URL = process.env.OG_IMAGE_URL || "";

// Custom URL scheme — the reliable "Open in app" re-tap from the landing page
// after install (custom schemes always launch the app if installed, even when
// the universal-link association is still propagating).
const APP_URL_SCHEME = process.env.APP_URL_SCHEME || "bara";

// The canonical shareable link. This is the URL sent in iMessage; iOS/Android
// route it straight into the app when installed (universal/app link), otherwise
// the browser loads the landing page at the same URL.
function buildShareUrl(shareToken) {
  return `${PUBLIC_BASE_URL}/r/${shareToken}`;
}

// Custom-scheme deep link for the landing page's "Open in app" button.
function buildAppDeepLink(shareToken) {
  return `${APP_URL_SCHEME}://join/${shareToken}`;
}

// Tournament share link + custom-scheme deep link (mirrors /r/* for races).
function buildTournamentShareUrl(shareToken) {
  return `${PUBLIC_BASE_URL}/t/${shareToken}`;
}
function buildTournamentAppDeepLink(shareToken) {
  return `${APP_URL_SCHEME}://tournament/${shareToken}`;
}

module.exports = {
  PUBLIC_BASE_URL,
  IOS_APP_ID,
  ANDROID_PACKAGE,
  ANDROID_SHA256_FINGERPRINTS,
  APP_STORE_URL,
  PLAY_STORE_URL,
  APP_URL_SCHEME,
  OG_IMAGE_URL,
  buildShareUrl,
  buildAppDeepLink,
  buildTournamentShareUrl,
  buildTournamentAppDeepLink,
};
