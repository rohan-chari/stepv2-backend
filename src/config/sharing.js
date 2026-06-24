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
const IOS_APP_ID =
  process.env.IOS_APP_ID || "TEAMID.com.rohanchari.steptracker";

// Android App Links: the package name + the signing cert SHA-256 fingerprint(s).
// ANDROID_SHA256_FINGERPRINTS is a comma-separated list (Play App Signing
// usually means BOTH the upload key and Google's re-signing key must appear).
// Obtain via `keytool -list -v -keystore <ks>` or the Play Console. Until set,
// assetlinks.json publishes an empty fingerprint list (verification will not
// pass, but the endpoint is structurally valid).
const ANDROID_PACKAGE =
  process.env.ANDROID_PACKAGE || "com.rohanchari.steptracker";
const ANDROID_SHA256_FINGERPRINTS = (
  process.env.ANDROID_SHA256_FINGERPRINTS || ""
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Store URLs for the landing-page CTA when the app isn't installed.
const APP_STORE_URL =
  process.env.APP_STORE_URL || "https://apps.apple.com/app/bara";
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
};
