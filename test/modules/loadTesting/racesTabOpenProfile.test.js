const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { PROFILES } = require("../../../src/modules/loadTesting/contract");
const {
  runRacesTabOpenSession,
  validCompactRacesBody,
  validDiscoverySummaryBody,
  validSummaryFriendsBody,
} = require("../../../src/modules/loadTesting/racesTabOpenSession");
const { projectRacesTabPayload } = require(
  "../../../src/modules/loadTesting/racesTabOpenProjection");

function response(status, body = {}) {
  return { status, body, timeout: false, unexpectedStatus: false, latencyMs: 1 };
}

test("races-tab-open locks the current read-only endpoint and client contract", () => {
  const profile = PROFILES["races-tab-open"];
  assert.equal(profile.version, "2.0.0");
  assert.equal(profile.racesTabOpen.schema, "races-tab-open-session-v2");
  assert.equal(profile.racesTabOpen.expectedProjectionVersion,
    "races-tab-open-projection-v2");
  assert.equal(profile.racesTabOpen.requiredCoverageVariants.length, 28);
  assert.equal(profile.racesTabOpen.clientHeaderProfile, "current-races-2.3.11-ios-v1");
  assert.deepEqual(profile.entries.map(({ method, path, query, readOnly }) =>
    ({ method, path, query, readOnly })), [
    { method: "GET", path: "/races", query: "view=compact-v1", readOnly: true },
    { method: "GET", path: "/races/discovery-summary", query: null, readOnly: true },
    { method: "GET", path: "/friends", query: "view=summary-v1", readOnly: true },
  ]);
  assert.equal(profile.racesTabOpen.requestTimeoutMs, 15_000);
  assert.equal(profile.racesTabOpen.iterationDeadlineMs, 31_000);
  assert.ok(profile.racesTabOpen.friendsCacheAgeMs > 1_000);
  assert.ok(profile.racesTabOpen.friendsCacheAgeMs < 60_000);
});

test("one successful Races reveal completes core before concurrent selected background work", async () => {
  const events = [];
  let releaseDiscovery;
  let releaseFriends;
  const discoveryWait = new Promise((resolve) => { releaseDiscovery = resolve; });
  const friendsWait = new Promise((resolve) => { releaseFriends = resolve; });
  const promise = runRacesTabOpenSession({
    context: { userIndex: 7, zeroFriends: true }, sequence: 1,
    requestOne: async ({ entry }) => {
      events.push(`start:${entry.path}`);
      if (entry.path === "/races") return response(200, {
        contract: "race-list-compact-v1", active: [], pending: [], completed: [],
      });
      if (entry.path === "/races/discovery-summary") {
        await discoveryWait; events.push("finish:discovery");
        return response(200, { publicRaceCount: 1, featuredRaces: [],
          featuredTournaments: [], resolved: { publicRaceCount: true,
            featuredRaces: true, featuredTournaments: true } });
      }
      await friendsWait; events.push("finish:friends");
      return response(200, { contract: "friends-summary-v1", friends: [],
        pending: { incoming: [], outgoing: [] } });
    },
    onCoreComplete: () => events.push("core:complete"),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.slice(0, 4), [
    "start:/races", "core:complete", "start:/races/discovery-summary", "start:/friends",
  ]);
  releaseFriends(); releaseDiscovery();
  const result = await promise;
  assert.equal(result.coreComplete, true);
  assert.equal(result.discovery.complete, true);
  assert.equal(result.friends.selected, true);
  assert.equal(result.friends.complete, true);
  assert.equal(result.endpointCounts["GET /races"], 1);
  assert.equal(result.endpointCounts["GET /races/discovery-summary"], 1);
  assert.equal(result.endpointCounts["GET /friends"], 1);
});

test("friends branch comes only from fixture client state", async () => {
  const calls = [];
  const result = await runRacesTabOpenSession({
    context: { userIndex: 8, zeroFriends: false }, sequence: 2,
    requestOne: async ({ entry }) => {
      calls.push(entry.path);
      if (entry.path === "/races") return response(200, {
        contract: "race-list-compact-v1", active: [], pending: [], completed: [],
      });
      return response(200, { publicRaceCount: 0, featuredRaces: [],
        featuredTournaments: [], resolved: { publicRaceCount: true,
          featuredRaces: true, featuredTournaments: true } });
    },
  });
  assert.deepEqual(calls, ["/races", "/races/discovery-summary"]);
  assert.equal(result.friends.selected, false);
});

test("response validators fail closed on malformed and unresolved contracts", () => {
  assert.equal(validCompactRacesBody({ contract: "race-list-compact-v1",
    active: [], pending: [], completed: [] }), true);
  assert.equal(validCompactRacesBody({ active: [], pending: [], completed: [] }), false);
  assert.equal(validDiscoverySummaryBody({ publicRaceCount: 0, featuredRaces: [],
    featuredTournaments: [], resolved: { publicRaceCount: true,
      featuredRaces: false, featuredTournaments: true } }), false);
  assert.equal(validSummaryFriendsBody({ contract: "friends-summary-v1", friends: [],
    pending: { incoming: [], outgoing: [] } }), true);
  assert.equal(validSummaryFriendsBody({ friends: [] }), false);
});

test("core failure still launches background and never records false core completion", async () => {
  const calls = [];
  let completed = 0;
  const result = await runRacesTabOpenSession({
    context: { userIndex: 9, zeroFriends: false }, sequence: 3,
    onCoreComplete: () => { completed += 1; },
    requestOne: async ({ entry }) => {
      calls.push(entry.path);
      if (entry.path === "/races") return response(200, { active: [], pending: [], completed: [] });
      return response(404, {});
    },
  });
  assert.deepEqual(calls, ["/races", "/races/discovery-summary"]);
  assert.equal(result.coreComplete, false);
  assert.equal(completed, 0);
  assert.equal(result.discovery.contractError, true);
});

test("timeouts, malformed background, and supported-profile 404 fail closed", async () => {
  const cases = [
    { name: "core timeout", context: { zeroFriends: false },
      responseFor: (path) => path === "/races"
        ? { ...response(0), timeout: true } : response(200, { publicRaceCount: 0,
          featuredRaces: [], featuredTournaments: [], resolved: { publicRaceCount: true,
            featuredRaces: true, featuredTournaments: true } }),
      assertResult: (result) => assert.equal(result.coreComplete, false) },
    { name: "partial discovery", context: { zeroFriends: false },
      responseFor: (path) => path === "/races"
        ? response(200, { contract: "race-list-compact-v1", active: [], pending: [], completed: [] })
        : response(200, { publicRaceCount: 0, featuredRaces: [], featuredTournaments: [],
          resolved: { publicRaceCount: true, featuredRaces: false, featuredTournaments: true } }),
      assertResult: (result) => assert.equal(result.discovery.complete, false) },
    { name: "discovery 404", context: { zeroFriends: false },
      responseFor: (path) => path === "/races"
        ? response(200, { contract: "race-list-compact-v1", active: [], pending: [], completed: [] })
        : response(404),
      assertResult: (result) => assert.equal(result.discovery.contractError, true) },
    { name: "friends timeout", context: { zeroFriends: true },
      responseFor: (path) => path === "/races"
        ? response(200, { contract: "race-list-compact-v1", active: [], pending: [], completed: [] })
        : path === "/friends" ? { ...response(0), timeout: true }
          : response(200, { publicRaceCount: 0, featuredRaces: [], featuredTournaments: [],
            resolved: { publicRaceCount: true, featuredRaces: true, featuredTournaments: true } }),
      assertResult: (result) => assert.equal(result.friends.complete, false) },
  ];
  for (const row of cases) {
    const calls = [];
    const result = await runRacesTabOpenSession({ context: { userIndex: 1, ...row.context },
      requestOne: async ({ entry }) => (calls.push(entry.path), row.responseFor(entry.path)) });
    row.assertResult(result);
    assert.ok(calls.includes("/races/discovery-summary"), `${row.name} launches discovery`);
  }
});

test("iteration deadline is measured across core plus the background tail", async () => {
  const times = [0, 15_000, 31_001];
  const result = await runRacesTabOpenSession({ context: { userIndex: 1, zeroFriends: false },
    clock: () => times.shift() ?? 31_001,
    requestOne: async ({ entry }) => entry.path === "/races"
      ? response(200, { contract: "race-list-compact-v1", active: [], pending: [], completed: [] })
      : response(200, { publicRaceCount: 0, featuredRaces: [], featuredTournaments: [],
        resolved: { publicRaceCount: true, featuredRaces: true, featuredTournaments: true } }) });
  assert.equal(result.coreRefreshMs, 15_000);
  assert.equal(result.deadlineTimedOut, true);
});

test("v2 session rejects content mismatches even when endpoint shapes are valid", async () => {
  const expectedCore = { contract: "race-list-compact-v1", active: [{
    name: "Expected", status: "ACTIVE", creator: { displayName: "Owner" },
    isCreator: false, participantCount: 2, isTeamRace: false,
    isFavorite: false, favoritedAt: null, myPlacement: 1, myPlacementHidden: false,
    slotItems: [], queuedBoxCount: 0, mysteryBoxCount: 0, myActiveEffects: [],
  }], pending: [], completed: [], tournaments: [] };
  const discovery = { publicRaceCount: 2, featuredRaces: [], featuredTournaments: [],
    resolved: { publicRaceCount: true, featuredRaces: true, featuredTournaments: true } };
  const friends = { contract: "friends-summary-v1", friends: [],
    pending: { incoming: [], outgoing: [] } };
  const expectedProjection = projectRacesTabPayload({ core: expectedCore, discovery, friends,
    friendsShouldRequest: true });
  const result = await runRacesTabOpenSession({
    context: { userIndex: 3, zeroFriends: true, expectedProjection,
      expectedProjectionVersion: "races-tab-open-projection-v2" },
    requestOne: async ({ entry }) => entry.path === "/races"
      ? response(200, { ...expectedCore, active: [{ ...expectedCore.active[0], name: "Wrong" }] })
      : entry.path === "/friends" ? response(200, friends) : response(200, discovery),
  });
  assert.equal(result.coreComplete, false);
  assert.equal(result.content.matches, false);
  assert.equal(result.content.mismatchCounts.ordinary_field, 1);
  assert.equal(result.content.samples[0].path, "ordinary.active.0.name");
});

test("k6 session preserves core-first, parallel background, exact accounting, and bounded deadlines", () => {
  const source = fs.readFileSync(path.resolve(__dirname,
    "../../../scripts/k6/races-tab-open.js"), "utf8");
  assert.match(source, /ITERATION_DEADLINE_MS = 31_000/);
  assert.match(source, /REQUEST_TIMEOUT = "15s"/);
  assert.match(source, /gracefulStop: "32s"/);
  assert.match(source, /http\.request\(\.\.\.request\("\/races\?view=compact-v1"/);
  assert.match(source, /discoveryPromise = http\.asyncRequest[\s\S]*friendsPromise = http\.asyncRequest[\s\S]*Promise\.all/);
  assert.match(source, /user\.zeroFriends === true/);
  assert.match(source, /races_tab_sessions_started\{phase:measurement\}.*count==/);
  assert.match(source, /races_tab_friends_started\{phase:measurement\}.*count==\$\{expectedFriends\}/);
  assert.match(source, /K6_RACES_TAB_CORE_P95_MS/);
  assert.match(source, /K6_RACES_TAB_CORE_P99_MS/);
  assert.match(source, /K6_RACES_TAB_HTTP_ERROR_RATE/);
  assert.match(source,
    /http_reqs\{endpoint:\$\{endpoint\},phase:measurement,telemetry:sut\}/);
  assert.match(source,
    /races_tab_endpoint_response_bytes\{endpoint:\$\{endpoint\},phase:measurement\}/);
  assert.doesNotMatch(source, /Math\.random/);
});
