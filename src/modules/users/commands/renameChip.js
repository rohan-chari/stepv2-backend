const { User } = require("../models/user");

// Home SETUP section — rename-chip nudge state
// (docs/home-setup-section-requirements.md §4.2/§4.3).
//
// The chip's "shown"/"dismissed" state used to live in device-scoped
// SharedPreferences, which the client wipes on sign-out. These commands move it
// onto the account so it survives a sign-out/sign-in cycle.
//
// Follows the buildX(dependencies) factory pattern of ./profilePhoto.js so tests
// can inject a fake User model and pin the clock.

// Records one impression of the rename chip. Clamped, and a no-op when the user
// has already dismissed the chip. Never throws for "already dismissed" /
// "already at the ceiling" — both return the unchanged user so the route can
// answer 200 (a nudge impression is not worth an error the client would have to
// handle).
function buildRecordRenameChipShown(dependencies = {}) {
  const userModel = dependencies.User || User;

  return async function recordRenameChipShown({ userId }) {
    return userModel.recordRenameChipShown(userId);
  };
}

// Retires the rename chip. Idempotent: a second call returns the existing
// timestamp rather than re-stamping, so a double-tap can't move it.
function buildDismissRenameChip(dependencies = {}) {
  const userModel = dependencies.User || User;
  const now = dependencies.now || (() => new Date());

  return async function dismissRenameChip({ userId }) {
    return userModel.dismissRenameChip(userId, now());
  };
}

const recordRenameChipShown = buildRecordRenameChipShown();
const dismissRenameChip = buildDismissRenameChip();

module.exports = {
  buildRecordRenameChipShown,
  buildDismissRenameChip,
  recordRenameChipShown,
  dismissRenameChip,
};
