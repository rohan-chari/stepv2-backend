const {
  containsDisplayNameProfanity,
} = require("../../../shared/lib/displayNameValidator");

// The one serializer for authenticated own-user envelopes. Raw Prisma rows are
// never spread directly onto the wire: private normalized search text and
// server bookkeeping stay private, while additive identity capability fields
// are present for every client so missing-vs-null remains meaningful.
function serializeAuthenticatedUser(user) {
  const {
    discoverableNameSearch,
    lastAppVersion,
    lastSeenAt,
    metricsV2EligibleAt,
    metricsV2EligibleEpochId,
    metricsV2SignupEligible,
    metricsV2SignupEpochId,
    ...safe
  } = user || {};
  void discoverableNameSearch;
  void lastAppVersion;
  void lastSeenAt;
  void metricsV2EligibleAt;
  void metricsV2EligibleEpochId;
  void metricsV2SignupEligible;
  void metricsV2SignupEpochId;
  return {
    ...safe,
    firstName: user?.firstName ?? null,
    lastName: user?.lastName ?? null,
    nameSetupOnboardingRequired:
      user?.nameSetupOnboardingRequired === true,
    nameSetupCompletedAt: user?.nameSetupCompletedAt ?? null,
    shopTutorialCompletedAt: user?.shopTutorialCompletedAt ?? null,
    displayNameRequiresRename: containsDisplayNameProfanity(user?.displayName),
  };
}

module.exports = { serializeAuthenticatedUser };
