const AUTH_SHELL_FIELDS = [
  "id",
  "email",
  "displayName",
  "firstName",
  "lastName",
  "profilePhotoUrl",
  "profilePhotoPromptDismissedAt",
  "referredByCode",
  "nameSetupOnboardingRequired",
  "nameSetupCompletedAt",
  "renameChipShownCount",
  "renameChipDismissedAt",
  "isAdmin",
  "coins",
  "heldCoins",
  "firstRaceOnboardingSeen",
  "tutorialOnboardingSeen",
  "hiddenFromLeaderboard",
  "autoJoinFeaturedRaces",
  "incomingFriendRequests",
  "characterPowersEnabled",
  "featureFlags",
];

function serializeAuthShellUser(user) {
  const result = {};
  for (const field of AUTH_SHELL_FIELDS) {
    // The compact contract deliberately preserves null-vs-missing capability
    // signals. All allowlisted scalars are present except feature subfields
    // already version-gated by the legacy runtime-flag assembler.
    result[field] = user[field] ?? null;
  }
  result.nameSetupOnboardingRequired = user.nameSetupOnboardingRequired === true;
  result.renameChipShownCount = Number.isInteger(user.renameChipShownCount)
    ? user.renameChipShownCount
    : 0;
  result.isAdmin = user.isAdmin === true;
  result.coins = Number.isInteger(user.coins) ? user.coins : 0;
  result.heldCoins = Number.isInteger(user.heldCoins) ? user.heldCoins : 0;
  result.firstRaceOnboardingSeen = user.firstRaceOnboardingSeen === true;
  result.tutorialOnboardingSeen = user.tutorialOnboardingSeen === true;
  result.hiddenFromLeaderboard = user.hiddenFromLeaderboard === true;
  result.autoJoinFeaturedRaces = user.autoJoinFeaturedRaces === true;
  result.incomingFriendRequests = Number.isInteger(user.incomingFriendRequests)
    ? user.incomingFriendRequests
    : 0;
  result.characterPowersEnabled = false;
  result.featureFlags = user.featureFlags && typeof user.featureFlags === "object"
    ? user.featureFlags
    : {};
  return result;
}

module.exports = { AUTH_SHELL_FIELDS, serializeAuthShellUser };
