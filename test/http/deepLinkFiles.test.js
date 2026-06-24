const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildAppleAppSiteAssociation,
  buildAssetLinks,
} = require("../../src/web/deepLinkFiles");

test("apple-app-site-association maps /r/* to the configured app id", () => {
  const aasa = buildAppleAppSiteAssociation({
    iosAppId: "ABCDE12345.com.rohanchari.steptracker",
  });

  const detail = aasa.applinks.details[0];
  assert.deepEqual(detail.appIDs, ["ABCDE12345.com.rohanchari.steptracker"]);
  assert.ok(
    detail.components.some((c) => c["/"] === "/r/*"),
    "should claim the /r/* path used by share links"
  );
});

test("assetlinks declares handle_all_urls for the package + fingerprints", () => {
  const links = buildAssetLinks({
    androidPackage: "com.rohanchari.steptracker",
    sha256Fingerprints: ["AA:BB:CC", "DD:EE:FF"],
  });

  assert.equal(links.length, 1);
  assert.deepEqual(links[0].relation, [
    "delegate_permission/common.handle_all_urls",
  ]);
  assert.equal(links[0].target.namespace, "android_app");
  assert.equal(links[0].target.package_name, "com.rohanchari.steptracker");
  assert.deepEqual(links[0].target.sha256_cert_fingerprints, [
    "AA:BB:CC",
    "DD:EE:FF",
  ]);
});

test("assetlinks tolerates an empty fingerprint list (not yet configured)", () => {
  const links = buildAssetLinks({
    androidPackage: "com.rohanchari.steptracker",
    sha256Fingerprints: [],
  });
  assert.deepEqual(links[0].target.sha256_cert_fingerprints, []);
});
