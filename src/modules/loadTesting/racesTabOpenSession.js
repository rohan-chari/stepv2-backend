const { PROFILES } = require("./contract");
const {
  compareRacesTabProjection,
  projectRacesTabPayload,
} = require("./racesTabOpenProjection");

function isMap(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function validCompactRacesBody(body) {
  return isMap(body) && body.contract === "race-list-compact-v1" &&
    [body.active, body.pending, body.completed].every(Array.isArray);
}

function validDiscoverySummaryBody(body) {
  const resolved = body?.resolved;
  return isMap(body) && Number.isInteger(body.publicRaceCount) && body.publicRaceCount >= 0 &&
    Array.isArray(body.featuredRaces) && Array.isArray(body.featuredTournaments) &&
    isMap(resolved) && resolved.publicRaceCount === true &&
    resolved.featuredRaces === true && resolved.featuredTournaments === true;
}

function validSummaryFriendsBody(body) {
  return isMap(body) && body.contract === "friends-summary-v1" &&
    Array.isArray(body.friends) && isMap(body.pending) &&
    Array.isArray(body.pending.incoming) && Array.isArray(body.pending.outgoing);
}

function successful(sample) {
  return sample?.timeout !== true && Number(sample?.status) === 200 &&
    sample?.unexpectedStatus !== true;
}

function coreProjection(value = {}) {
  return {
    expectedProjectionVersion: value.expectedProjectionVersion,
    ordinary: value.ordinary,
    ordinaryInventoryByRace: value.ordinaryInventoryByRace,
    ordinaryEffectsByRace: value.ordinaryEffectsByRace,
    tournaments: value.tournaments,
    tournamentMatchByTournament: value.tournamentMatchByTournament,
  };
}

async function runRacesTabOpenSession({
  profile = PROFILES["races-tab-open"], requestOne, fetchImpl, baseUrl, context,
  sequence = 0, timeoutMs, clock = Date.now, onCoreComplete = () => {},
} = {}) {
  if (!profile?.racesTabOpen || typeof requestOne !== "function" || !context) {
    throw new Error("races-tab-open session contract is required");
  }
  const byPath = (pathName) => {
    const entry = profile.entries.find((row) => row.path === pathName);
    if (!entry) throw new Error(`races-tab-open endpoint missing: ${pathName}`);
    return entry;
  };
  const endpointCounts = Object.fromEntries(profile.entries.map((entry) =>
    [`${entry.method} ${entry.path}`, 0]));
  const request = async (entry) => {
    endpointCounts[`${entry.method} ${entry.path}`] += 1;
    return requestOne({ fetchImpl, baseUrl, entry: { ...entry, headers: {
      "X-App-Version": "2.3.11",
      "X-Client-Features": profile.racesTabOpen.clientFeatures.join(","),
      "X-Timezone": "America/New_York",
      "X-Release-Channel": "prod",
      "X-Platform": "ios",
      ...entry.headers,
    } }, context, sequence,
    timeoutMs: timeoutMs || profile.racesTabOpen.requestTimeoutMs,
    sourceChangedExpected: false, captureResponseBody: true });
  };

  const startedAt = clock();
  const coreSample = await request(byPath("/races"));
  const expectedProjection = context.expectedProjection;
  const viewerUserId = context.userId || context.id || context.viewerUserId || null;
  const observedCoreProjection = projectRacesTabPayload({
    core: coreSample.body,
    friendsShouldRequest: context.zeroFriends === true,
    viewerUserId,
  });
  const coreContent = expectedProjection
    ? compareRacesTabProjection(coreProjection(expectedProjection),
      coreProjection(observedCoreProjection))
    : { matches: true, mismatchCount: 0, mismatchCounts: {}, samples: [], truncated: false };
  const coreComplete = successful(coreSample) && validCompactRacesBody(coreSample.body) &&
    coreContent.matches;
  const coreRefreshMs = Math.max(0, clock() - startedAt);
  if (coreComplete) onCoreComplete({ coreRefreshMs, sample: coreSample });

  const discoveryPromise = request(byPath("/races/discovery-summary"));
  const friendsSelected = context.zeroFriends === true;
  const friendsPromise = friendsSelected ? request(byPath("/friends")) : null;
  const [discoverySample, friendsSample] = await Promise.all([
    discoveryPromise,
    friendsPromise || Promise.resolve(null),
  ]);
  const observedProjection = projectRacesTabPayload({
    core: coreSample.body,
    discovery: discoverySample.body,
    friends: friendsSample?.body,
    friendsShouldRequest: friendsSelected,
    viewerUserId,
  });
  const content = expectedProjection
    ? compareRacesTabProjection(expectedProjection, observedProjection)
    : coreContent;
  const discoveryMismatch = Number(content.mismatchCounts.discovery_count || 0) > 0;
  const friendsMismatch = Number(content.mismatchCounts.friends || 0) > 0;
  const discoveryComplete = successful(discoverySample) &&
    validDiscoverySummaryBody(discoverySample.body) && !discoveryMismatch;
  const friendsComplete = !friendsSelected || successful(friendsSample) &&
    validSummaryFriendsBody(friendsSample.body) && !friendsMismatch;
  const elapsedMs = Math.max(0, clock() - startedAt);
  return {
    coreComplete,
    coreRefreshMs,
    core: { sample: coreSample, contractError: successful(coreSample) && !coreComplete },
    discovery: { sample: discoverySample, complete: discoveryComplete,
      contractError: !discoveryComplete },
    friends: { sample: friendsSample, selected: friendsSelected,
      complete: friendsComplete, contractError: friendsSelected && !friendsComplete },
    content: { ...content, observedProjection,
      coverageVariants: Array.isArray(context.coverageVariants)
        ? [...context.coverageVariants] : [] },
    endpointCounts,
    elapsedMs,
    deadlineTimedOut: elapsedMs > profile.racesTabOpen.iterationDeadlineMs,
  };
}

module.exports = {
  runRacesTabOpenSession,
  validCompactRacesBody,
  validDiscoverySummaryBody,
  validSummaryFriendsBody,
};
