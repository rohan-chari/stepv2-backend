// Server-driven client version policy — the remote kill-switch for forcing app
// updates. Both values default to "0.0.0" so the gate ships DORMANT: until you
// raise MIN_SUPPORTED_APP_VERSION (an env var on the server, no app submission
// needed) nothing is ever blocked or nudged. Raise LATEST_APP_VERSION to show a
// soft "update available" prompt; raise MIN_SUPPORTED_APP_VERSION to hard-block
// everything below it.
//
// NOTE: only app builds that already ship the client-side gate can be blocked.
// Versions released before the gate existed have no way to enforce this and will
// only ever see the App Store / Play Store's own update prompt.

const { sharing } = require("../modules/web");

const MIN_SUPPORTED_VERSION =
  process.env.MIN_SUPPORTED_APP_VERSION || "0.0.0";

// Defaults to the floor so that, until set, "latest" never trails "supported"
// (no spurious soft-update nudge before you've configured a real latest).
const LATEST_VERSION =
  process.env.LATEST_APP_VERSION || MIN_SUPPORTED_VERSION;

// Store links the update screen sends users to. Reuse the sharing config's
// store URLs so there's a single source of truth per environment.
const IOS_UPDATE_URL = process.env.IOS_UPDATE_URL || sharing.APP_STORE_URL;
const ANDROID_UPDATE_URL =
  process.env.ANDROID_UPDATE_URL || sharing.PLAY_STORE_URL;

module.exports = {
  minSupportedVersion: MIN_SUPPORTED_VERSION,
  latestVersion: LATEST_VERSION,
  iosUpdateUrl: IOS_UPDATE_URL,
  androidUpdateUrl: ANDROID_UPDATE_URL,
};
