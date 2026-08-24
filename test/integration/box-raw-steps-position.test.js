// Mystery-box odds position from RAW WALKED STEPS
// (docs/box-raw-steps-position-and-option-h-requirements.md, test plan 1-6b).
//
// The exploit this closes: the drop-odds position was computed from
// `race_participants.total_steps`, the EFFECT-SENSITIVE leaderboard total. Two
// manipulations followed — box banking (earn boxes while leading, open while
// temporarily last for the trailing tier) and powerup hoarding (unused bonus
// powerups keep `totalSteps` low, pinning you at trailing odds all race).
//
// Everything below runs against the REAL test Postgres over REAL HTTP through
// the REAL handler chain. The one injected seam is `rollPowerupOdds`, used
// purely as a SPY: it records the `position` the route passed and then delegates
// to the real roller, so the request still exercises the production path.
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach, afterEach, after } = require("node:test");

// Read at module load by economy/adRewards.js — must precede ./setup.
process.env.ADMOB_SSV_SKIP_VERIFY = "true";

const {
  cleanDatabase,
  prisma,
  request,
  getSharedServer,
  startServer,
} = require("./setup");
const {
  buildOpenMysteryBox,
} = require("../../src/modules/powerups/commands/openMysteryBox");
const {
  buildRerollMysteryBox,
} = require("../../src/modules/powerups/commands/rerollMysteryBox");
const {
  rollPowerup: realRollPowerup,
} = require("../../src/modules/powerups/powerupOdds");
const {
  RaceActiveEffect,
} = require("../../src/modules/powerups/models/raceActiveEffect");
const {
  optionHPositionFairness,
} = require("../../scripts/balance-apply");
const {
  mergeOverDefaults,
} = require("../../src/modules/economy/balanceConfig");
const {
  defaultConfig,
} = require("../../src/modules/economy/balanceConfig.defaults");
const {
  buildRaceResolutionWorkerV2,
} = require("../../src/modules/races/jobs/raceResolutionQueueV2");

const HOUR_MS = 60 * 60 * 1000;
const FEATURES = {
  "X-Client-Features":
    "characters,powerups2,powerups3,powerups4,powerups5,ads,remote_assets",
};

let server;
// A second app whose open/reroll commands carry the roll spy. Same database,
// same routes, same middleware.
let spyServer;
const rolls = [];

function spyRoller(position, totalParticipants, rng, options) {
  rolls.push({ position, totalParticipants, ctx: options?.ctx });
  return realRollPowerup(position, totalParticipants, rng, options);
}

let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-rawpos-${++nextAppleId}-${Date.now()}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    body: { displayName },
    token: body.sessionToken,
  });
  await prisma.user.update({
    where: { id: body.user.id },
    data: { timezone: "UTC" },
  });
  return { userId: body.user.id, token: body.sessionToken, displayName };
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

async function createActiveRace(owner, others, name) {
  for (const o of others) await makeFriends(owner, o);
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name,
      targetSteps: 500000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      // Large interval: no box is auto-minted by the fixture's step volume, so
      // every box in these tests is one the test explicitly seeded.
      powerupStepInterval: 500000,
    },
    token: owner.token,
  });
  const raceId = (await createRes.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: others.map((o) => o.userId) },
    token: owner.token,
  });
  for (const o of others) {
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: o.token,
    });
  }
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: owner.token,
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

// One CLOSED hourly bucket `hoursAgo` back (open buckets contribute zero).
function sampleAt(hoursAgo, steps) {
  const end = new Date(Date.now() - hoursAgo * HOUR_MS);
  return {
    periodStart: new Date(end.getTime() - HOUR_MS).toISOString(),
    periodEnd: end.toISOString(),
    steps,
  };
}

async function postSamples(user, samples) {
  return request(server.baseUrl, "POST", "/steps/samples", {
    body: { samples },
    token: user.token,
    headers: FEATURES,
  });
}

async function progress(user, raceId, base = server.baseUrl) {
  const res = await request(base, "GET", `/races/${raceId}/progress`, {
    token: user.token,
    headers: FEATURES,
  });
  // The route answers `{ progress: {...} }`.
  const payload = await res.json();
  return { status: res.status, body: payload.progress || payload };
}

async function processQueuedRace(raceId) {
  return buildRaceResolutionWorkerV2({ bootAt: 0 }).processRace({ raceId });
}

async function rows(raceId) {
  const list = await prisma.raceParticipant.findMany({
    where: { raceId, status: "ACCEPTED" },
    select: { userId: true, totalSteps: true, rawSteps: true, id: true },
  });
  return Object.fromEntries(list.map((r) => [r.userId, r]));
}

async function seedBox(raceId, user) {
  const p = await prisma.raceParticipant.findFirst({
    where: { raceId, userId: user.userId },
  });
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: p.id,
      userId: user.userId,
      type: "MYSTERY_BOX",
      status: "MYSTERY_BOX",
      earnedAtSteps: Math.floor(Math.random() * 1_000_000),
    },
  });
}

async function openBox(user, raceId, powerupId, base = spyServer.baseUrl) {
  const res = await request(
    base,
    "POST",
    `/races/${raceId}/powerups/${powerupId}/open`,
    { token: user.token, headers: FEATURES }
  );
  // The open route answers `{ result: {...} }`.
  const payload = await res.json();
  return { status: res.status, body: payload.result || payload };
}

// ── The fixture every position test shares ─────────────────────────────────
//
// Alice WALKS the least and is LAST on raw steps, but holds a big pile of bonus
// steps (what a hoarded/played powerup grants), which makes her the
// leaderboard LEADER. Pre-2026-08-09 she rolled at position 1 of 3; the fix
// must roll her at 3 of 3.
async function skewedRace() {
  const alice = await createUser("AliceRaw");
  const bob = await createUser("BobRaw");
  const carol = await createUser("CarolRaw");
  const raceId = await createActiveRace(alice, [bob, carol], "Raw Position");

  await postSamples(alice, [sampleAt(2, 3000)]);
  await postSamples(bob, [sampleAt(2, 6000)]);
  await postSamples(carol, [sampleAt(2, 9000)]);

  // Bonus steps are the effect-sensitive part of `totalSteps` and are exactly
  // what hoarding manipulates. They never touch raw walked steps.
  await prisma.raceParticipant.updateMany({
    where: { raceId, userId: alice.userId },
    data: { bonusSteps: 20000, maxBonusSteps: 20000 },
  });

  // One replay through the real endpoint persists totals AND raw steps.
  await progress(alice, raceId);

  const state = await rows(raceId);
  assert.ok(
    state[alice.userId].totalSteps > state[carol.userId].totalSteps,
    "fixture: Alice must be the leaderboard leader"
  );
  for (const u of [alice, bob, carol]) {
    assert.equal(
      typeof state[u.userId].rawSteps,
      "number",
      "fixture: every row must be healed"
    );
  }
  assert.ok(
    state[alice.userId].rawSteps < state[bob.userId].rawSteps &&
      state[bob.userId].rawSteps < state[carol.userId].rawSteps,
    "fixture: Alice must be LAST on raw walked steps"
  );

  return { alice, bob, carol, raceId, state };
}

describe("mystery-box odds position from raw walked steps", () => {
  before(async () => {
    server = await getSharedServer();
    spyServer = await startServer({
      verifyAppleIdentityToken: async (token) => ({
        sub: token,
        email: `${token}@example.com`,
      }),
      openMysteryBox: buildOpenMysteryBox({ rollPowerupOdds: spyRoller }),
      rerollMysteryBox: buildRerollMysteryBox({ rollPowerupOdds: spyRoller }),
    });
  });

  after(async () => {
    if (spyServer) await spyServer.close();
    delete process.env.ADMOB_SSV_SKIP_VERIFY;
  });

  beforeEach(async () => {
    await cleanDatabase();
    rolls.length = 0;
  });

  // ── Test 1 ───────────────────────────────────────────────────────────────
  it("1. a bonus-inflated leader who walked the least opens at LAST place odds", async () => {
    const { alice, raceId } = await skewedRace();
    const box = await seedBox(raceId, alice);

    const { status } = await openBox(alice, raceId, box.id);
    assert.equal(status, 200);

    assert.equal(rolls.length, 1, "exactly one roll happened");
    assert.equal(
      rolls[0].position,
      3,
      "the roll must use the RAW position (last), not the boosted rank"
    );
    assert.equal(rolls[0].totalParticipants, 3);
  });

  // ── Test 2 ───────────────────────────────────────────────────────────────
  it("2. the quoted dropOdds.position equals the position the roll actually used, while the leaderboard still shows the boosted rank", async () => {
    const { alice, raceId } = await skewedRace();
    const box = await seedBox(raceId, alice);
    await openBox(alice, raceId, box.id);
    const rolled = rolls[0].position;

    const { status, body } = await progress(alice, raceId);
    assert.equal(status, 200);

    assert.equal(body.powerupData.dropOdds.position, 3);
    assert.equal(body.powerupData.dropOdds.totalParticipants, 3);
    assert.equal(
      body.powerupData.dropOdds.position,
      rolled,
      "disclosure and roll must never disagree"
    );

    // The leaderboard is unchanged: it still ranks on effective totalSteps.
    assert.equal(
      body.participants[0].userId,
      alice.userId,
      "the leaderboard still shows the bonus-boosted leader first"
    );

    // The response shape is untouched for frozen clients.
    const odds = body.powerupData.dropOdds;
    assert.deepEqual(
      Object.keys(odds).sort(),
      ["byType", "configVersion", "position", "rarity", "totalParticipants"].sort()
    );
    const sum = ["COMMON", "UNCOMMON", "RARE"].reduce(
      (a, k) => a + odds.rarity[k],
      0
    );
    assert.ok(Math.abs(sum - 1) < 0.01, "rarity still sums to 1.0");
  });

  // ── Test 3 ───────────────────────────────────────────────────────────────
  it("3a. with raw_steps NULL on every row the race falls back to totalSteps (exactly today's behaviour)", async () => {
    const { alice, raceId } = await skewedRace();
    await prisma.raceParticipant.updateMany({
      where: { raceId },
      data: { rawSteps: null },
    });

    const box = await seedBox(raceId, alice);
    const { status } = await openBox(alice, raceId, box.id);
    assert.equal(status, 200);
    assert.equal(rolls[0].position, 1, "unhealed race ranks on totalSteps");

    // The legacy replay HEALS the rows it just recomputed and the disclosure in
    // the SAME request sees them (code review item 2) — so this progress call
    // both persists raw_steps and quotes the raw position, rather than quoting
    // the fallback for one more poll.
    const { body } = await progress(alice, raceId);
    assert.equal(body.powerupData.dropOdds.totalParticipants, 3);
    assert.equal(
      body.powerupData.dropOdds.position,
      3,
      "the replay heals in-request; the disclosure must not lag its own write"
    );
    const healed = await rows(raceId);
    for (const u of Object.values(healed)) {
      assert.equal(typeof u.rawSteps, "number", "every row healed");
    }

    // A subsequent open agrees with what that request quoted.
    rolls.length = 0;
    const box2 = await seedBox(raceId, alice);
    await openBox(alice, raceId, box2.id);
    assert.equal(rolls[0].position, 3);
  });

  it("3b. a PARTIALLY healed race ranks EVERY participant on totalSteps (no raw-vs-boosted mixed comparison)", async () => {
    const { alice, bob, raceId } = await skewedRace();
    // Only Bob is unhealed — e.g. a mid-race joiner or a partly failed persist.
    await prisma.raceParticipant.updateMany({
      where: { raceId, userId: bob.userId },
      data: { rawSteps: null },
    });

    const box = await seedBox(raceId, alice);
    const { status } = await openBox(alice, raceId, box.id);
    assert.equal(status, 200);
    assert.equal(
      rolls[0].position,
      1,
      "one NULL row pins the WHOLE race to totalSteps"
    );

    // The disclosure agrees for as long as the row is unhealed. Assert it on a
    // path that does NOT persist — an open, above, and a second one here —
    // because a legacy-replay progress request heals every row it recomputes
    // (code review item 2) and would legitimately switch the race to raw.
    rolls.length = 0;
    const box2 = await seedBox(raceId, alice);
    await openBox(alice, raceId, box2.id);
    assert.equal(rolls[0].position, 1, "still mixed, still on totalSteps");

    await progress(alice, raceId);
    const healed = await rows(raceId);
    for (const u of Object.values(healed)) {
      assert.equal(
        typeof u.rawSteps,
        "number",
        "the replay heals the partial row"
      );
    }
    rolls.length = 0;
    const box3 = await seedBox(raceId, alice);
    await openBox(alice, raceId, box3.id);
    assert.equal(
      rolls[0].position,
      3,
      "once every row is healed the race ranks on raw steps"
    );
  });

  // ── Test 3b (reroll) ─────────────────────────────────────────────────────
  it("3c. a reroll uses the same raw position as an open", async () => {
    process.env.ADS_BOX_REROLL_ENABLED = "true";
    try {
      const { alice, raceId } = await skewedRace();
      const p = await prisma.raceParticipant.findFirst({
        where: { raceId, userId: alice.userId },
      });
      const held = await prisma.racePowerup.create({
        data: {
          raceId,
          participantId: p.id,
          userId: alice.userId,
          type: "PROTEIN_SHAKE",
          rarity: "COMMON",
          status: "HELD",
          configVersion: 999999,
          earnedAtSteps: 1234,
        },
      });
      await prisma.adRewardGrant.create({
        data: {
          userId: alice.userId,
          transactionId: `txn-raw-${Math.random()}`,
          rewardKind: "box_reroll",
          grantedDate: new Date().toISOString().slice(0, 10),
        },
      });

      const res = await request(
        spyServer.baseUrl,
        "POST",
        `/races/${raceId}/powerups/${held.id}/reroll`,
        { token: alice.token, headers: FEATURES }
      );
      assert.equal(res.status, 200, JSON.stringify(await res.json()));
      assert.equal(rolls.length, 1);
      assert.equal(rolls[0].position, 3, "reroll rolls at the RAW position");
    } finally {
      delete process.env.ADS_BOX_REROLL_ENABLED;
    }
  });

  // ── Test 4 ───────────────────────────────────────────────────────────────
  it("4. team position sums RAW steps: a team leading only on bonus steps rolls as the trailing team", async () => {
    const alice = await createUser("AliceTeam");
    const bob = await createUser("BobTeam");
    const carol = await createUser("CarolTeam");
    const dave = await createUser("DaveTeam");
    const raceId = await createActiveRace(alice, [bob, carol, dave], "Raw Teams");

    await postSamples(alice, [sampleAt(2, 1000)]);
    await postSamples(bob, [sampleAt(2, 1000)]);
    await postSamples(carol, [sampleAt(2, 8000)]);
    await postSamples(dave, [sampleAt(2, 8000)]);

    await prisma.race.update({
      where: { id: raceId },
      data: { isTeamRace: true, teamSize: 2 },
    });
    for (const [user, team] of [
      [alice, "TEAM_A"],
      [bob, "TEAM_A"],
      [carol, "TEAM_B"],
      [dave, "TEAM_B"],
    ]) {
      await prisma.raceParticipant.updateMany({
        where: { raceId, userId: user.userId },
        data: { team },
      });
    }
    // TEAM_A is far ahead on the leaderboard purely on bonus steps.
    await prisma.raceParticipant.updateMany({
      where: { raceId, userId: alice.userId },
      data: { bonusSteps: 30000, maxBonusSteps: 30000 },
    });

    await progress(alice, raceId);
    const state = await rows(raceId);
    assert.ok(
      state[alice.userId].totalSteps + state[bob.userId].totalSteps >
        state[carol.userId].totalSteps + state[dave.userId].totalSteps,
      "fixture: TEAM_A leads the board"
    );

    const box = await seedBox(raceId, alice);
    const { status } = await openBox(alice, raceId, box.id);
    assert.equal(status, 200);
    assert.equal(rolls[0].totalParticipants, 2, "team races roll 1-of-2");
    assert.equal(
      rolls[0].position,
      2,
      "TEAM_A trails on summed RAW steps and must roll as the trailing team"
    );

    const { body } = await progress(alice, raceId);
    assert.equal(body.powerupData.dropOdds.position, 2);
  });

  // ── Test 5 ───────────────────────────────────────────────────────────────
  it("5. exclusion predicates still key off totalSteps: the boosted step-leader cannot roll RED_CARD / SECOND_WIND even at raw-last odds", async () => {
    const { alice, raceId } = await skewedRace();

    const { body } = await progress(alice, raceId);
    const byType = body.powerupData.dropOdds.byType;
    assert.equal(byType.RED_CARD, 0, "leaderExcluded still applies");
    assert.equal(byType.SECOND_WIND, 0, "leaderExcluded still applies");
    assert.ok(
      byType.TRAIL_MINE > 0,
      "she is NOT the step-last player, so Trail Mine stays available"
    );

    const box = await seedBox(raceId, alice);
    await openBox(alice, raceId, box.id);
    assert.equal(
      rolls[0].ctx.isStepLeader,
      true,
      "isStepLeader stays on the effect-sensitive totals the use-time check uses"
    );
    assert.equal(rolls[0].ctx.isStepLast, false);
    assert.equal(rolls[0].ctx.normalizedPosition, 1, "…while the ODDS tier is last place");
  });

  // ── Test 6 — the writers ─────────────────────────────────────────────────
  it("6a. the legacy replay persist writes raw_steps for every unfrozen participant", async () => {
    const alice = await createUser("AliceW1");
    const bob = await createUser("BobW1");
    const raceId = await createActiveRace(alice, [bob], "Writer legacy");
    await postSamples(alice, [sampleAt(2, 4000)]);
    await postSamples(bob, [sampleAt(2, 7000)]);

    // Wipe what the upload reconcile wrote so the replay is provably the writer.
    await prisma.raceParticipant.updateMany({
      where: { raceId },
      data: { rawSteps: null },
    });

    await progress(alice, raceId);

    const state = await rows(raceId);
    assert.equal(state[alice.userId].rawSteps, 4000);
    assert.equal(state[bob.userId].rawSteps, 7000);
  });

  it("6c. step upload queues raw_steps reconciliation for the canonical worker", async () => {
    const alice = await createUser("AliceW3");
    const bob = await createUser("BobW3");
    const raceId = await createActiveRace(alice, [bob], "Writer reconcile");

    await postSamples(alice, [sampleAt(2, 5500)]);

    const inline = await rows(raceId);
    assert.equal(inline[alice.userId].rawSteps, null, "intake never writes raw_steps inline");
    assert.equal(inline[bob.userId].rawSteps, null);
    assert.ok(await processQueuedRace(raceId));

    const state = await rows(raceId);
    assert.equal(
      state[alice.userId].rawSteps,
      5500,
      "the canonical worker writes the uploader's raw_steps"
    );
    assert.equal(
      state[bob.userId].rawSteps,
      0,
      "a coalesced FULL generation writes the canonical zero for participants without source"
    );
  });

  it("6f. raw_steps is monotonic: a downward re-sync never lowers it", async () => {
    const alice = await createUser("AliceMono");
    const bob = await createUser("BobMono");
    const raceId = await createActiveRace(alice, [bob], "Monotonic");

    await postSamples(alice, [sampleAt(2, 9000)]);
    assert.equal((await rows(raceId))[alice.userId].rawSteps, null);
    assert.ok(await processQueuedRace(raceId));
    assert.equal((await rows(raceId))[alice.userId].rawSteps, 9000);

    // A re-sync that REWRITES the same bucket downward (device re-report).
    await postSamples(alice, [sampleAt(2, 100)]);
    assert.equal(
      (await rows(raceId))[alice.userId].rawSteps,
      9000,
      "the intake request leaves the committed participant unchanged"
    );
    assert.ok(await processQueuedRace(raceId));
    assert.equal(
      (await rows(raceId))[alice.userId].rawSteps,
      9000,
      "a downward re-sync must not move the odds position backwards"
    );

    // The replay writer honours the same rule.
    await progress(alice, raceId);
    assert.equal((await rows(raceId))[alice.userId].rawSteps, 9000);
  });

  it("6g. a finished participant's raw_steps is frozen with their total", async () => {
    const alice = await createUser("AliceFrozen");
    const bob = await createUser("BobFrozen");
    const raceId = await createActiveRace(alice, [bob], "Frozen");

    await postSamples(alice, [sampleAt(3, 4000)]);
    await postSamples(bob, [sampleAt(3, 4000)]);
    await progress(alice, raceId);

    const before = await rows(raceId);
    await prisma.raceParticipant.update({
      where: { id: before[alice.userId].id },
      data: {
        finishedAt: new Date(),
        finishTotalSteps: before[alice.userId].totalSteps,
      },
    });

    // More walking after finishing must not advance the frozen row.
    await postSamples(alice, [sampleAt(2, 12000)]);
    await progress(bob, raceId);

    const after = await rows(raceId);
    assert.equal(
      after[alice.userId].rawSteps,
      before[alice.userId].rawSteps,
      "frozen rows keep their last persisted raw_steps"
    );
    assert.equal(after[alice.userId].totalSteps, before[alice.userId].totalSteps);
  });

  // ── Test 6b — the rarity stamp / discard faucet ──────────────────────────
  it("6b. a COMMON type rolled out of the UNCOMMON tier is stamped and paid as COMMON", async () => {
    const alice = await createUser("AliceStamp");
    const bob = await createUser("BobStamp");
    const raceId = await createActiveRace(alice, [bob], "Stamp");
    await postSamples(alice, [sampleAt(2, 2000)]);

    // Option H puts PROTEIN_SHAKE (canonically COMMON) into dropPool.UNCOMMON.
    // Force exactly that outcome through the real open route.
    const forcedServer = await startServer({
      verifyAppleIdentityToken: async (token) => ({
        sub: token,
        email: `${token}@example.com`,
      }),
      openMysteryBox: buildOpenMysteryBox({
        rollPowerupOdds: () => ({ type: "PROTEIN_SHAKE", rarity: "UNCOMMON" }),
      }),
    });
    try {
      const box = await seedBox(raceId, alice);
      const { status, body } = await openBox(
        alice,
        raceId,
        box.id,
        forcedServer.baseUrl
      );
      assert.equal(status, 200);
      assert.equal(body.type, "PROTEIN_SHAKE");
      assert.equal(
        body.rarity,
        "COMMON",
        "the CANONICAL rarity is returned, not the rolled tier"
      );

      const row = await prisma.racePowerup.findUnique({ where: { id: box.id } });
      assert.equal(row.rarity, "COMMON", "the row carries the canonical rarity");

      const discardRes = await request(
        server.baseUrl,
        "POST",
        `/races/${raceId}/powerups/${box.id}/discard`,
        { token: alice.token, headers: FEATURES }
      );
      assert.equal(discardRes.status, 200);
      const discard = await discardRes.json();
      assert.equal(
        discard.coinsAwarded,
        2,
        "discard pays the COMMON price (2), not the UNCOMMON price (5)"
      );
    } finally {
      await forcedServer.close();
    }
  });

  // ── Code review BLOCKER (2026-08-09) ─────────────────────────────────────
  //
  // Lucky Horseshoe promises "guaranteed <minRarity> or better", and at
  // upgrade level 0 that minimum is UNCOMMON. Under Option H the UNCOMMON tier
  // is dominated by PROTEIN_SHAKE / TRAIL_MIX / RUNNERS_HIGH, whose CANONICAL
  // rarity is COMMON — so stamping the canonical rarity unconditionally would
  // turn a paid guarantee into a COMMON card: wrong tint, and a 2-coin discard
  // instead of 5. The stamp must be floored at the guarantee.
  it("6d. Lucky Horseshoe's guaranteed minimum survives the canonical-rarity stamp", async () => {
    const alice = await createUser("AliceLucky");
    const bob = await createUser("BobLucky");
    const raceId = await createActiveRace(alice, [bob], "Lucky stamp");
    await postSamples(alice, [sampleAt(2, 2000)]);

    const participant = await prisma.raceParticipant.findFirst({
      where: { raceId, userId: alice.userId },
    });
    const box = await seedBox(raceId, alice);

    // An ACTIVE Horseshoe with the level-0 guarantee.
    const horseshoe = await prisma.racePowerup.create({
      data: {
        raceId,
        participantId: participant.id,
        userId: alice.userId,
        type: "LUCKY_HORSESHOE",
        rarity: "RARE",
        status: "USED",
        usedAt: new Date(),
        earnedAtSteps: 10,
      },
    });
    await prisma.raceActiveEffect.create({
      data: {
        raceId,
        targetParticipantId: participant.id,
        targetUserId: alice.userId,
        sourceUserId: alice.userId,
        powerupId: horseshoe.id,
        type: "LUCKY_HORSESHOE",
        status: "ACTIVE",
        startsAt: new Date(),
        metadata: { minRarity: "UNCOMMON", consumedOnNextBox: true },
      },
    });

    // The real Option H config — the one that puts a COMMON-canonical type in
    // dropPool.UNCOMMON — plus a roll that lands on it, exactly as the
    // Horseshoe backstop would.
    const optionHConfig = mergeOverDefaults(
      optionHPositionFairness(defaultConfig())
    );
    const luckyServer = await startServer({
      verifyAppleIdentityToken: async (token) => ({
        sub: token,
        email: `${token}@example.com`,
      }),
      openMysteryBox: buildOpenMysteryBox({
        rollPowerupOdds: () => ({ type: "PROTEIN_SHAKE", rarity: "UNCOMMON" }),
        balanceConfig: {
          async getSnapshot() {
            return { version: 99001, config: optionHConfig };
          },
        },
        // The real effect model, so the Horseshoe is actually found (injected
        // deps otherwise stub it out).
        RaceActiveEffect,
      }),
    });
    try {
      const { status, body } = await openBox(
        alice,
        raceId,
        box.id,
        luckyServer.baseUrl
      );
      assert.equal(status, 200);
      assert.equal(body.type, "PROTEIN_SHAKE");
      assert.equal(
        body.rarity,
        "UNCOMMON",
        "a guaranteed-uncommon box must never be stamped COMMON"
      );

      const row = await prisma.racePowerup.findUnique({ where: { id: box.id } });
      assert.equal(row.rarity, "UNCOMMON");

      const discardRes = await request(
        server.baseUrl,
        "POST",
        `/races/${raceId}/powerups/${box.id}/discard`,
        { token: alice.token, headers: FEATURES }
      );
      assert.equal(discardRes.status, 200);
      assert.equal(
        (await discardRes.json()).coinsAwarded,
        5,
        "…and it discards at the UNCOMMON price the guarantee promised"
      );
    } finally {
      await luckyServer.close();
    }
  });
});
