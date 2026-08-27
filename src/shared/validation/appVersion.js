// PackageInfo.version is numeric/dotted. Permit a bounded build/prerelease
// suffix plus the explicit client fallback, but never arbitrary free-form text.
// This is shared by authenticated sticky-version stamping, activation
// analytics, and interstitial accounting so the same client field cannot drift
// across ingestion surfaces.
const SAFE_APP_VERSION =
  /^(?:unknown|\d{1,4}(?:\.\d{1,4}){1,3}(?:[+-][A-Za-z0-9.-]{1,16})?)$/;

function isSafeAppVersion(value) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 32 &&
    SAFE_APP_VERSION.test(value)
  );
}

module.exports = { SAFE_APP_VERSION, isSafeAppVersion };
