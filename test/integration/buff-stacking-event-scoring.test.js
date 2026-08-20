const assert = require("node:assert/strict");
const { describe, it, before, beforeEach, after } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const { resolveExpiredRaces } = require("../../src/modules/races/jobs/raceExpiry");
const {
  determineFinishSnapshot,
} = require("../../src/modules/races/services/raceStateResolution");

// ---------------------------------------------------------------------------
// Buff-stacking (sum) + multiplicative signed event scoring — end-to-end.
// Each scenario walks real steps inside real effect windows and asserts the
// leaderboard total a client would see through GET /races/:id/progress. One
// test per row of the spec §3 worked-example table (100 real steps → the stated
// counted-steps). Samples are placed on CLOSED hour buckets aligned to effect
// windows so proration is exact.
// ---------------------------------------------------------------------------

let server;
let nextAppleId = 0;
let earnCounter = 0;
const HOUR_MS = 60 * 60 * 1000;
const P5 = { "X-Client-Features": "characters,powerups3,powerups4,powerups5" };

// Hour-aligned instant N hours ago (matches giveHourlySamples bucketing).
const alignedHoursAgo = (h) =>
  new Date(Math.floor((Date.now() - h * HOUR_MS) / HOUR_MS) * HOUR_MS);

async function createUser(displayName) {
  const appleId = `apple-bse-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", { body: { identityToken: appleId } });
  const body = await res.json();
  await request(server.baseUrl, "PUT", "/auth/me/display-name", { body: { displayName }, token: body.sessionToken });
  return { userId: body.user.id, token: body.sessionToken };
}

async function makeFriends(a, b) {
  const sendRes = await request(server.baseUrl, "POST", "/friends/request", { body: { addresseeId: b.userId }, token: a.token });
  const friendshipId = (await sendRes.json()).friendship.id;
  await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, { body: { accept: true }, token: b.token });
}

async function createActiveRace(alice, opponents, opts = {}) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: { name: opts.name || "Buff Stacking Race", targetSteps: 500000, maxDurationDays: 7, powerupsEnabled: true, powerupStepInterval: 5000 },
    token: alice.token,
  });
  const raceId = (await createRes.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, { body: { inviteeIds: opponents.map((o) => o.userId) }, token: alice.token });
  for (const o of opponents) {
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, { body: { accept: true }, token: o.token });
  }
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, { token: alice.token });
  const start = new Date(Date.now() - 8 * HOUR_MS);
  const ends = opts.endsAt !== undefined ? opts.endsAt : new Date(Date.now() + 24 * HOUR_MS);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: start, endsAt: ends } });
  await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: start } });
  return raceId;
}

async function participant(raceId, userId) {
  return prisma.raceParticipant.findFirst({ where: { raceId, userId } });
}

async function giveEffect(raceId, targetUserId, sourceUserId, type, { startsAt, expiresAt, metadata } = {}) {
  const p = await participant(raceId, targetUserId);
  const src = await participant(raceId, sourceUserId);
  const pw = await prisma.racePowerup.create({
    data: { raceId, participantId: src.id, userId: sourceUserId, type, rarity: "UNCOMMON", status: "USED", earnedAtSteps: ++earnCounter },
  });
  return prisma.raceActiveEffect.create({
    data: {
      raceId, targetParticipantId: p.id, targetUserId, sourceUserId, powerupId: pw.id, type, status: "ACTIVE",
      startsAt, expiresAt, metadata: metadata || {},
    },
  });
}

// One closed hourly sample per hour: hours [hoursAgoStart .. hoursAgoStart-hourCount+1].
async function giveHourlySamples(userId, hoursAgoStart, hourCount, stepsPerHour) {
  const now = Date.now();
  for (let i = 0; i < hourCount; i++) {
    const periodStart = new Date(Math.floor((now - (hoursAgoStart - i) * HOUR_MS) / HOUR_MS) * HOUR_MS);
    const periodEnd = new Date(periodStart.getTime() + HOUR_MS);
    await prisma.stepSample.upsert({
      where: { userId_periodStart: { userId, periodStart } },
      update: { steps: stepsPerHour, periodEnd },
      create: { userId, periodStart, periodEnd, steps: stepsPerHour, sourceName: "healthkit" },
    });
  }
}

async function createGlobalEvent({ startsAt, endsAt, multiplier = 2 }) {
  return prisma.globalStepEvent.create({ data: { startsAt, endsAt, multiplier, label: "test 2x event" } });
}

async function getProgress(token, raceId) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, { token, headers: P5 });
  return (await res.json()).progress;
}
function boardSteps(progress, userId) {
  return (progress.participants || []).find((p) => p.userId === userId)?.totalSteps;
}

describe("buff stacking (sum) + signed event scoring — integration", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => { await cleanDatabase(); await prisma.globalStepEvent.deleteMany(); nextAppleId = 0; });
  after(async () => { await prisma.globalStepEvent.deleteMany(); });

  // Boost/freeze ghost pepper covering [startH..startH-boostHours] as boost.
  function pepperMeta(mult = 3) {
    return { boostMs: HOUR_MS, multiplier: mult, freezeMs: HOUR_MS, stepsAtBoostStart: 0 };
  }

  // 1. Pepper boost + 2x event → 6x (DrAmogh's case; the headline bug).
  it("pepper boost + 2x event = 6x", async () => {
    const a = await createUser("A1"); const b = await createUser("B1");
    await makeFriends(a, b);
    const raceId = await createActiveRace(a, [b]);
    await giveHourlySamples(a.userId, 4, 1, 100); // [4h,3h)
    await giveEffect(raceId, a.userId, a.userId, "GHOST_PEPPER", {
      startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(2), metadata: pepperMeta(3), // boost [4h,3h), freeze [3h,2h)
    });
    await createGlobalEvent({ startsAt: alignedHoursAgo(4), endsAt: alignedHoursAgo(3) });
    const prog = await getProgress(a.token, raceId);
    assert.equal(boardSteps(prog, a.userId), 600, "100 base + 200 buff + 300 event = 600 (6x)");
  });

  // 2. Pepper + RH, no event → 5x (sum replaces max).
  it("pepper + runner's high, no event = 5x", async () => {
    const a = await createUser("A2"); const b = await createUser("B2");
    await makeFriends(a, b);
    const raceId = await createActiveRace(a, [b]);
    await giveHourlySamples(a.userId, 4, 1, 100);
    await giveEffect(raceId, a.userId, a.userId, "GHOST_PEPPER", { startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(2), metadata: pepperMeta(3) });
    await giveEffect(raceId, a.userId, a.userId, "RUNNERS_HIGH", { startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(3), metadata: {} });
    const prog = await getProgress(a.token, raceId);
    assert.equal(boardSteps(prog, a.userId), 500, "3x + 2x summed = 5x (not max 3x)");
  });

  // 3. Pepper + RH + 2x event → 10x (the owner's target number).
  it("pepper + RH + 2x event = 10x", async () => {
    const a = await createUser("A3"); const b = await createUser("B3");
    await makeFriends(a, b);
    const raceId = await createActiveRace(a, [b]);
    await giveHourlySamples(a.userId, 4, 1, 100);
    await giveEffect(raceId, a.userId, a.userId, "GHOST_PEPPER", { startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(2), metadata: pepperMeta(3) });
    await giveEffect(raceId, a.userId, a.userId, "RUNNERS_HIGH", { startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(3), metadata: {} });
    await createGlobalEvent({ startsAt: alignedHoursAgo(4), endsAt: alignedHoursAgo(3) });
    const prog = await getProgress(a.token, raceId);
    assert.equal(boardSteps(prog, a.userId), 1000, "5x rate × 2x event = 10x");
  });

  // 4. Pepper + RH + WT + 2x event → −10x (seed prior steps so the floor doesn't mask it).
  it("pepper + RH + wrong turn + 2x event = −10x", async () => {
    const a = await createUser("A4"); const b = await createUser("B4");
    await makeFriends(a, b);
    const raceId = await createActiveRace(a, [b]);
    await giveHourlySamples(a.userId, 7, 1, 2000); // prior, no effects → base 2000
    await giveHourlySamples(a.userId, 4, 1, 100);  // the reversed hour
    await giveEffect(raceId, a.userId, a.userId, "GHOST_PEPPER", { startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(2), metadata: pepperMeta(3) });
    await giveEffect(raceId, a.userId, a.userId, "RUNNERS_HIGH", { startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(3), metadata: {} });
    await giveEffect(raceId, a.userId, b.userId, "WRONG_TURN", { startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(3), metadata: { stepsAtStart: 0 } });
    await createGlobalEvent({ startsAt: alignedHoursAgo(4), endsAt: alignedHoursAgo(3) });
    const prog = await getProgress(a.token, raceId);
    // Pre-walk total = 2000. Walking 100 at −10x drops it by 1000 → 1000.
    assert.equal(boardSteps(prog, a.userId), 1000, "2100 base − 4000 buff − 200 reversal − 1000 event = 1000");
  });

  // 5. WT alone + 2x event → −2x (event credit goes negative — the latent leak).
  it("wrong turn alone + 2x event = −2x", async () => {
    const a = await createUser("A5"); const b = await createUser("B5");
    await makeFriends(a, b);
    const raceId = await createActiveRace(a, [b]);
    await giveHourlySamples(a.userId, 7, 1, 500); // prior base
    await giveHourlySamples(a.userId, 4, 1, 100); // reversed hour
    await giveEffect(raceId, a.userId, b.userId, "WRONG_TURN", { startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(3), metadata: { stepsAtStart: 0 } });
    await createGlobalEvent({ startsAt: alignedHoursAgo(4), endsAt: alignedHoursAgo(3) });
    const prog = await getProgress(a.token, raceId);
    // Pre-walk 500; walking 100 at −2x drops by 200 → 300.
    assert.equal(boardSteps(prog, a.userId), 300, "600 base − 200 reversal − 100 event = 300");
  });

  // 6. Pepper FREEZE phase + 2x event → 0 (frozen steps earn no event credit).
  it("pepper freeze phase + 2x event = 0", async () => {
    const a = await createUser("A6"); const b = await createUser("B6");
    await makeFriends(a, b);
    const raceId = await createActiveRace(a, [b]);
    await giveHourlySamples(a.userId, 4, 1, 100); // [4h,3h) → the freeze half
    // boost [5h,4h), freeze [4h,3h)
    await giveEffect(raceId, a.userId, a.userId, "GHOST_PEPPER", { startsAt: alignedHoursAgo(5), expiresAt: alignedHoursAgo(3), metadata: pepperMeta(3) });
    await createGlobalEvent({ startsAt: alignedHoursAgo(4), endsAt: alignedHoursAgo(3) });
    const prog = await getProgress(a.token, raceId);
    assert.equal(boardSteps(prog, a.userId), 0, "frozen: 100 base − 100 frozen + 0 event = 0");
  });

  // 7. Freeze + WT overlap → 0 (freeze beats reversal).
  it("freeze + wrong turn = 0 (freeze beats WT)", async () => {
    const a = await createUser("A7"); const b = await createUser("B7");
    await makeFriends(a, b);
    const raceId = await createActiveRace(a, [b]);
    await giveHourlySamples(a.userId, 4, 1, 100);
    await giveEffect(raceId, a.userId, a.userId, "GHOST_PEPPER", { startsAt: alignedHoursAgo(5), expiresAt: alignedHoursAgo(3), metadata: pepperMeta(3) }); // freeze [4h,3h)
    await giveEffect(raceId, a.userId, b.userId, "WRONG_TURN", { startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(3), metadata: { stepsAtStart: 0 } });
    const prog = await getProgress(a.token, raceId);
    assert.equal(boardSteps(prog, a.userId), 0, "freeze wins: no base, no reversal");
  });

  // 8. Three-way RH + Uprising(2) + Pepper → 7x (proves true sum, not pairwise).
  it("RH + uprising(2) + pepper = 7x (three-way sum)", async () => {
    const a = await createUser("A8"); const b = await createUser("B8");
    await makeFriends(a, b);
    const raceId = await createActiveRace(a, [b]);
    await giveHourlySamples(a.userId, 4, 1, 100);
    await giveEffect(raceId, a.userId, a.userId, "GHOST_PEPPER", { startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(2), metadata: pepperMeta(3) });
    await giveEffect(raceId, a.userId, a.userId, "RUNNERS_HIGH", { startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(3), metadata: {} });
    await giveEffect(raceId, a.userId, a.userId, "UPRISING", { startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(3), metadata: { multiplier: 2 } });
    const prog = await getProgress(a.token, raceId);
    assert.equal(boardSteps(prog, a.userId), 700, "3 + 2 + 2 = 7x");
  });

  // 9. Campfire boost 2.25 + RH → 4.25x (old max test's scenario, new rule).
  it("campfire boost 2.25 + RH = 4.25x", async () => {
    const a = await createUser("A9"); const b = await createUser("B9");
    await makeFriends(a, b);
    const raceId = await createActiveRace(a, [b]);
    await giveHourlySamples(a.userId, 4, 1, 100); // boost half [4h,3h)
    // freeze [5h,4h), boost [4h,3h)
    await giveEffect(raceId, a.userId, a.userId, "CAMPFIRE_REST", {
      startsAt: alignedHoursAgo(5), expiresAt: alignedHoursAgo(3),
      metadata: { freezeMs: HOUR_MS, boostMs: HOUR_MS, multiplier: 2.25, stepsAtRestStart: 0 },
    });
    await giveEffect(raceId, a.userId, a.userId, "RUNNERS_HIGH", { startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(3), metadata: {} });
    const prog = await getProgress(a.token, raceId);
    assert.equal(boardSteps(prog, a.userId), 425, "2.25 + 2 = 4.25x → 100 + 325");
  });

  // 10. Rainstorm + 2x event → 1x (reduction is multiplied by the event).
  it("rainstorm(0.5) + 2x event = 1x", async () => {
    const a = await createUser("A10"); const b = await createUser("B10");
    await makeFriends(a, b);
    const raceId = await createActiveRace(a, [b]);
    await giveHourlySamples(a.userId, 4, 1, 100);
    await giveEffect(raceId, a.userId, b.userId, "RAINSTORM", { startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(3), metadata: { multiplier: 0.5, stepsAtStart: 0 } });
    await createGlobalEvent({ startsAt: alignedHoursAgo(4), endsAt: alignedHoursAgo(3) });
    const prog = await getProgress(a.token, raceId);
    // 0.5x rate × 2x event = 1x. 100 − 50 + 50 = 100.
    assert.equal(boardSteps(prog, a.userId), 100, "0.5 × 2 event = 1x");
  });

  // 11a. Settlement parity: scenario 3 active at race end, settled == live.
  it("settlement parity: settled total equals the live 10x total", async () => {
    const a = await createUser("A11"); const b = await createUser("B11");
    await makeFriends(a, b);
    const raceId = await createActiveRace(a, [b]);
    await giveHourlySamples(a.userId, 4, 1, 100);
    await giveEffect(raceId, a.userId, a.userId, "GHOST_PEPPER", { startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(2), metadata: pepperMeta(3) });
    await giveEffect(raceId, a.userId, a.userId, "RUNNERS_HIGH", { startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(3), metadata: {} });
    await createGlobalEvent({ startsAt: alignedHoursAgo(4), endsAt: alignedHoursAgo(3) });
    const live = boardSteps(await getProgress(a.token, raceId), a.userId);
    assert.equal(live, 1000);
    await prisma.race.update({ where: { id: raceId }, data: { endsAt: new Date(Date.now() - 60 * 1000) } });
    await resolveExpiredRaces();
    const settled = await participant(raceId, a.userId);
    assert.equal(settled.totalSteps, live, "settled == live (no divergence)");
  });

  // 11b. determineFinishSnapshot interpolates a target crossing using the SUMMED
  // multiplier. This function is only reachable through settlement's tie-break
  // (races are time-based; no live target-finish), so it is asserted directly —
  // the same pattern test/services/raceStateResolution.test.js uses for it.
  it("determineFinishSnapshot interpolates the crossing at the summed (pepper+RH=5x) rate", async () => {
    const T0 = new Date("2026-04-07T10:00:00Z");
    const T1 = new Date("2026-04-07T11:00:00Z");
    const samples = [{ periodStart: T0.toISOString(), periodEnd: T1.toISOString(), steps: 1200 }]; // 20/min raw
    const snapshotDeps = {
      stepSampleModel: { async findByUserIdAndTimeRange() { return samples; } },
      powerupEventModel: { async findByRaceAsc() { return []; } },
    };
    const snapshot = await determineFinishSnapshot({
      participant: { userId: "user-1", bonusSteps: 0 },
      currentTotal: 6000, // 1200 × 5x
      targetSteps: 2500,
      effectiveStart: T0,
      effectGroups: {
        legCramps: [], runnersHighs: [{ startsAt: T0, expiresAt: T1, metadata: {} }], wrongTurns: [],
        campfires: [], rainstorms: [], uprisings: [], rallyFlags: [], coinFlipWins: [], coinFlipLoses: [],
        ghostPeppers: [{ startsAt: T0, expiresAt: T1, metadata: { boostMs: 60 * 60 * 1000, multiplier: 3 } }],
      },
      ...snapshotDeps,
      raceId: "race-1",
      now: T1,
    });
    // Raw 20/min at 5x = 100 counted/min → 2500 reached at minute 25 (10:25).
    // Old max(3,2)=3x would give 60/min → 2500 at ~41.7min, so 10:25 proves SUM.
    assert.equal(snapshot.finishTotalSteps, 2500);
    assert.equal(snapshot.finishedAt.toISOString(), "2026-04-07T10:25:00.000Z");
  });

  // ── Batch 2026-08-10b item 6 — RAINSTORM is MULTIPLICATIVE ──────────────
  //
  // Rainstorm multiplication is permanent. Scenario 10 above pins the
  // unbuffed case; these pin the buffed case end-to-end through the HTTP
  // response a client actually receives, including the retired env name.
  const RAIN_FLAG = "RAINSTORM_MULTIPLICATIVE_ENABLED";

  async function prodRepro(a, b, raceId) {
    // DrAmogh's row: Rally Flag (×1.25) + Ghost Pepper boost (×3) during a 2×
    // global step event, rainstormed. Buff sum = 4.25.
    await giveHourlySamples(a.userId, 4, 1, 100);
    await giveEffect(raceId, a.userId, a.userId, "GHOST_PEPPER", {
      startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(2), metadata: pepperMeta(3),
    });
    await giveEffect(raceId, a.userId, a.userId, "RALLY_FLAG", {
      startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(3), metadata: { multiplier: 1.25 },
    });
    await giveEffect(raceId, a.userId, b.userId, "RAINSTORM", {
      startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(3), metadata: { multiplier: 0.5, stepsAtStart: 0 },
    });
    await createGlobalEvent({ startsAt: alignedHoursAgo(4), endsAt: alignedHoursAgo(3) });
  }

  it("item 6 ON: buffed + rainstorm halves the whole stack (4.25 → 2.125, not 3.75)", async () => {
    process.env[RAIN_FLAG] = "true";
    try {
      const a = await createUser("A13"); const b = await createUser("B13");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      await prodRepro(a, b, raceId);
      const prog = await getProgress(a.token, raceId);
      // rate 4.25 × 0.5 = 2.125; × 2 event = 4.25 → 100 walked steps score 425.
      assert.equal(boardSteps(prog, a.userId), 425, "2.125 rate × 2x event");
    } finally {
      delete process.env[RAIN_FLAG];
    }
  });

  it("retired OFF env cannot restore subtractive rainstorm scoring", async () => {
    process.env[RAIN_FLAG] = "false";
    try {
      const a = await createUser("A14"); const b = await createUser("B14");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      await prodRepro(a, b, raceId);
      const prog = await getProgress(a.token, raceId);
      // Permanent: 4.25 × 0.5 × 2 event → 425, regardless of stale env.
      assert.equal(boardSteps(prog, a.userId), 425, "retired env cannot disable multiplication");
    } finally {
      delete process.env[RAIN_FLAG];
    }
  });

  it("item 6 ON: settlement matches the live buffed-storm total", async () => {
    process.env[RAIN_FLAG] = "true";
    try {
      const a = await createUser("A15"); const b = await createUser("B15");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      await prodRepro(a, b, raceId);
      const live = boardSteps(await getProgress(a.token, raceId), a.userId);
      assert.equal(live, 425);
      await prisma.race.update({ where: { id: raceId }, data: { endsAt: new Date(Date.now() - 60 * 1000) } });
      await resolveExpiredRaces();
      const settled = await participant(raceId, a.userId);
      assert.equal(settled.totalSteps, live, "settled == live (no divergence)");
    } finally {
      delete process.env[RAIN_FLAG];
    }
  });

  it("item 6 ON: an unbuffed rainstormed racer is bit-identical to scenario 10", async () => {
    process.env[RAIN_FLAG] = "true";
    try {
      const a = await createUser("A16"); const b = await createUser("B16");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      await giveHourlySamples(a.userId, 4, 1, 100);
      await giveEffect(raceId, a.userId, b.userId, "RAINSTORM", {
        startsAt: alignedHoursAgo(4), expiresAt: alignedHoursAgo(3), metadata: { multiplier: 0.5, stepsAtStart: 0 },
      });
      await createGlobalEvent({ startsAt: alignedHoursAgo(4), endsAt: alignedHoursAgo(3) });
      const prog = await getProgress(a.token, raceId);
      assert.equal(boardSteps(prog, a.userId), 100, "M=1 unbuffed: unchanged by the fix");
    } finally {
      delete process.env[RAIN_FLAG];
    }
  });

  it("item 6 ON: an umbrella'd victim is protected while it is up and halved after", async () => {
    process.env[RAIN_FLAG] = "true";
    try {
      const a = await createUser("A17"); const b = await createUser("B17");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      // Two walked hours; the umbrella covers only the first.
      await giveHourlySamples(a.userId, 5, 2, 100); // [5h,4h) and [4h,3h)
      await giveEffect(raceId, a.userId, a.userId, "RUNNERS_HIGH", {
        startsAt: alignedHoursAgo(5), expiresAt: alignedHoursAgo(3), metadata: {},
      });
      await giveEffect(raceId, a.userId, b.userId, "RAINSTORM", {
        startsAt: alignedHoursAgo(5), expiresAt: alignedHoursAgo(3), metadata: { multiplier: 0.5, stepsAtStart: 0 },
      });
      await giveEffect(raceId, a.userId, a.userId, "UMBRELLA", {
        startsAt: alignedHoursAgo(5), expiresAt: alignedHoursAgo(4), metadata: {},
      });
      const prog = await getProgress(a.token, raceId);
      // hour 1: RH 2x, umbrella cancels the rain → 200.
      // hour 2: RH 2x halved → 1x → 100. (Old rule: 2 − 0.5 = 1.5 → 150.)
      assert.equal(boardSteps(prog, a.userId), 300, "200 + 100");
    } finally {
      delete process.env[RAIN_FLAG];
    }
  });

  // 12. No-effects regression: with and without an event → plain 1x / 2x.
  it("no effects: 1x without event, 2x with event", async () => {
    const a = await createUser("A12"); const b = await createUser("B12");
    await makeFriends(a, b);
    const raceId = await createActiveRace(a, [b]);
    await giveHourlySamples(a.userId, 4, 1, 100);
    const noEvent = boardSteps(await getProgress(a.token, raceId), a.userId);
    assert.equal(noEvent, 100, "1x with no effects and no event");

    await createGlobalEvent({ startsAt: alignedHoursAgo(4), endsAt: alignedHoursAgo(3) });
    const withEvent = boardSteps(await getProgress(a.token, raceId), a.userId);
    assert.equal(withEvent, 200, "2x with the event, still no per-participant effects");
  });
});
