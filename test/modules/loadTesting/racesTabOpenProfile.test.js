const assert = require("node:assert/strict");
const test = require("node:test");

const { PROFILES } = require("../../../src/modules/loadTesting/contract");
const {
  runRacesTabOpenSession,
  validCompactRacesBody,
  validDiscoverySummaryBody,
  validSummaryFriendsBody,
} = require("../../../src/modules/loadTesting/racesTabOpenSession");

function response(status, body = {}) {
  return { status, body, timeout: false, unexpectedStatus: false, latencyMs: 1 };
}

test("races-tab-open locks the current read-only endpoint and client contract", () => {
  const profile = PROFILES["races-tab-open"];
  assert.equal(profile.version, "1.0.0");
  assert.equal(profile.racesTabOpen.schema, "races-tab-open-session-v1");
  assert.equal(profile.racesTabOpen.clientHeaderProfile, "current-races-2.3.11-ios-v1");
  assert.deepEqual(profile.entries.map(({ method, path, query, readOnly }) =>
    ({ method, path, query, readOnly })), [
    { method: "GET", path: "/races", query: "view=compact-v1", readOnly: true },
    { method: "GET", path: "/races/discovery-summary", query: null, readOnly: true },
    { method: "GET", path: "/friends", query: "view=summary-v1", readOnly: true },
  ]);
  assert.equal(profile.racesTabOpen.requestTimeoutMs, 15_000);
  assert.equal(profile.racesTabOpen.iterationDeadlineMs, 31_000);
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
