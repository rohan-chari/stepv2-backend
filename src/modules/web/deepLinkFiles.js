const sharing = require("./sharing");

// Builds the Apple App Site Association (AASA) document served at
// /.well-known/apple-app-site-association (no extension, content-type
// application/json). The `components` form is the modern (iOS 13+) syntax;
// "/r/*" claims exactly the share-link path so the OS opens the app for those
// URLs and leaves every other path (privacy, support, …) to the browser.
function buildAppleAppSiteAssociation({ iosAppId = sharing.IOS_APP_ID } = {}) {
  return {
    applinks: {
      details: [
        {
          appIDs: [iosAppId],
          components: [
            {
              "/": "/r/*",
              comment: "Shared race invite links",
            },
            {
              "/": "/t/*",
              comment: "Shared tournament invite links",
            },
          ],
        },
      ],
    },
  };
}

// Builds the Android Digital Asset Links document served at
// /.well-known/assetlinks.json. Verifies that this site delegates App Link
// handling to the app signed with the given cert fingerprint(s).
function buildAssetLinks({
  androidPackage = sharing.ANDROID_PACKAGE,
  sha256Fingerprints = sharing.ANDROID_SHA256_FINGERPRINTS,
} = {}) {
  return [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: androidPackage,
        sha256_cert_fingerprints: sha256Fingerprints,
      },
    },
  ];
}

module.exports = { buildAppleAppSiteAssociation, buildAssetLinks };
