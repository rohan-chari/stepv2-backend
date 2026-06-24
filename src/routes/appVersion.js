const { Router } = require("express");
const defaultConfig = require("../config/appVersion");
const { evaluateVersionGate } = require("../utils/appVersion");

// Public, unauthenticated router for the client force-update gate. The app polls
// this on launch/resume; old builds that predate the gate simply never call it.
// Additive and back-compatible — it reads nothing from the DB and requires no
// auth, so it answers even before a user has a session.
function createAppVersionRouter(dependencies = {}) {
  const router = Router();
  const config = dependencies.appVersionConfig || defaultConfig;

  // GET /app-version/policy
  // Returns the version policy plus convenience flags computed from the caller's
  // X-App-Version header. The client can (and does) re-derive the flags itself
  // from minSupportedVersion/latestVersion; the server-side flags are a
  // convenience and fail OPEN when the header is missing/garbled.
  router.get("/policy", (req, res) => {
    const appVersion = req.get("X-App-Version");
    const { updateRequired, updateAvailable } = evaluateVersionGate({
      appVersion,
      minSupportedVersion: config.minSupportedVersion,
      latestVersion: config.latestVersion,
    });

    res.json({
      minSupportedVersion: config.minSupportedVersion,
      latestVersion: config.latestVersion,
      updateRequired,
      updateAvailable,
      updateUrl: {
        ios: config.iosUpdateUrl,
        android: config.androidUpdateUrl,
      },
    });
  });

  return router;
}

module.exports = { createAppVersionRouter };
