// The one serializer for authenticated own-user envelopes. Raw Prisma rows are
// never spread directly onto the wire: private normalized search text and
// server bookkeeping stay private, while additive identity capability fields
// are present for every client so missing-vs-null remains meaningful.
function serializeAuthenticatedUser(user) {
  const {
    discoverableNameSearch,
    lastAppVersion,
    lastSeenAt,
    ...safe
  } = user || {};
  void discoverableNameSearch;
  void lastAppVersion;
  void lastSeenAt;
  return {
    ...safe,
    firstName: user?.firstName ?? null,
    lastName: user?.lastName ?? null,
    nameSetupOnboardingRequired:
      user?.nameSetupOnboardingRequired === true,
    nameSetupCompletedAt: user?.nameSetupCompletedAt ?? null,
  };
}

module.exports = { serializeAuthenticatedUser };
