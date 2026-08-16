// Race/tournament preview-before-joining — backend access carve-out.
// (docs/race-preview-before-join-spec.md, "Backend change" + "Test plan".)
//
// A non-participant on a build that advertises the `race_preview` capability
// token may READ a PUBLIC, NON-TOURNAMENT race on all three access-gated
// endpoints (`GET /races/:id`, `/bootstrap`, `/progress`) while the server-side
// `racePreviewEnabled` kill switch is on. Everything this suite pins exists
// because the spec's three architect rounds each caught a way this could go
// wrong:
//
//   * DEAD ON ARRIVAL — the screen calls /bootstrap FIRST, so patching only
//     getRaceDetails would 403 before the detail query ever ran. Every positive
//     and negative case below therefore runs against ALL THREE endpoints.
//   * FINANCIAL LEAK — `participants[]` carries buyInAmount / buyInStatus /
//     payoutCoins, which the public listing never exposes. Redacted on the
//     preview branch ONLY (the already-shipped tournament-spectate branch must
//     keep serving them).
//   * EXPENSIVE-READ MUTATION — a stranger's single preview tap could have won
//     the rebuild lock, run `computeSharedState({ persist: true })` and
//     enqueued a resolution job for a race they have no relationship to.
//     Pinned in BOTH cache configurations (Redis on, and REDIS_URL unset —
//     the latter is exactly the persist:true branch).
//   * MISSING KILL SWITCH — a capability token is a compat gate, not an off
//     switch. Flag off + token present must be the byte-identical 403.
const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");

const ENV_PREFIX = "t:";
process.env.CACHE_ENV_PREFIX = ENV_PREFIX;
delete process.env.REDIS_URL;
process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS = "0";
process.env.RACE_RESOLVE_DEBOUNCE_MS = "0";

const { startTestRedis } = require("./redisTestServer");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const cache = require("../../src/shared/cache/redisCache");
const derivedCache = require("../../src/shared/cache/derivedCache");
const snapshotStore = require("../../src/modules/races/services/raceProgressSnapshot");
const { appSettings } = require("../../src/shared/config/appSettings");

const HOUR_MS = 60 * 60 * 1000;

// The tokens the carrying build sends. `race_participants_paging` is included
// because the preview screen's spectator detection reads the PAGED response
// shape (see test 10) — without it `participantsPagination` is never emitted.
const BASE_FEAT =
  "tournaments,characters,powerups2,powerups3,powerups4,powerups5,remote_assets,race_participants_paging,team_races";
const FEAT_NO_PREVIEW = BASE_FEAT;
const FEAT_PREVIEW = `${BASE_FEAT},race_preview`;

let server;
let live = null;
let redisSkipReason = null;
let nextAppleId = 0;

before(async () => {
  server = await getSharedServer();
  live = await startTestRedis();
  if (!live) {
    redisSkipReason =
      "no local Redis available (install redis-server or set REDIS_TEST_URL)";
  }
});

after(async () => {
  await disableRedis();
  if (live) await live.close();
});

// ── environment plumbing ───────────────────────────────────────────────────

async function enableRedis() {
  process.env.REDIS_URL = live.url;
  process.env.CACHE_ENV_PREFIX = ENV_PREFIX;
  await cache.close();
  derivedCache.reset();
  snapshotStore.__resetCounters();
}

async function disableRedis() {
  delete process.env.REDIS_URL;
  await cache.close();
  derivedCache.reset();
  snapshotStore.__resetCounters();
}

async function setFlag(key, value) {
  await appSettings.setFlag(key, value);
  appSettings.bustCache();
}

beforeEach(async () => {
  await cleanDatabase();
  await prisma.appSetting.deleteMany({});
  appSettings.bustCache();
  await disableRedis();
  // /bootstrap is a 404 unless its own additive-contract flag is on; every
  // three-endpoint assertion below needs it reachable.
  await setFlag("apiRaceBootstrapV1Enabled", true);
});

// ── fixtures ───────────────────────────────────────────────────────────────

async function createUser(displayName) {
  const appleId = `apple-preview-${++nextAppleId}-${Date.now()}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  const token = body.sessionToken;
  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    body: { displayName },
    token,
  });
  // One authed request so the backend records the capability tokens this user's
  // build advertises (some invite paths gate on the stored set).
  await request(server.baseUrl, "GET", "/auth/me", {
    token,
    headers: { "X-Client-Features": FEAT_PREVIEW },
  });
  return { userId: body.user.id, token, displayName };
}

async function makeFriends(a, b) {
  const sendRes = await request(server.baseUrl, "POST", "/friends/request", {
    body: { addresseeId: b.userId },
    token: a.token,
  });
  const friendship = (await sendRes.json()).friendship;
  if (!friendship) return;
  await request(server.baseUrl, "PUT", `/friends/request/${friendship.id}`, {
    body: { accept: true },
    token: b.token,
  });
}

/**
 * A started race with `timezone` pinned to UTC. `isPublic` is the axis under
 * test, so it is an explicit argument rather than a default.
 */
async function createActiveRace(owner, accepters, { isPublic, name }) {
  for (const o of accepters) await makeFriends(owner, o);
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name,
      targetSteps: 500000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 2000,
      isPublic,
    },
    token: owner.token,
    headers: { "X-Client-Features": FEAT_PREVIEW },
  });
  const created = await createRes.json();
  assert.ok(created.race, `race creation failed: ${JSON.stringify(created)}`);
  const raceId = created.race.id;
  if (accepters.length) {
    await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
      body: { inviteeIds: accepters.map((o) => o.userId) },
      token: owner.token,
      headers: { "X-Client-Features": FEAT_PREVIEW },
    });
    for (const o of accepters) {
      await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
        body: { accept: true },
        token: o.token,
        headers: { "X-Client-Features": FEAT_PREVIEW },
      });
    }
  }
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: owner.token,
    headers: { "X-Client-Features": FEAT_PREVIEW },
  });
  const start = new Date(Date.now() - 8 * HOUR_MS);
  await prisma.race.update({
    where: { id: raceId },
    data: {
      startedAt: start,
      endsAt: new Date(Date.now() + 24 * HOUR_MS),
      timezone: "UTC",
    },
  });
  await prisma.raceParticipant.updateMany({
    where: { raceId },
    data: { joinedAt: start },
  });
  return raceId;
}

/**
 * Stamp non-null financial values on every participant row. Without this the
 * redaction assertions would pass vacuously on a funded-prize (buy-in 0) race.
 */
async function stampMoney(raceId) {
  await prisma.raceParticipant.updateMany({
    where: { raceId },
    data: { buyInAmount: 250, buyInStatus: "HELD", payoutCoins: 900 },
  });
}

/** A started free 4-bracket. Returns both round-1 matchups and the players. */
async function fourBracket() {
  const a = await createUser("BracketA");
  const b = await createUser("BracketB");
  const c = await createUser("BracketC");
  const d = await createUser("BracketD");
  const createRes = await request(server.baseUrl, "POST", "/tournaments", {
    token: a.token,
    headers: { "X-Client-Features": FEAT_PREVIEW },
    body: {
      name: "Preview Cup",
      bracketSize: 4,
      matchupDurationDays: 1,
      buyInAmount: 0,
      isPublic: true,
      powerupsEnabled: true,
      inviteeIds: [],
    },
  });
  const { tournament } = await createRes.json();
  assert.ok(tournament, "tournament creation failed");
  for (const u of [b, c, d]) {
    await request(server.baseUrl, "POST", `/tournaments/${tournament.id}/join`, {
      token: u.token,
      headers: { "X-Client-Features": FEAT_PREVIEW },
    });
  }
  const round1 = await prisma.race.findMany({
    where: { tournamentId: tournament.id, tournamentRound: 1 },
    include: { participants: true },
    orderBy: { tournamentMatchIndex: "asc" },
  });
  assert.equal(round1.length, 2, "expected two round-1 matchups");
  return { tournament, round1, players: [a, b, c, d] };
}

// ── request helpers ────────────────────────────────────────────────────────

function headers(feat) {
  return { "X-Client-Features": feat, "X-Timezone": "UTC" };
}

function detailsRes(user, raceId, feat, query = "") {
  return request(server.baseUrl, "GET", `/races/${raceId}${query}`, {
    token: user.token,
    headers: headers(feat),
  });
}

function bootstrapRes(user, raceId, feat, query = "") {
  return request(server.baseUrl, "GET", `/races/${raceId}/bootstrap${query}`, {
    token: user.token,
    headers: headers(feat),
  });
}

function progressRes(user, raceId, feat, query = "") {
  return request(server.baseUrl, "GET", `/races/${raceId}/progress${query}`, {
    token: user.token,
    headers: headers(feat),
  });
}

/** All three access-gated endpoints, in the order the screen calls them. */
async function allThree(user, raceId, feat, query = "") {
  const [details, bootstrap, progress] = await Promise.all([
    detailsRes(user, raceId, feat, query),
    bootstrapRes(user, raceId, feat, query),
    progressRes(user, raceId, feat, query),
  ]);
  return { details, bootstrap, progress };
}

/**
 * `assert.equal(res.status, 200, await res.text())` is a trap here: the message
 * argument is evaluated EAGERLY, so it consumes the body even when the
 * assertion passes and every later `.json()` throws "Body already read".
 */
async function expectStatus(res, expected, label) {
  if (res.status === expected) return res;
  assert.fail(`${label}: expected ${expected}, got ${res.status}: ${await res.text()}`);
}

async function assertAllThree403(user, raceId, feat, label) {
  const res = await allThree(user, raceId, feat);
  for (const [name, r] of Object.entries(res)) {
    assert.equal(r.status, 403, `${label}: ${name} expected 403, got ${r.status}`);
    const body = await r.json();
    assert.equal(
      body.error,
      "You are not a participant in this race",
      `${label}: ${name} must return the byte-identical legacy 403 body`
    );
  }
}

function assertMoneyRedacted(participants, label) {
  assert.ok(participants.length > 0, `${label}: expected participant rows`);
  for (const p of participants) {
    assert.equal(p.buyInAmount, null, `${label}: buyInAmount must be null`);
    assert.equal(p.buyInStatus, null, `${label}: buyInStatus must be null`);
    assert.equal(p.payoutCoins, null, `${label}: payoutCoins must be null`);
  }
}

async function participantRows(raceId) {
  return prisma.raceParticipant.findMany({
    where: { raceId },
    orderBy: { userId: "asc" },
    select: {
      userId: true,
      totalSteps: true,
      totalsUpdatedAt: true,
      nextBoxAtSteps: true,
      maxBonusSteps: true,
      bonusSteps: true,
    },
  });
}

function sampleAt(hoursAgo, steps) {
  const end = new Date(Date.now() - hoursAgo * HOUR_MS);
  return {
    periodStart: new Date(end.getTime() - HOUR_MS).toISOString(),
    periodEnd: end.toISOString(),
    steps,
  };
}

function postSamples(user, samples) {
  return request(server.baseUrl, "POST", "/steps/samples", {
    body: { samples },
    token: user.token,
    headers: headers(FEAT_PREVIEW),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 — the positive path, on all three endpoints.
// ═══════════════════════════════════════════════════════════════════════════

describe("race preview — non-participant + token + flag on, public race", () => {
  it("200s on all three endpoints with financial fields null and myStatus null", async () => {
    await setFlag("racePreviewEnabled", true);
    const owner = await createUser("PrevOwner");
    const member = await createUser("PrevMember");
    const stranger = await createUser("PrevStranger");
    const raceId = await createActiveRace(owner, [member], {
      isPublic: true,
      name: "Public Preview Race",
    });
    await stampMoney(raceId);

    const { details, bootstrap, progress } = await allThree(
      stranger,
      raceId,
      FEAT_PREVIEW
    );
    await expectStatus(details, 200, "GET /races/:id");
    await expectStatus(bootstrap, 200, "/bootstrap");
    await expectStatus(progress, 200, "/progress");

    const detailBody = await details.json();
    assert.equal(detailBody.id, raceId);
    assert.equal(detailBody.myStatus, null, "a preview viewer has no status");
    assert.equal(detailBody.myTotalSteps, null);
    assert.equal(detailBody.isCreator, false);
    assertMoneyRedacted(detailBody.participants, "GET /races/:id");

    const bootstrapBody = await bootstrap.json();
    assert.equal(bootstrapBody.contract, "race-bootstrap-v1");
    assert.equal(bootstrapBody.race.myStatus, null);
    assertMoneyRedacted(bootstrapBody.race.participants, "/bootstrap");
    assert.ok(bootstrapBody.progress, "bootstrap must carry live progress");

    const progressBody = (await progress.json()).progress;
    assert.equal(progressBody.raceId, raceId);
    assert.equal(progressBody.status, "ACTIVE");
    assert.ok(
      Array.isArray(progressBody.participants),
      "the preview board must render standings"
    );
    // Sanity: the redaction is not vacuous — the same fields are REAL for a
    // participant reading the same race.
    const ownerDetailRes = await detailsRes(owner, raceId, FEAT_PREVIEW);
    await expectStatus(ownerDetailRes, 200, "owner details");
    const ownerDetail = await ownerDetailRes.json();
    assert.equal(ownerDetail.participants[0].buyInAmount, 250);
    assert.equal(ownerDetail.participants[0].buyInStatus, "HELD");
    assert.equal(ownerDetail.participants[0].payoutCoins, 900);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 — the capability gate: no token, no carve-out. THE compat guarantee.
// ═══════════════════════════════════════════════════════════════════════════

describe("race preview — capability token gate", () => {
  it("without the race_preview token the same request still 403s on all three", async () => {
    await setFlag("racePreviewEnabled", true);
    const owner = await createUser("TokOwner");
    const stranger = await createUser("TokStranger");
    const raceId = await createActiveRace(owner, [], {
      isPublic: true,
      name: "Tokenless Race",
    });
    await assertAllThree403(stranger, raceId, FEAT_NO_PREVIEW, "no token");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 — private races stay blocked.
// ═══════════════════════════════════════════════════════════════════════════

describe("race preview — private races", () => {
  it("a private race still 403s on all three even with the token and flag on", async () => {
    await setFlag("racePreviewEnabled", true);
    const owner = await createUser("PrivOwner");
    const member = await createUser("PrivMember");
    const stranger = await createUser("PrivStranger");
    const raceId = await createActiveRace(owner, [member], {
      isPublic: false,
      name: "Private Race",
    });
    await assertAllThree403(stranger, raceId, FEAT_PREVIEW, "private race");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 — tournament matchups are excluded from the carve-out, and the existing
//     spectate path still works.
// ═══════════════════════════════════════════════════════════════════════════

describe("race preview — tournament matchup races", () => {
  it("a non-bracket user with the token still 403s on a matchup race", async () => {
    await setFlag("racePreviewEnabled", true);
    const { round1 } = await fourBracket();
    const outsider = await createUser("Outsider");
    await assertAllThree403(
      outsider,
      round1[0].id,
      FEAT_PREVIEW,
      "tournament matchup"
    );
  });

  it("an ACCEPTED bracket player still spectates the sibling matchup (existing path)", async () => {
    await setFlag("racePreviewEnabled", true);
    const { round1, players } = await fourBracket();
    // Whichever player is NOT in round1[0] is the legitimate spectator.
    const matchupUserIds = new Set(round1[0].participants.map((p) => p.userId));
    const spectator = players.find((p) => !matchupUserIds.has(p.userId));
    assert.ok(spectator, "expected a bracket player outside matchup 0");

    const { details, progress } = await allThree(
      spectator,
      round1[0].id,
      FEAT_PREVIEW
    );
    await expectStatus(details, 200, "spectate details");
    await expectStatus(progress, 200, "spectate progress");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 — DECLINED still revokes access (a DECLINED row IS a participant row).
// ═══════════════════════════════════════════════════════════════════════════

describe("race preview — DECLINED participants", () => {
  it("a DECLINED participant on a public race still 403s on all three", async () => {
    await setFlag("racePreviewEnabled", true);
    const owner = await createUser("DecOwner");
    const decliner = await createUser("Decliner");
    const raceId = await createActiveRace(owner, [], {
      isPublic: true,
      name: "Decline Race",
    });
    await makeFriends(owner, decliner);
    await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
      body: { inviteeIds: [decliner.userId] },
      token: owner.token,
      headers: headers(FEAT_PREVIEW),
    });
    const respond = await request(
      server.baseUrl,
      "PUT",
      `/races/${raceId}/respond`,
      {
        body: { accept: false },
        token: decliner.token,
        headers: headers(FEAT_PREVIEW),
      }
    );
    assert.equal(respond.status, 200, await respond.text());
    const row = await prisma.raceParticipant.findFirst({
      where: { raceId, userId: decliner.userId },
      select: { status: true },
    });
    assert.equal(row.status, "DECLINED", "fixture must actually be DECLINED");

    await assertAllThree403(decliner, raceId, FEAT_PREVIEW, "declined");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6 — an INVITED participant is unaffected: real myStatus, no redaction.
// ═══════════════════════════════════════════════════════════════════════════

describe("race preview — INVITED participants are unchanged", () => {
  it("serves the real myStatus and unredacted money, with or without the token", async () => {
    await setFlag("racePreviewEnabled", true);
    const owner = await createUser("InvOwner");
    const invitee = await createUser("Invitee");
    const raceId = await createActiveRace(owner, [], {
      isPublic: true,
      name: "Invited Race",
    });
    await makeFriends(owner, invitee);
    await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
      body: { inviteeIds: [invitee.userId] },
      token: owner.token,
      headers: headers(FEAT_PREVIEW),
    });
    await stampMoney(raceId);

    for (const feat of [FEAT_PREVIEW, FEAT_NO_PREVIEW]) {
      const res = await detailsRes(invitee, raceId, feat);
      await expectStatus(res, 200, `invited feat=${feat}`);
      const body = await res.json();
      assert.equal(body.myStatus, "INVITED", `feat=${feat}`);
      const mine = body.participants.find((p) => p.userId === invitee.userId);
      assert.ok(mine, "the invitee's own row must be present");
      assert.equal(mine.buyInAmount, 250, "no redaction for a participant");
      assert.equal(mine.buyInStatus, "HELD");
      assert.equal(mine.payoutCoins, 900);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7 — the already-shipped tournament-spectate branch keeps its money fields.
// ═══════════════════════════════════════════════════════════════════════════

describe("race preview — tournament spectate is not redacted", () => {
  it("a bracket spectator still receives buyIn/payout fields on the matchup", async () => {
    await setFlag("racePreviewEnabled", true);
    const { round1, players } = await fourBracket();
    const matchupUserIds = new Set(round1[0].participants.map((p) => p.userId));
    const spectator = players.find((p) => !matchupUserIds.has(p.userId));
    await stampMoney(round1[0].id);

    const res = await detailsRes(spectator, round1[0].id, FEAT_PREVIEW);
    await expectStatus(res, 200, "spectate details");
    const body = await res.json();
    assert.equal(body.myStatus, null, "a spectator has no status either");
    assert.ok(body.participants.length > 0);
    for (const p of body.participants) {
      assert.equal(
        p.buyInAmount,
        250,
        "the spectate branch must NOT inherit the preview redaction"
      );
      assert.equal(p.buyInStatus, "HELD");
      assert.equal(p.payoutCoins, 900);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8 — the kill switch must actually gate.
// ═══════════════════════════════════════════════════════════════════════════

describe("race preview — racePreviewEnabled kill switch", () => {
  it("defaults OFF, so a token-carrying request 403s until it is flipped on", async () => {
    // No setFlag call at all: the declared default must be false.
    const stored = await prisma.appSetting.findUnique({
      where: { key: "racePreviewEnabled" },
    });
    assert.equal(stored, null, "no row: the DEFAULT is what is under test");
    assert.equal(
      await appSettings.getFlag("racePreviewEnabled"),
      false,
      "racePreviewEnabled must default to false"
    );

    const owner = await createUser("FlagOwner");
    const stranger = await createUser("FlagStranger");
    const raceId = await createActiveRace(owner, [], {
      isPublic: true,
      name: "Flag Off Race",
    });
    await assertAllThree403(stranger, raceId, FEAT_PREVIEW, "flag off (default)");

    // Explicitly stored false is the rollback state; same 403.
    await setFlag("racePreviewEnabled", false);
    await assertAllThree403(stranger, raceId, FEAT_PREVIEW, "flag off (stored)");

    // …and flipping it on is the ONLY thing that changed.
    await setFlag("racePreviewEnabled", true);
    const on = await detailsRes(stranger, raceId, FEAT_PREVIEW);
    assert.equal(on.status, 200, "the flag is the switch");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9 — a preview /progress read is STRICTLY read-only, in BOTH cache configs.
// ═══════════════════════════════════════════════════════════════════════════

describe("race preview — /progress is strictly read-only", () => {
  /**
   * Shared body. `cached` selects the configuration:
   *   true  -> REDIS_URL set + redisStandingsEnabled on (the withRebuildLock /
   *            enqueueRaceResolution path)
   *   false -> REDIS_URL unset (the `computeSharedState({ persist: true })`
   *            branch, which is the one that WRITES race_participants)
   */
  async function readOnlyCase({ cached }) {
    await setFlag("racePreviewEnabled", true);
    if (cached) {
      await enableRedis();
      await setFlag("redisStandingsEnabled", true);
    } else {
      await disableRedis();
      await setFlag("redisStandingsEnabled", false);
    }

    const owner = await createUser(`ROOwner${cached}`);
    const member = await createUser(`ROMember${cached}`);
    const stranger = await createUser(`ROStranger${cached}`);
    const raceId = await createActiveRace(owner, [member], {
      isPublic: true,
      name: `ReadOnly ${cached}`,
    });

    // Unresolved steps: a persist:true replay WOULD move these rows, which is
    // what makes "rows unchanged" a real assertion rather than a tautology.
    await postSamples(owner, [sampleAt(6, 3000), sampleAt(5, 2500)]);
    await postSamples(member, [sampleAt(6, 1800)]);

    // Clear everything the sync path itself enqueued so any job row found
    // afterwards can only have come from the preview request.
    await prisma.raceResolutionJobV2.deleteMany({});
    snapshotStore.__resetCounters();
    const before = await participantRows(raceId);
    const replaysBefore = snapshotStore.__counters.requestReplays;
    const writeBacksBefore = snapshotStore.__counters.writeBacks;

    // Several concurrent preview hits — one of them would have won the lock.
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        progressRes(stranger, raceId, FEAT_PREVIEW)
      )
    );
    for (const r of responses) {
      assert.equal(r.status, 200, `preview progress failed: ${await r.text()}`);
    }

    const after = await participantRows(raceId);
    assert.deepEqual(
      after,
      before,
      `cached=${cached}: a preview read must not move any race_participants row`
    );
    assert.equal(
      snapshotStore.__counters.writeBacks,
      writeBacksBefore,
      `cached=${cached}: a preview read must issue zero participant write-backs`
    );
    assert.equal(
      snapshotStore.__counters.requestReplays,
      replaysBefore,
      `cached=${cached}: a preview read must never take the rebuild lock`
    );
    const queued = await prisma.raceResolutionJobV2.findMany({});
    assert.deepEqual(
      queued,
      [],
      `cached=${cached}: a preview read must enqueue no resolution job`
    );

    // Control: the SAME endpoint, hit by a real participant, is still allowed
    // to do its normal work — so the assertions above pin the preview branch,
    // not a globally disabled code path.
    const participantRes = await progressRes(owner, raceId, FEAT_PREVIEW);
    await expectStatus(participantRes, 200, "control participant progress");
    const movedRows = await participantRows(raceId);
    const movedJobs = await prisma.raceResolutionJobV2.findMany({});
    const participantDidWork =
      JSON.stringify(movedRows) !== JSON.stringify(before) ||
      movedJobs.length > 0 ||
      snapshotStore.__counters.requestReplays > replaysBefore;
    assert.ok(
      participantDidWork,
      `cached=${cached}: control failed — a participant read did no work either, ` +
        `so the read-only assertions above prove nothing`
    );
  }

  it("REDIS_URL unset (the persist:true branch)", async () => {
    await readOnlyCase({ cached: false });
  });

  it("test Redis db15 + redisStandingsEnabled (the rebuild-lock branch)", async (t) => {
    if (redisSkipReason) return t.skip(redisSkipReason);
    await readOnlyCase({ cached: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10 — a freshly seeded public race with NO participants still previews, and
//      still reports its paging envelope (the frontend's spectator detection
//      reads the PAGED branch; a missing envelope silently regresses an empty
//      race back to participant chrome with no JOIN CTA).
// ═══════════════════════════════════════════════════════════════════════════

describe("race preview — zero-participant public race", () => {
  it("200s and reports the paging envelope on all three preview responses", async () => {
    await setFlag("racePreviewEnabled", true);
    const owner = await createUser("EmptyOwner");
    const stranger = await createUser("EmptyStranger");
    const raceId = await createActiveRace(owner, [], {
      isPublic: true,
      name: "Empty Public Race",
    });
    // Drop the creator's own row: the fixture under test is a race whose
    // `participants` array is genuinely empty. The status is forced ACTIVE in
    // the same breath because /races/:id/start needs a field to start — and
    // /progress returns its non-ACTIVE payload from an EARLY return that
    // precedes the paging envelope entirely, so a PENDING fixture would assert
    // nothing about the branch the preview screen actually reads.
    await prisma.raceParticipant.deleteMany({ where: { raceId } });
    await prisma.race.update({
      where: { id: raceId },
      data: { status: "ACTIVE" },
    });
    const rows = await prisma.raceParticipant.count({ where: { raceId } });
    assert.equal(rows, 0, "fixture must have zero participant rows");

    const query = "?view=participants-v1&offset=0&limit=10";
    const { details, bootstrap, progress } = await allThree(
      stranger,
      raceId,
      FEAT_PREVIEW,
      query
    );
    await expectStatus(details, 200, "GET /races/:id");
    await expectStatus(bootstrap, 200, "/bootstrap");
    await expectStatus(progress, 200, "/progress");

    const detailBody = await details.json();
    assert.deepEqual(detailBody.participants, []);
    assert.equal(detailBody.myStatus, null);
    assert.ok(
      detailBody.participantsPagination,
      "GET /races/:id must carry participantsPagination"
    );
    assert.equal(detailBody.participantsPagination.total, 0);
    // limit is contractually floored at 1 so a client computing ceil(total /
    // limit) cannot divide by zero.
    assert.ok(detailBody.participantsPagination.limit >= 1);

    const bootstrapBody = await bootstrap.json();
    assert.ok(
      bootstrapBody.race.participantsPagination,
      "/bootstrap's race must carry participantsPagination"
    );
    assert.equal(bootstrapBody.race.participantsPagination.total, 0);

    // NOTE (deviation from the spec's literal wording): the /progress payload's
    // paging envelope is named `pagination`, not `participantsPagination` —
    // there is no such key on that endpoint. Same envelope, endpoint's own name.
    const progressBody = (await progress.json()).progress;
    assert.ok(
      progressBody.pagination,
      "/progress must carry its paging envelope"
    );
    assert.equal(progressBody.pagination.total, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11 — /powerups/use-context is OUT OF SCOPE and must not inherit the carve
// -out. It shares loadRaceProgress with /progress, so without an explicit
// opt-out a token-carrying non-participant would trigger a full
// forceFullParticipants read (participants + effects) before being denied —
// wasteful, and outside the three endpoints this feature is scoped to.
// (code-reviewer finding on the implementation, not in the original spec.)
// ═══════════════════════════════════════════════════════════════════════════

describe("race preview — /powerups/use-context is not previewable", () => {
  it("still 403s a non-participant immediately, flag on + token present", async () => {
    const owner = await createUser("UseContextOwner");
    const stranger = await createUser("UseContextStranger");
    const raceId = await createActiveRace(owner, [], {
      isPublic: true,
      name: "Use Context Race",
    });
    await setFlag("racePreviewEnabled", true);

    const before = snapshotStore.__counters
      ? { ...snapshotStore.__counters }
      : null;

    const res = await request(
      server.baseUrl,
      "GET",
      `/races/${raceId}/powerups/use-context`,
      { token: stranger.token, headers: headers(FEAT_PREVIEW) }
    );

    assert.equal(
      res.status,
      403,
      `expected the cheap early 403, got ${res.status}: ${await res.text()}`
    );

    // The whole point: this must be the SAME early denial a non-participant
    // always got, not a full progress read that happens to end in a 403.
    // If forceFullParticipants ever ran for this caller, requestReplays
    // and/or writeBacks would move; they must not.
    if (before && snapshotStore.__counters) {
      assert.deepEqual(
        snapshotStore.__counters,
        before,
        "use-context must deny before touching the snapshot store at all"
      );
    }
  });
});
