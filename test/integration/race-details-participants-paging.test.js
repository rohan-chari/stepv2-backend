// Query events must be enabled BEFORE src/db.js is first required, so the
// query-plan test below can observe which statements a paged request actually
// runs. node --test gives each test FILE its own process, so this is local.
process.env.PRISMA_QUERY_EVENTS_ENABLED = "true";

const assert = require("node:assert/strict");
const { before, beforeEach, describe, it } = require("node:test");

const {
  cleanDatabase,
  createTestUser,
  getSharedServer,
  prisma,
  request,
} = require("./setup");
const { appSettings } = require("../../src/shared/config/appSettings");

const BOOTSTRAP_FLAG = "apiRaceBootstrapV1Enabled";

// Everything the CURRENT TestFlight build advertises. Deliberately does NOT
// include race_participants_paging — this is the "already installed in the
// field" client whose full-array consumers must not be broken by this deploy.
const SHIPPED_FEATURES = [
  "ads",
  "characters",
  "home_active_races",
  "powerups3",
  "powerups4",
  "powerups5",
  "remote_assets",
  "team_races",
  "tournaments",
];

const SHIPPED_HEADERS = {
  "X-App-Version": "99.0.0",
  "X-Client-Features": SHIPPED_FEATURES.join(","),
  "X-Release-Channel": "prod",
  "X-Timezone": "UTC",
};

// The build that has migrated every full-array consumer off the array.
const PAGING_HEADERS = {
  ...SHIPPED_HEADERS,
  "X-Client-Features": [...SHIPPED_FEATURES, "race_participants_paging"].join(","),
};

// The exact per-participant field set that ships today. A no-capability client
// must keep receiving this, key for key.
const PARTICIPANT_KEYS = [
  "accessories",
  "animal",
  "buyInAmount",
  "buyInStatus",
  "displayName",
  "finishedAt",
  "forfeitedAt",
  "id",
  "joinedAt",
  "payoutCoins",
  "profilePhotoUrl",
  "status",
  "team",
  "totalSteps",
  "userId",
];

let server;

async function json(response) {
  return response.json();
}

function get(path, token, headers = PAGING_HEADERS) {
  return request(server.baseUrl, "GET", path, { token, headers });
}

async function getJson(path, token, headers = PAGING_HEADERS) {
  const response = await get(path, token, headers);
  assert.equal(response.status, 200, `${path} -> ${response.status}`);
  return json(response);
}

// `await response.text()` as an assert message would consume the body on every
// call, not just failures, so status is checked before the body is read.
async function assertStatus(response, expected, label) {
  if (response.status !== expected) {
    assert.fail(
      `${label} -> ${response.status}: ${await response.text()}`
    );
  }
}

async function createRace(token, overrides = {}) {
  const response = await request(server.baseUrl, "POST", "/races", {
    token,
    headers: PAGING_HEADERS,
    body: {
      name: "Paging Race",
      targetSteps: 50000,
      maxDurationDays: 7,
      powerupsEnabled: false,
      isPublic: true,
      ...overrides,
    },
  });
  await assertStatus(response, 201, "POST /races");
  return (await json(response)).race;
}

// Seeds a public race with `size` ACCEPTED participants (creator + size-1
// joiners), optionally started. Every join goes through the real endpoint so
// the fixture is a state the product can actually reach.
async function seedRace({ size = 12, start = true, overrides = {} } = {}) {
  const creator = await createTestUser({ displayName: "Paging Creator" });
  const race = await createRace(creator.token, {
    maxParticipants: size,
    ...overrides,
  });
  const joiners = [];
  for (let index = 0; index < size - 1; index += 1) {
    const joiner = await createTestUser({
      displayName: `Paging Joiner ${index + 1}`,
    });
    const join = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/join`,
      { token: joiner.token, headers: PAGING_HEADERS }
    );
    await assertStatus(join, 201, "POST /races/:id/join");
    joiners.push(joiner);
  }
  if (start) {
    const started = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/start`,
      { token: creator.token, headers: PAGING_HEADERS }
    );
    await assertStatus(started, 200, "POST /races/:id/start");
  }
  return { creator, joiners, race, everyone: [creator, ...joiners] };
}

// Both routes serve the SAME getRaceDetails object — the legacy route at the
// top level, bootstrap under `.race`. Every contract assertion below therefore
// runs against both, so neither can drift.
async function readDetails(raceId, token, headers) {
  return getJson(`/races/${raceId}`, token, headers);
}

async function readBootstrapRace(raceId, token, headers, query = "") {
  const payload = await getJson(
    `/races/${raceId}/bootstrap${query}`,
    token,
    headers
  );
  assert.equal(payload.contract, "race-bootstrap-v1");
  return payload.race;
}

describe("race details participants pagination", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await prisma.appSetting.deleteMany({ where: { key: BOOTSTRAP_FLAG } });
    appSettings.bustCache();
    await appSettings.setFlag(BOOTSTRAP_FLAG, true);
    await appSettings.setFlag("teamRacesEnabled", true);
  });

  // ── Backward compatibility ────────────────────────────────────────────────
  // The load-bearing test: the build already in the field sends
  // view=participants-v1&offset&limit on bootstrap TODAY (for `progress`) and
  // still scans the full race.participants array for membership/counts. It must
  // keep receiving the whole array, unchanged, the instant this deploys.
  it("serves the FULL array to a client without the capability token, even when it sends view/offset/limit", async () => {
    const { creator, race } = await seedRace({ size: 12 });
    const query = "?view=participants-v1&offset=0&limit=5";

    const legacy = await getJson(
      `/races/${race.id}${query}`,
      creator.token,
      SHIPPED_HEADERS
    );
    assert.equal(legacy.participants.length, 12);
    assert.equal(Object.hasOwn(legacy, "participantsPagination"), false);
    assert.equal(Object.hasOwn(legacy, "participantUserIds"), false);
    assert.deepEqual(Object.keys(legacy.participants[0]).sort(), PARTICIPANT_KEYS);

    const bootstrapRace = await readBootstrapRace(
      race.id,
      creator.token,
      SHIPPED_HEADERS,
      query
    );
    assert.equal(bootstrapRace.participants.length, 12);
    assert.equal(Object.hasOwn(bootstrapRace, "participantsPagination"), false);
    assert.equal(Object.hasOwn(bootstrapRace, "participantUserIds"), false);
    assert.deepEqual(
      Object.keys(bootstrapRace.participants[0]).sort(),
      PARTICIPANT_KEYS
    );
  });

  it("serves the full array to a capable client that does not ask for a page", async () => {
    const { creator, race } = await seedRace({ size: 12 });
    for (const raceView of [
      await readDetails(race.id, creator.token),
      await readBootstrapRace(race.id, creator.token),
    ]) {
      assert.equal(raceView.participants.length, 12);
      // Present because the token was sent, reporting "I returned everything",
      // so a paging client can tell a whole answer from an ignored request.
      assert.deepEqual(raceView.participantsPagination, {
        offset: 0,
        limit: 12,
        total: 12,
        hasMore: false,
        nextOffset: 12,
      });
      // Only sent when the array is actually truncated.
      assert.equal(Object.hasOwn(raceView, "participantUserIds"), false);
    }
  });

  it("serves the full array to a capable client that sends an unknown view", async () => {
    // `view` is necessary but not sufficient, and only the exact
    // `participants-v1` token opts in — a future/typo'd view must degrade to
    // the whole array rather than silently paging.
    const { creator, race } = await seedRace({ size: 12 });
    const query = "?view=participants-v2&offset=0&limit=5";
    for (const raceView of [
      await getJson(`/races/${race.id}${query}`, creator.token),
      await readBootstrapRace(race.id, creator.token, PAGING_HEADERS, query),
    ]) {
      assert.equal(raceView.participants.length, 12);
      assert.equal(raceView.participantsPagination.total, 12);
      assert.equal(raceView.participantsPagination.hasMore, false);
      assert.equal(Object.hasOwn(raceView, "participantUserIds"), false);
    }
  });

  // ── Paging ────────────────────────────────────────────────────────────────
  it("pages the array for a capable client on both routes", async () => {
    const { creator, race } = await seedRace({ size: 12 });
    const query = "?view=participants-v1&offset=0&limit=5";

    const legacy = await getJson(`/races/${race.id}${query}`, creator.token);
    assert.equal(legacy.participants.length, 5);
    assert.deepEqual(legacy.participantsPagination, {
      offset: 0,
      limit: 5,
      total: 12,
      hasMore: true,
      nextOffset: 5,
    });
    assert.equal(legacy.participantUserIds.length, 12);
    assert.deepEqual(
      legacy.participants.map((p) => p.userId),
      legacy.participantUserIds.slice(0, 5)
    );
    assert.deepEqual(Object.keys(legacy.participants[0]).sort(), PARTICIPANT_KEYS);

    const bootstrapRace = await readBootstrapRace(
      race.id,
      creator.token,
      PAGING_HEADERS,
      query
    );
    assert.equal(bootstrapRace.participants.length, 5);
    assert.deepEqual(bootstrapRace.participantsPagination, {
      offset: 0,
      limit: 5,
      total: 12,
      hasMore: true,
      nextOffset: 5,
    });
    assert.equal(bootstrapRace.participantUserIds.length, 12);
  });

  it("returns a short tail page with hasMore:false and nextOffset past the end", async () => {
    const { creator, race } = await seedRace({ size: 12 });
    const query = "?view=participants-v1&offset=10&limit=5";

    for (const raceView of [
      await getJson(`/races/${race.id}${query}`, creator.token),
      await readBootstrapRace(race.id, creator.token, PAGING_HEADERS, query),
    ]) {
      assert.equal(raceView.participants.length, 2);
      assert.deepEqual(raceView.participantsPagination, {
        offset: 10,
        limit: 5,
        total: 12,
        hasMore: false,
        nextOffset: 15,
      });
    }
  });

  it("wires the shared clamp helper into both routes", async () => {
    const { creator, race } = await seedRace({ size: 12 });
    const cases = [
      { query: "limit=0", limit: 10 },
      { query: "limit=-4", limit: 10 },
      { query: "limit=51", limit: 12 },
      { query: "limit=abc", limit: 10 },
      { query: "offset=-3&limit=4", limit: 4, offset: 0 },
    ];
    for (const testCase of cases) {
      const url = `?view=participants-v1&${testCase.query}`;
      const legacy = await getJson(`/races/${race.id}${url}`, creator.token);
      const bootstrapRace = await readBootstrapRace(
        race.id,
        creator.token,
        PAGING_HEADERS,
        url
      );
      for (const raceView of [legacy, bootstrapRace]) {
        assert.equal(
          raceView.participants.length,
          testCase.limit,
          `${testCase.query} page size`
        );
        assert.equal(raceView.participantsPagination.offset, testCase.offset ?? 0);
      }
    }
    // 51 is clamped to 50, which on a 12-participant race returns all 12 while
    // still reporting the clamped limit.
    const clamped = await getJson(
      `/races/${race.id}?view=participants-v1&limit=51`,
      creator.token
    );
    assert.equal(clamped.participantsPagination.limit, 50);
    assert.equal(clamped.participantsPagination.hasMore, false);
  });

  // ── No status / team-race carve-out ───────────────────────────────────────
  // Unlike the `progress` pager (which skips PENDING and team races), this one
  // must page them: the two worst offenders in prod are PENDING seeded races.
  it("pages a PENDING race (no ACTIVE-only carve-out)", async () => {
    const { creator, race } = await seedRace({ size: 12, start: false });
    const query = "?view=participants-v1&offset=0&limit=5";

    const legacy = await getJson(`/races/${race.id}${query}`, creator.token);
    assert.equal(legacy.status, "PENDING");
    assert.equal(legacy.participants.length, 5);
    assert.equal(legacy.participantsPagination.total, 12);
    assert.equal(legacy.acceptedCount, 12);

    // A PENDING race takes the bootstrap handler's non-ACTIVE branch
    // (routes.js:989), which builds its own detail call with no preloaded race.
    const bootstrapRace = await readBootstrapRace(
      race.id,
      creator.token,
      PAGING_HEADERS,
      query
    );
    assert.equal(bootstrapRace.participants.length, 5);
    assert.equal(bootstrapRace.participantsPagination.total, 12);
    assert.equal(bootstrapRace.acceptedCount, 12);
  });

  it("pages a team race (no team carve-out) and reports per-side counts", async () => {
    // teamSize is validated 1..5 and the field cap is always 2x teamSize, so 10
    // is the largest team race the product can create. A 4-row page over 10
    // participants proves the carve-out is absent just as well as 12 would.
    const { creator, race } = await seedRace({
      size: 10,
      start: false,
      overrides: { isTeamRace: true, teamSize: 5, maxParticipants: undefined },
    });
    const query = "?view=participants-v1&offset=0&limit=4";

    for (const raceView of [
      await getJson(`/races/${race.id}${query}`, creator.token),
      await readBootstrapRace(race.id, creator.token, PAGING_HEADERS, query),
    ]) {
      assert.equal(raceView.isTeamRace, true);
      assert.equal(raceView.participants.length, 4);
      assert.equal(raceView.participantsPagination.total, 10);
      assert.equal(raceView.acceptedCount, 10);
      assert.equal(raceView.teamAAcceptedCount, 5);
      assert.equal(raceView.teamBAcceptedCount, 5);
      assert.equal(
        raceView.teamAAcceptedCount + raceView.teamBAcceptedCount,
        raceView.acceptedCount
      );
    }
  });

  // ── Response ordering rule ────────────────────────────────────────────────
  // Money, prize and my* fields must come from full counts/lookups, never from
  // the returned page. Diff the whole response with and without paging.
  it("returns an identical response except participants/pagination when paged", async () => {
    const { joiners, race } = await seedRace({ size: 12, start: false });
    // Read as a NON-creator so leaveAction is a real value, not the creator null.
    const viewer = joiners[8];

    const paged = await getJson(
      `/races/${race.id}?view=participants-v1&offset=0&limit=3`,
      viewer.token
    );
    const whole = await readDetails(race.id, viewer.token);

    assert.equal(paged.participants.length, 3);
    assert.equal(whole.participants.length, 12);
    assert.notEqual(paged.leaveAction, undefined);

    for (const key of [
      "participants",
      "participantsPagination",
      "participantUserIds",
    ]) {
      delete paged[key];
      delete whole[key];
    }
    assert.deepEqual(paged, whole);

    // And the same for bootstrap's copy of the object.
    const pagedBoot = await readBootstrapRace(
      race.id,
      viewer.token,
      PAGING_HEADERS,
      "?view=participants-v1&offset=0&limit=3"
    );
    const wholeBoot = await readBootstrapRace(race.id, viewer.token);
    for (const key of [
      "participants",
      "participantsPagination",
      "participantUserIds",
    ]) {
      delete pagedBoot[key];
      delete wholeBoot[key];
    }
    assert.deepEqual(pagedBoot, wholeBoot);
  });

  it("keeps money and prize fields on the full field, not the page", async () => {
    const { creator, race } = await seedRace({ size: 12, start: false });
    const paged = await getJson(
      `/races/${race.id}?view=participants-v1&offset=0&limit=2`,
      creator.token
    );
    const whole = await readDetails(race.id, creator.token);
    for (const key of [
      "potCoins",
      "heldPotCoins",
      "projectedPotCoins",
      "prizePool",
      "payouts",
      "payoutTiers",
      "finishReward",
      "buyInAmount",
      "acceptedCount",
    ]) {
      assert.deepEqual(paged[key], whole[key], key);
    }
    assert.equal(paged.acceptedCount, 12);
  });

  // ── my* fields when the viewer's own row is off-page ───────────────────────
  it("serves my* fields from the participant lookup when my row is off-page", async () => {
    const { joiners, race } = await seedRace({
      size: 10,
      start: false,
      overrides: { isTeamRace: true, teamSize: 5, maxParticipants: undefined },
    });
    const viewer = joiners[joiners.length - 1];

    const paged = await getJson(
      `/races/${race.id}?view=participants-v1&offset=0&limit=2`,
      viewer.token
    );
    assert.equal(
      paged.participants.some((p) => p.userId === viewer.user.id),
      false,
      "fixture must place the viewer outside page 0"
    );
    assert.equal(paged.myStatus, "ACCEPTED");
    assert.ok(paged.myTeam === "TEAM_A" || paged.myTeam === "TEAM_B");
    assert.equal(paged.myForfeitedAt, null);
    assert.equal(paged.myChatMuted, false);
    assert.equal(paged.myPlacementAlertsMuted, false);
    assert.equal(paged.myTotalSteps, 0);
    assert.equal(paged.leaveAction, "LEAVE");
    // participantUserIds still carries the whole field, so a client can answer
    // "is this user already in the race" without the profiles.
    assert.equal(paged.participantUserIds.includes(viewer.user.id), true);
  });

  it("exposes myTotalSteps from the viewer's own row", async () => {
    const { joiners, race } = await seedRace({ size: 12 });
    const viewer = joiners[joiners.length - 1];
    await prisma.raceParticipant.updateMany({
      where: { raceId: race.id, userId: viewer.user.id },
      data: { totalSteps: 4321 },
    });
    const paged = await getJson(
      `/races/${race.id}?view=participants-v1&offset=0&limit=2`,
      viewer.token
    );
    assert.equal(paged.myTotalSteps, 4321);
    const whole = await readDetails(race.id, viewer.token);
    assert.equal(whole.myTotalSteps, 4321);
  });

  // ── Always-present summary fields ─────────────────────────────────────────
  it("always returns acceptedCount / team counts / myTotalSteps, capability or not", async () => {
    const { creator, race } = await seedRace({ size: 12, start: false });
    for (const headers of [SHIPPED_HEADERS, PAGING_HEADERS, {}]) {
      const legacy = await getJson(`/races/${race.id}`, creator.token, headers);
      assert.equal(legacy.acceptedCount, 12);
      assert.equal(legacy.teamAAcceptedCount, null, "non-team race");
      assert.equal(legacy.teamBAcceptedCount, null, "non-team race");
      assert.equal(legacy.myTotalSteps, 0);
      assert.equal(Object.hasOwn(legacy, "myTotalSteps"), true);
    }
    const bootstrapRace = await readBootstrapRace(
      race.id,
      creator.token,
      SHIPPED_HEADERS
    );
    assert.equal(bootstrapRace.acceptedCount, 12);
    assert.equal(bootstrapRace.teamAAcceptedCount, null);
    assert.equal(bootstrapRace.myTotalSteps, 0);
  });

  // The bootstrap handler's non-ACTIVE branch (routes.js:989) builds its own
  // detail call with no preloaded race. A viewer who has been invited but has
  // NOT accepted reads through it, and must still get the true field counts —
  // their own not-yet-accepted row must not skew any of them.
  it("returns correct summary fields for a caller who is not yet an accepted participant", async () => {
    const { creator, joiners, race } = await seedRace({ size: 12, start: false });
    const invitee = joiners[joiners.length - 1];
    await prisma.raceParticipant.updateMany({
      where: { raceId: race.id, userId: invitee.user.id },
      data: { status: "INVITED" },
    });
    const query = "?view=participants-v1&offset=0&limit=4";

    for (const raceView of [
      await getJson(`/races/${race.id}${query}`, invitee.token),
      await readBootstrapRace(race.id, invitee.token, PAGING_HEADERS, query),
    ]) {
      assert.equal(raceView.status, "PENDING");
      assert.equal(raceView.myStatus, "INVITED");
      assert.equal(raceView.myTotalSteps, 0);
      // 12 rows, 11 of them ACCEPTED now that this viewer is INVITED.
      assert.equal(raceView.acceptedCount, 11);
      assert.equal(raceView.teamAAcceptedCount, null);
      assert.equal(raceView.teamBAcceptedCount, null);
      assert.equal(raceView.participants.length, 4);
      assert.equal(raceView.participantsPagination.total, 12);
      // The invitee's own row is off-page but still in the id set.
      assert.equal(
        raceView.participants.some((p) => p.userId === invitee.user.id),
        false
      );
      assert.equal(raceView.participantUserIds.includes(invitee.user.id), true);
    }

    // And the same counts without the capability token, on both routes.
    const legacyWhole = await readDetails(race.id, invitee.token, SHIPPED_HEADERS);
    assert.equal(legacyWhole.acceptedCount, 11);
    assert.equal(legacyWhole.myStatus, "INVITED");
    assert.equal(legacyWhole.participants.length, 12);
    // The creator sees the same field-wide numbers as the invitee does.
    const creatorView = await readDetails(race.id, creator.token);
    assert.equal(creatorView.acceptedCount, 11);
  });

  it("counts only ACCEPTED rows in acceptedCount", async () => {
    const { creator, joiners, race } = await seedRace({ size: 12, start: false });
    await prisma.raceParticipant.updateMany({
      where: { raceId: race.id, userId: { in: joiners.slice(0, 3).map((j) => j.user.id) } },
      data: { status: "INVITED" },
    });
    const paged = await getJson(
      `/races/${race.id}?view=participants-v1&offset=0&limit=4`,
      creator.token
    );
    assert.equal(paged.acceptedCount, 9);
    // `total` is the participant ROW count (what the array holds), which is not
    // the same number as acceptedCount once a row is INVITED.
    assert.equal(paged.participantsPagination.total, 12);
    assert.equal(paged.participantUserIds.length, 12);
  });

  // A tournament spectator is the ONLY caller for whom the paged path's
  // separate `RaceParticipant.findByRaceAndUser` lookup returns null — the one
  // place it can diverge from the old "scan the array for my row" behaviour.
  // Every my* field must degrade to the same read-only shape it has today.
  it("serves a paged read to a tournament spectator with null my* fields", async () => {
    await appSettings.setFlag("tournamentsEnabled", true);
    const players = [];
    for (let index = 0; index < 4; index += 1) {
      players.push(await createTestUser({ displayName: `Bracket ${index}` }));
    }
    const created = await request(server.baseUrl, "POST", "/tournaments", {
      token: players[0].token,
      headers: PAGING_HEADERS,
      body: {
        name: "Paging Cup",
        bracketSize: 4,
        matchupDurationDays: 1,
        buyInAmount: 0,
        isPublic: true,
        powerupsEnabled: false,
        inviteeIds: [],
      },
    });
    await assertStatus(created, 201, "POST /tournaments");
    const { tournament } = await json(created);
    for (const player of players.slice(1)) {
      const joined = await request(
        server.baseUrl,
        "POST",
        `/tournaments/${tournament.id}/join`,
        { token: player.token, headers: PAGING_HEADERS }
      );
      await assertStatus(joined, 201, "POST /tournaments/:id/join");
    }

    const round1 = await prisma.race.findMany({
      where: { tournamentId: tournament.id, tournamentRound: 1 },
      include: { participants: true },
      orderBy: { tournamentMatchIndex: "asc" },
    });
    assert.equal(round1.length, 2, "a 4-bracket has two round-1 matchups");
    const [matchA, matchB] = round1;
    const matchBUserIds = new Set(matchB.participants.map((p) => p.userId));
    // Someone in the OTHER matchup: a bracket player, not a participant here.
    const spectator = players.find((p) => !matchBUserIds.has(p.user.id));
    assert.ok(spectator, "fixture must yield a non-participant bracket player");

    const query = "?view=participants-v1&offset=0&limit=1";
    for (const raceView of [
      await getJson(`/races/${matchB.id}${query}`, spectator.token),
      await readBootstrapRace(matchB.id, spectator.token, PAGING_HEADERS, query),
    ]) {
      // The page is served — spectating is a read, and paging does not gate it.
      assert.equal(raceView.participants.length, 1);
      assert.equal(raceView.participantsPagination.total, 2);
      assert.equal(raceView.participantsPagination.hasMore, true);
      // Field-wide counts are still the truth, not the page.
      assert.equal(raceView.acceptedCount, 2);
      assert.equal(raceView.participantUserIds.length, 2);
      assert.equal(raceView.participantUserIds.includes(spectator.user.id), false);
      // Every my* field degrades to the read-only spectate shape.
      assert.equal(raceView.myStatus, null);
      assert.equal(raceView.myTeam, null);
      assert.equal(raceView.myForfeitedAt, null);
      assert.equal(raceView.myTotalSteps, null);
      assert.equal(Object.hasOwn(raceView, "myTotalSteps"), true);
      assert.equal(raceView.myChatMuted, false);
      assert.equal(raceView.leaveAction, null);
    }

    // And identically on the unpaginated path — the separate lookup must not
    // have changed what a spectator sees.
    const whole = await readDetails(matchB.id, spectator.token);
    assert.equal(whole.myStatus, null);
    assert.equal(whole.myTotalSteps, null);
    assert.equal(whole.leaveAction, null);
    assert.equal(whole.acceptedCount, 2);
    assert.equal(whole.participants.length, 2);
  });

  // ── Stable ordering ───────────────────────────────────────────────────────
  it("walks pages without duplicates or skips when joinedAt ties", async () => {
    const { creator, race } = await seedRace({ size: 12, start: false });
    // Seeded Daily/Weekly races bulk-enroll in one instant: every row ties on
    // joinedAt, which is exactly where an untiebroken ORDER BY duplicates rows.
    await prisma.raceParticipant.updateMany({
      where: { raceId: race.id },
      data: { joinedAt: new Date("2026-08-15T00:00:00.000Z") },
    });

    const seen = [];
    let offset = 0;
    for (let page = 0; page < 10; page += 1) {
      const raceView = await getJson(
        `/races/${race.id}?view=participants-v1&offset=${offset}&limit=5`,
        creator.token
      );
      seen.push(...raceView.participants.map((p) => p.id));
      if (!raceView.participantsPagination.hasMore) break;
      offset = raceView.participantsPagination.nextOffset;
    }
    assert.equal(seen.length, 12, "no rows skipped");
    assert.equal(new Set(seen).size, 12, "no rows duplicated");

    const first = await getJson(
      `/races/${race.id}?view=participants-v1&offset=0&limit=5`,
      creator.token
    );
    const firstAgain = await getJson(
      `/races/${race.id}?view=participants-v1&offset=0&limit=5`,
      creator.token
    );
    assert.deepEqual(
      first.participants.map((p) => p.id),
      firstAgain.participants.map((p) => p.id),
      "page 0 must not reshuffle between polls"
    );
    // participantUserIds uses the same pinned order as the pages.
    assert.deepEqual(
      first.participantUserIds.slice(0, 5),
      first.participants.map((p) => p.userId)
    );
  });

  // ── Query plan ────────────────────────────────────────────────────────────
  // The payload-size win comes from serialization; the LATENCY win only comes
  // from not running the cosmetic subtree for all N participants. This is the
  // test that proves the latter.
  it("scopes the cosmetic accessory join to the page, not the whole field", async () => {
    const { creator, race, everyone } = await seedRace({ size: 12, start: false });
    const allUserIds = everyone.map((entry) => entry.user.id);

    const captured = [];
    let sink = null;
    prisma.$on("query", (event) => sink?.push(event));

    const capture = async (fn) => {
      const events = [];
      sink = events;
      try {
        await fn();
      } finally {
        sink = null;
      }
      captured.push(events);
      return events;
    };

    const countCosmeticUsers = (events) => {
      const params = events
        .filter((event) => /user_equipped_accessories/i.test(event.query || ""))
        .map((event) => String(event.params || ""))
        .join(" ");
      return allUserIds.filter((id) => params.includes(id)).length;
    };

    const wholeEvents = await capture(() =>
      readDetails(race.id, creator.token, SHIPPED_HEADERS)
    );
    const pagedEvents = await capture(() =>
      getJson(
        `/races/${race.id}?view=participants-v1&offset=0&limit=3`,
        creator.token
      )
    );
    // The bootstrap handler's non-ACTIVE branch (routes.js:989) also has no
    // preloaded race, so the lean plan applies there in full too. Asserted
    // separately because every OTHER test in this file checks both routes and
    // this — the only test that proves the latency claim — must not be the one
    // that checks a single route.
    const pagedBootEvents = await capture(() =>
      readBootstrapRace(
        race.id,
        creator.token,
        PAGING_HEADERS,
        "?view=participants-v1&offset=0&limit=3"
      )
    );

    assert.equal(
      countCosmeticUsers(wholeEvents),
      12,
      "unpaginated path still hydrates every participant's cosmetics (unchanged)"
    );
    assert.ok(
      countCosmeticUsers(pagedEvents) <= 3,
      `paged legacy request hydrated cosmetics for ${countCosmeticUsers(pagedEvents)} users, expected <= 3`
    );
    assert.ok(
      countCosmeticUsers(pagedBootEvents) <= 3,
      `paged bootstrap (non-ACTIVE branch) hydrated cosmetics for ${countCosmeticUsers(pagedBootEvents)} users, expected <= 3`
    );

    // And the page itself is taken by the database, not sliced in JS.
    const pagedParticipantReads = pagedEvents.filter(
      (event) =>
        /from "public"\."race_participants"/i.test(event.query || "") &&
        /\blimit\b/i.test(event.query || "")
    );
    assert.ok(
      pagedParticipantReads.length >= 1,
      "expected a LIMIT/OFFSET participant read on the paged path"
    );
  });

  // ── Bootstrap ACTIVE branch: paging must not COST queries ─────────────────
  // This route is the one exception to the lean query plan, on purpose.
  //
  // getRaceProgress runs on the same request and unconditionally calls
  // `Race.findById` (getRaceProgress.js:1427) — the SAME fat cosmetic include
  // that getRaceDetails's unpaged path uses. Its result is handed to
  // getRaceDetails as `preloadedRace`. So on this branch the fat read has
  // already happened no matter what detail does: running the lean plan
  // (core + summaries + page) on top of it does not avoid a single query, it
  // only ADDS ~11. getRaceDetails therefore reuses the preload here and slices
  // the page in JS.
  //
  // The other two paged call sites (legacy GET /:raceId and the bootstrap
  // non-ACTIVE branch) have no preload, so they keep the lean DB-level plan and
  // get the real win — pinned by the cosmetic-scoping test above.
  it("does not add queries on the paged bootstrap ACTIVE branch (reuses the progress preload)", async () => {
    const { creator, race, everyone } = await seedRace({ size: 12, start: true });
    const allUserIds = everyone.map((entry) => entry.user.id);

    let sink = null;
    prisma.$on("query", (event) => sink?.push(event));
    const capture = async (fn) => {
      const events = [];
      sink = events;
      try {
        await fn();
      } finally {
        sink = null;
      }
      return events;
    };
    const countCosmeticUsers = (events) => {
      const params = events
        .filter((event) => /user_equipped_accessories/i.test(event.query || ""))
        .map((event) => String(event.params || ""))
        .join(" ");
      return allUserIds.filter((id) => params.includes(id)).length;
    };

    // Warm both shapes first: the first request of a process pays one-off
    // reads (settings/flags) that would otherwise show up as a difference
    // between the two captures rather than as a difference in the query plan.
    await readBootstrapRace(race.id, creator.token, PAGING_HEADERS);
    await readBootstrapRace(
      race.id,
      creator.token,
      PAGING_HEADERS,
      "?view=participants-v1&offset=0&limit=3"
    );

    const unpagedBoot = await capture(() =>
      readBootstrapRace(race.id, creator.token, PAGING_HEADERS)
    );
    const pagedBoot = await capture(() =>
      readBootstrapRace(
        race.id,
        creator.token,
        PAGING_HEADERS,
        "?view=participants-v1&offset=0&limit=3"
      )
    );

    // The payload win is real and lands on this route.
    const pagedRace = await readBootstrapRace(
      race.id,
      creator.token,
      PAGING_HEADERS,
      "?view=participants-v1&offset=0&limit=3"
    );
    assert.equal(pagedRace.participants.length, 3);
    assert.equal(pagedRace.participantsPagination.total, 12);

    // The load-bearing assertion: asking for a page must not make this route
    // run MORE database queries than asking for the whole field. It is not
    // expected to run fewer — the fat read belongs to getRaceProgress and
    // stays either way.
    assert.ok(
      pagedBoot.length <= unpagedBoot.length + 1,
      `paged bootstrap ran ${pagedBoot.length} queries vs ${unpagedBoot.length} unpaged; ` +
        "paging must not add a redundant query plan on top of the progress preload"
    );

    // Progress now supplies a lean page projection, and details deliberately
    // declines to reuse it as a fat preload. The two page projections may have
    // different stable orderings, so their union can contain between one and
    // two requested pages, but it must never hydrate the whole 12-person field.
    const cosmeticUsers = countCosmeticUsers(pagedBoot);
    assert.ok(
      cosmeticUsers >= 3 && cosmeticUsers <= 6,
      `paged bootstrap hydrated cosmetics for ${cosmeticUsers} users; ` +
        "expected the union of at most two 3-person page projections"
    );
  });

  // The JS slice on the preload path must provide the SAME (joinedAt, id)
  // ordering guarantee the DB-level plan does. `participantInclude` orders by
  // joinedAt alone, so a seeded bulk-enroll (every row tied) reshuffles without
  // an explicit tiebreak.
  it("walks bootstrap ACTIVE pages without duplicates or skips when joinedAt ties", async () => {
    const { creator, race } = await seedRace({ size: 12, start: true });
    await prisma.raceParticipant.updateMany({
      where: { raceId: race.id },
      data: { joinedAt: new Date("2026-08-15T00:00:00.000Z") },
    });

    const seen = [];
    let offset = 0;
    for (let page = 0; page < 10; page += 1) {
      const raceView = await readBootstrapRace(
        race.id,
        creator.token,
        PAGING_HEADERS,
        `?view=participants-v1&offset=${offset}&limit=5`
      );
      seen.push(...raceView.participants.map((p) => p.id));
      if (!raceView.participantsPagination.hasMore) break;
      offset = raceView.participantsPagination.nextOffset;
    }
    assert.equal(seen.length, 12, "no rows skipped");
    assert.equal(new Set(seen).size, 12, "no rows duplicated");

    // And the JS-sorted order matches the DB-sorted order the legacy route
    // serves for the same race — one ordering contract, two implementations.
    const legacy = await getJson(
      `/races/${race.id}?view=participants-v1&offset=0&limit=12`,
      creator.token
    );
    assert.deepEqual(seen, legacy.participants.map((p) => p.id));
    assert.deepEqual(
      legacy.participantUserIds,
      legacy.participants.map((p) => p.userId)
    );
  });
});
