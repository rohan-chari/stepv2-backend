const assert = require("node:assert/strict");
const { describe, it, before, beforeEach, after } = require("node:test");

const {
  cleanDatabase,
  prisma,
  request,
  getSharedServer,
  createTestUser,
} = require("./setup");

const { appSettings } = require("../../src/shared/config/appSettings");
const { resolveExpiredRaces } = require("../../src/modules/races/jobs/raceExpiry");
const {
  buildRenewSeededRaces,
} = require("../../src/modules/races/jobs/seededRaceRenewal");
const {
  buildAutoJoinFeaturedRaces,
} = require("../../src/modules/races/commands/autoJoinFeaturedRaces");
const {
  autoEnrollNewUser,
} = require("../../src/modules/races/commands/autoEnrollNewUser");
const {
  RaceResolutionJobV2,
} = require("../../src/modules/races/models/raceResolutionJobV2");
const {
  getTimeZoneParts,
  formatDateString,
  addDaysToDateString,
  parseDateString,
  zonedDateTimeToUtc,
} = require("../../src/shared/time/week");

// Seeded challenge top-heavy payouts + inactive-participant pruning
// (docs/seeded-challenge-payouts-and-inactivity-requirements.md §7, tests 1-15).
// Payout numbers are proved through real HTTP reads and real settlement; the
// prune hooks are driven through the real renewal cron / enrollment command.

const CURVE_FLAG = "seededGeometricPayoutsEnabled";
const PRUNE_FLAG = "seededInactivityPruneEnabled";
// Batch 2026-08-10 item 1: sub-switch over the auto-enroll flip. Only ever
// consulted inside the prune hooks, so PRUNE_FLAG must also be on.
const AUTO_OFF_FLAG = "seededInactivityAutoEnrollOffEnabled";
const FUNDED_FLAG = "fundedPrizePoolsEnabled";
const POOL_REASON = "race_prize_pool_payout";
const TZ = "America/New_York";

// Seeds owned by this file. Created once, removed in `after`, so the shared
// prod-shaped seeds (DAILY_10K / WEEKLY_50K) are never mutated.
const DAILY_KIND = "TEST_INACTIVITY_DAILY";
const WEEKLY_KIND = "TEST_INACTIVITY_WEEKLY";

let server;
let dailySeed;
let weeklySeed;
let seq = 0;

// ── ET calendar helpers (fixture placement mirrors the predicate's windows) ──

function etDayKey(date) {
  const parts = getTimeZoneParts(date, TZ);
  return formatDateString(parts.year, parts.month, parts.day);
}

function etDayStart(dayKey) {
  const { year, month, day } = parseDateString(dayKey);
  return zonedDateTimeToUtc(
    { year, month, day, hour: 0, minute: 0, second: 0 },
    TZ
  );
}

function dayKeyOffset(offset, base = new Date()) {
  return addDaysToDateString(etDayKey(base), offset);
}

// A one-hour step sample at noon ET on `dayKey` — the "this user walked" fixture.
async function walkOn(userId, dayKey, steps = 5000) {
  const start = new Date(etDayStart(dayKey).getTime() + 12 * 60 * 60 * 1000);
  await prisma.stepSample.create({
    data: {
      userId,
      periodStart: start,
      periodEnd: new Date(start.getTime() + 60 * 60 * 1000),
      steps,
    },
  });
}

// A client-asserted daily total keyed to a LOCAL calendar date.
async function dailyRow(userId, dayKey, steps) {
  await prisma.step.create({
    data: { userId, date: new Date(`${dayKey}T00:00:00.000Z`), steps },
  });
}

// A mystery-box open by `userId` at `at` (batch 2026-08-10 item 1). The event
// row is what "engaged with the game loop" means; `eventType` is overridable so
// a reroll-style row can prove it does NOT count.
async function boxEvent(userId, raceId, at, eventType = "MYSTERY_BOX_OPENED") {
  await prisma.racePowerupEvent.create({
    data: {
      raceId,
      actorUserId: userId,
      eventType,
      description: "opened a mystery box",
      createdAt: at,
    },
  });
}

// Noon ET on the ET calendar day `offset` days from today.
function etNoon(offset) {
  return new Date(etDayStart(dayKeyOffset(offset)).getTime() + 12 * 3600 * 1000);
}

async function autoJoinFlagOf(userId) {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { autoJoinFeaturedRaces: true },
  });
  return row.autoJoinFeaturedRaces;
}

// A PENDING seeded daily race whose scheduled start has already passed, i.e.
// one the next renewal tick will promote (and prune).
async function duePendingDaily(overrides = {}) {
  return prisma.race.create({
    data: {
      seedId: dailySeed.id,
      name: "Daily",
      targetSteps: 0,
      status: "PENDING",
      isPublic: true,
      timeBased: true,
      maxParticipants: 100,
      maxDurationDays: 1,
      createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      scheduledStartAt: new Date(Date.now() - 60 * 1000),
      endsAt: new Date(Date.now() + 23 * 60 * 60 * 1000),
      ...overrides,
    },
  });
}

const LONG_AGO = new Date("2024-01-01T00:00:00.000Z");

async function makeUser({ createdAt = LONG_AGO, ...overrides } = {}) {
  const { user, token } = await createTestUser({
    appleId: `apple-sci-${++seq}`,
    email: `sci-${seq}@example.com`,
    createdAt,
    ...overrides,
  });
  return { userId: user.id, token, user };
}

function req(method, path, { body, token } = {}) {
  return request(server.baseUrl, method, path, { body, token });
}

async function participantUserIds(raceId) {
  const rows = await prisma.raceParticipant.findMany({
    where: { raceId },
    select: { userId: true },
  });
  return rows.map((r) => r.userId).sort();
}

// An ACTIVE funded race row. `curve` is the stamped discriminator under test.
async function fundedRace({
  curve = null,
  seedId = null,
  creatorId = null,
  durationDays = 1,
  expired = true,
  preset = "TOP_HALF",
  shareToken = null,
} = {}) {
  const startedAt = new Date(Date.now() - durationDays * 24 * 60 * 60 * 1000);
  return prisma.race.create({
    data: {
      creatorId,
      seedId,
      name: "Challenge",
      targetSteps: 0,
      status: "ACTIVE",
      isPublic: true,
      timeBased: true,
      maxParticipants: null,
      maxDurationDays: durationDays,
      payoutPreset: preset,
      payoutCurve: curve,
      fundedPrize: true,
      shareToken,
      startedAt,
      endsAt: expired
        ? new Date(Date.now() - 60 * 60 * 1000)
        : new Date(Date.now() + 60 * 60 * 1000),
    },
    select: { id: true, startedAt: true },
  });
}

async function addWalkers(race, count) {
  const users = [];
  for (let i = 0; i < count; i++) {
    const user = await makeUser();
    users.push(user);
    await prisma.raceParticipant.create({
      data: {
        raceId: race.id,
        userId: user.userId,
        status: "ACCEPTED",
        totalSteps: 100000 - i * 100,
        finishedAt: new Date(Date.now() - 30 * 60 * 1000),
        finishTotalSteps: 100000 - i * 100,
        joinedAt: race.startedAt,
      },
    });
  }
  return users;
}

async function tiersOf(raceId) {
  const rows = await prisma.raceParticipant.findMany({
    where: { raceId, placement: { not: null } },
    orderBy: { placement: "asc" },
    select: { placement: true, payoutCoins: true },
  });
  return rows;
}

function assertDescending(amounts, label) {
  for (let i = 1; i < amounts.length; i++) {
    assert.ok(
      amounts[i - 1] > amounts[i],
      `${label}: place ${i} (${amounts[i - 1]}) must beat place ${i + 1} (${amounts[i]})`
    );
  }
}

describe("seeded challenge payouts + inactivity pruning", () => {
  before(async () => {
    server = await getSharedServer();
    dailySeed = await prisma.raceSeed.upsert({
      where: { kind: DAILY_KIND },
      update: { active: true },
      create: {
        id: "seed-test-inactivity-daily",
        kind: DAILY_KIND,
        name: "Test Daily Challenge",
        targetSteps: 0,
        durationHours: 24,
        cadence: "DAILY",
        maxParticipants: 100,
        timeBased: true,
        active: true,
      },
    });
    weeklySeed = await prisma.raceSeed.upsert({
      where: { kind: WEEKLY_KIND },
      update: { active: true },
      create: {
        id: "seed-test-inactivity-weekly",
        kind: WEEKLY_KIND,
        name: "Test Weekly Challenge",
        targetSteps: 0,
        durationHours: 168,
        cadence: "WEEKLY",
        maxParticipants: 100,
        timeBased: true,
        active: true,
      },
    });
  });

  beforeEach(async () => {
    await cleanDatabase();
    await prisma.jobRun.deleteMany({});
    seq = 0;
    await appSettings.setFlag(FUNDED_FLAG, true);
    await appSettings.setFlag(CURVE_FLAG, false);
    await appSettings.setFlag(PRUNE_FLAG, false);
    await appSettings.setFlag(AUTO_OFF_FLAG, false);
  });

  after(async () => {
    await appSettings.setFlag(CURVE_FLAG, false);
    await appSettings.setFlag(PRUNE_FLAG, false);
    await appSettings.setFlag(AUTO_OFF_FLAG, false);
    await appSettings.setFlag(FUNDED_FLAG, true);
    await prisma.race.deleteMany({
      where: { seedId: { in: [dailySeed.id, weeklySeed.id] } },
    });
    await prisma.raceSeed.deleteMany({
      where: { kind: { in: [DAILY_KIND, WEEKLY_KIND] } },
    });
    await prisma.jobRun.deleteMany({});
  });

  // ── Feature A — geometric payouts ────────────────────────────────────────

  it("1: a GEOMETRIC seeded funded race settles top-heavy tiers summing to the pool", async () => {
    const race = await fundedRace({ curve: "GEOMETRIC", seedId: dailySeed.id });
    await addWalkers(race, 6);

    await resolveExpiredRaces();

    const settled = await prisma.race.findUnique({ where: { id: race.id } });
    assert.equal(settled.status, "COMPLETED");
    // 6 walkers x 1 durationPoint x 20 = 120; TOP_HALF of 6 = 3 paid places.
    assert.equal(settled.prizePoolCoins, 120);

    const rows = await tiersOf(race.id);
    const paid = rows.filter((r) => r.payoutCoins > 0).map((r) => r.payoutCoins);
    assert.equal(paid.length, 3, "slot count unchanged by the curve");
    assertDescending(paid, "geometric tiers");
    assert.equal(
      paid.reduce((sum, amount) => sum + amount, 0),
      120,
      "tiers sum to the stamped pool"
    );
    assert.ok(paid[0] > 40, "1st beats the 40-coin even share");
    assert.ok(paid[paid.length - 1] >= 1, "last paid place clears the floor");

    const ledger = await prisma.coinTransaction.findMany({
      where: { reason: POOL_REASON, refId: { startsWith: `${race.id}:` } },
    });
    assert.equal(
      ledger.reduce((sum, t) => sum + t.amount, 0),
      120,
      "minted exactly the pool"
    );
  });

  it("2: NULL-curve funded races (seeded and user-created) still settle EVEN", async () => {
    const seeded = await fundedRace({ curve: null, seedId: dailySeed.id });
    await addWalkers(seeded, 6);

    const creator = await makeUser();
    const userMade = await fundedRace({ curve: null, creatorId: creator.userId });
    await addWalkers(userMade, 6);

    await resolveExpiredRaces();

    for (const race of [seeded, userMade]) {
      const paid = (await tiersOf(race.id))
        .filter((r) => r.payoutCoins > 0)
        .map((r) => r.payoutCoins);
      assert.deepEqual(paid, [40, 40, 40], `race ${race.id} split evenly`);
    }

    // ...and a COMPLETED NULL-curve race keeps serving the even tiers it paid.
    const viewer = await prisma.raceParticipant.findFirst({
      where: { raceId: seeded.id },
      select: { userId: true },
    });
    const detailsRes = await req("GET", `/races/${seeded.id}`, {
      token: await tokenFor(viewer.userId),
    });
    assert.equal(detailsRes.status, 200);
    const body = await detailsRes.json();
    assert.deepEqual(
      body.payoutTiers.map((t) => t.amount),
      [40, 40, 40]
    );
  });

  it("3: a live GEOMETRIC race serves geometric tiers on all three tier-emitting read paths", async () => {
    const race = await fundedRace({
      curve: "GEOMETRIC",
      seedId: dailySeed.id,
      expired: false,
      shareToken: "share-geo-1",
    });
    const users = await addWalkers(race, 6);
    const viewer = users[0];

    const expectedSum = 120;

    // (a) GET /races/:id
    const details = await req("GET", `/races/${race.id}`, { token: viewer.token });
    assert.equal(details.status, 200);
    const detailBody = await details.json();
    const detailAmounts = detailBody.payoutTiers.map((t) => t.amount);
    assert.equal(detailAmounts.length, 3);
    assertDescending(detailAmounts, "details");
    assert.equal(
      detailAmounts.reduce((s, a) => s + a, 0),
      expectedSum
    );

    // (b) GET /races
    const list = await req("GET", "/races", { token: viewer.token });
    const listBody = await list.json();
    const mine = listBody.active.find((r) => r.id === race.id);
    assert.ok(mine, "race present on the list");
    assert.deepEqual(
      mine.payoutTiers.map((t) => t.amount),
      detailAmounts,
      "list tiers match details"
    );

    // (c) GET /races/public — the browser hides races you're already in, so
    // read it as an outsider.
    const outsider = await makeUser();
    const publicRes = await req("GET", "/races/public", {
      token: outsider.token,
    });
    const publicBody = await publicRes.json();
    const pub = publicBody.races.find((r) => r.id === race.id);
    assert.ok(pub, "race present in the public browser");
    assert.deepEqual(
      pub.payoutTiers.map((t) => t.amount),
      detailAmounts,
      "public tiers match details"
    );

    // Featured + shared preview carry no tiers by design — only a coherent pool.
    const featured = await req("GET", "/races/featured", { token: viewer.token });
    const featuredBody = await featured.json();
    const feat = featuredBody.races.find((r) => r.raceId === race.id);
    assert.ok(feat, "race is featured");
    assert.equal(feat.prizePool.coins, expectedSum);
    assert.equal(feat.payoutTiers, undefined);

    const shared = await req("GET", "/races/share/share-geo-1");
    assert.equal(shared.status, 200);
    const sharedBody = await shared.json();
    assert.equal(sharedBody.race.prizePool.coins, expectedSum);
    assert.equal(sharedBody.race.payoutTiers, undefined);
  });

  it("4: the legacy payouts{first,second,third} shape mirrors the geometric tiers", async () => {
    const race = await fundedRace({
      curve: "GEOMETRIC",
      seedId: dailySeed.id,
      expired: false,
    });
    const users = await addWalkers(race, 6);

    const details = await req("GET", `/races/${race.id}`, {
      token: users[0].token,
    });
    const body = await details.json();
    assert.equal(body.payouts.first, body.payoutTiers[0].amount);
    assert.equal(body.payouts.second, body.payoutTiers[1].amount);
    assert.equal(body.payouts.third, body.payoutTiers[2].amount);
  });

  it("5: the curve flag decides the stamp at creation and never rewrites a stamped race", async () => {
    const renew = buildRenewSeededRaces({ prisma });

    await appSettings.setFlag(CURVE_FLAG, false);
    await renew();
    const off = await prisma.race.findMany({ where: { seedId: dailySeed.id } });
    assert.ok(off.length > 0, "cron created seeded races");
    assert.ok(
      off.every((r) => r.payoutCurve === null),
      "flag OFF stamps NULL"
    );

    await prisma.race.deleteMany({ where: { seedId: dailySeed.id } });
    await appSettings.setFlag(CURVE_FLAG, true);
    await renew();
    const on = await prisma.race.findMany({ where: { seedId: dailySeed.id } });
    assert.ok(on.length > 0);
    assert.ok(
      on.every((r) => r.payoutCurve === "GEOMETRIC"),
      "flag ON stamps GEOMETRIC"
    );

    // Flipping the flag back OFF must not touch an already-stamped race.
    await appSettings.setFlag(CURVE_FLAG, false);
    await renew();
    for (const race of on) {
      const after = await prisma.race.findUnique({ where: { id: race.id } });
      assert.equal(after.payoutCurve, "GEOMETRIC");
    }
  });

  it("6: tournament matchup races are untouched by both flags", async () => {
    await appSettings.setFlag(CURVE_FLAG, true);
    await appSettings.setFlag(PRUNE_FLAG, true);

    const entrants = [];
    for (let i = 0; i < 4; i++) entrants.push(await makeUser());
    const features = { "X-Client-Features": "tournaments" };
    const created = await request(server.baseUrl, "POST", "/tournaments", {
      token: entrants[0].token,
      headers: features,
      body: {
        name: "Regression Cup",
        bracketSize: 4,
        matchupDurationDays: 2,
        buyInAmount: 0,
        isPublic: true,
      },
    });
    assert.equal(created.status, 201);
    const { tournament } = await created.json();
    for (const entrant of entrants.slice(1)) {
      const join = await request(
        server.baseUrl,
        "POST",
        `/tournaments/${tournament.id}/join`,
        { token: entrant.token, headers: features }
      );
      assert.equal(join.status, 201);
    }

    const matchups = await prisma.race.findMany({
      where: { tournamentId: tournament.id },
    });
    assert.ok(matchups.length > 0, "bracket minted a matchup race");
    for (const race of matchups) {
      assert.equal(race.seedId, null);
      assert.equal(race.payoutPreset, "WINNER_TAKES_ALL");
      assert.equal(race.payoutCurve, null, "no curve is ever stamped on a matchup");
    }

    // Both bracket entrants survive the prune hooks (no seeded race involved).
    const rows = await prisma.raceParticipant.findMany({
      where: { raceId: { in: matchups.map((r) => r.id) } },
    });
    assert.equal(rows.length, 4);
  });

  // ── Feature B — inactivity hooks ─────────────────────────────────────────

  it("7: enrollment skips 2-day-zero users, keeps walkers and brand-new accounts", async () => {
    await appSettings.setFlag(PRUNE_FLAG, true);
    const d1 = dayKeyOffset(-1);

    const ghost = await makeUser({ autoJoinFeaturedRaces: true });
    const walker = await makeUser({ autoJoinFeaturedRaces: true });
    await walkOn(walker.userId, d1);
    const fresh = await makeUser({
      autoJoinFeaturedRaces: true,
      createdAt: new Date(),
    });

    const race = await prisma.race.create({
      data: {
        seedId: dailySeed.id,
        name: "Daily",
        targetSteps: 0,
        status: "PENDING",
        isPublic: true,
        timeBased: true,
        maxParticipants: 100,
        maxDurationDays: 1,
        scheduledStartAt: new Date(Date.now() + 60 * 60 * 1000),
        endsAt: new Date(Date.now() + 25 * 60 * 60 * 1000),
      },
      select: { id: true, maxParticipants: true },
    });

    const { enrollAutoJoinUsers } = buildAutoJoinFeaturedRaces({ prisma });
    await enrollAutoJoinUsers(race);

    assert.deepEqual(
      await participantUserIds(race.id),
      [walker.userId, fresh.userId].sort(),
      "the 2-day-zero ghost is not enrolled"
    );
    void ghost;
  });

  it("8: promotion prunes every 2-day-zero join source before the ACTIVE flip", async () => {
    await appSettings.setFlag(PRUNE_FLAG, true);
    const d1 = dayKeyOffset(-1);

    const cronGhost = await makeUser({ autoJoinFeaturedRaces: true });
    const toggleGhost = await makeUser();
    const manualGhost = await makeUser();
    const walker = await makeUser();
    await walkOn(walker.userId, d1);
    // Born after the race row was minted => the signup-promise exemption.
    const signup = await makeUser({ createdAt: new Date() });

    const race = await prisma.race.create({
      data: {
        seedId: dailySeed.id,
        name: "Daily",
        targetSteps: 0,
        status: "PENDING",
        isPublic: true,
        timeBased: true,
        powerupsEnabled: true,
        powerupStepInterval: 2000,
        maxParticipants: 100,
        maxDurationDays: 1,
        createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
        scheduledStartAt: new Date(Date.now() - 60 * 1000),
        endsAt: new Date(Date.now() + 23 * 60 * 60 * 1000),
      },
    });

    // Rows from all three join sources are byte-identical by construction (D3
    // removed the enrollment-source column), so seed them directly: what this
    // test proves is that PROMOTION removes them regardless of provenance.
    for (const user of [cronGhost, toggleGhost, manualGhost, walker, signup]) {
      await prisma.raceParticipant.create({
        data: { raceId: race.id, userId: user.userId, status: "ACCEPTED" },
      });
    }

    const emitted = [];
    const renew = buildRenewSeededRaces({
      prisma,
      eventBus: { emit: (name, payload) => emitted.push({ name, payload }) },
    });
    await renew();

    const survivors = await participantUserIds(race.id);
    assert.deepEqual(
      survivors,
      [walker.userId, signup.userId].sort(),
      "all three ghost join sources pruned; walker + signup kept"
    );

    const promoted = await prisma.race.findUnique({ where: { id: race.id } });
    assert.equal(promoted.status, "ACTIVE");

    const started = emitted.find(
      (e) => e.name === "RACE_STARTED" && e.payload.raceId === race.id
    );
    assert.ok(started, "RACE_STARTED emitted");
    assert.deepEqual(
      [...started.payload.participantUserIds].sort(),
      [walker.userId, signup.userId].sort(),
      "pruned users get no start push"
    );

    const boxes = await prisma.raceParticipant.findMany({
      where: { raceId: race.id },
      select: { userId: true, nextBoxAtSteps: true },
    });
    assert.ok(
      boxes.every((p) => p.nextBoxAtSteps === 2000),
      "only survivors were given box thresholds"
    );
    const ghostRow = await prisma.raceParticipant.findFirst({
      where: { raceId: race.id, userId: cronGhost.userId },
    });
    assert.equal(ghostRow, null);
  });

  it("9: the promotion prune is idempotent (deleteMany, safe under a double promotion)", async () => {
    await appSettings.setFlag(PRUNE_FLAG, true);
    const ghost = await makeUser();
    const race = await prisma.race.create({
      data: {
        seedId: dailySeed.id,
        name: "Daily",
        targetSteps: 0,
        status: "PENDING",
        isPublic: true,
        timeBased: true,
        maxParticipants: 100,
        maxDurationDays: 1,
        createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
        scheduledStartAt: new Date(Date.now() - 60 * 1000),
        endsAt: new Date(Date.now() + 23 * 60 * 60 * 1000),
      },
    });
    await prisma.raceParticipant.create({
      data: { raceId: race.id, userId: ghost.userId, status: "ACCEPTED" },
    });

    const renew = buildRenewSeededRaces({ prisma });
    await renew();
    assert.deepEqual(await participantUserIds(race.id), []);

    // Re-run the whole promotion against the (now ACTIVE, already pruned) race:
    // a second pass must be a silent no-op, never a P2025.
    await prisma.race.update({
      where: { id: race.id },
      data: { status: "PENDING", startedAt: null },
    });
    await renew();
    assert.deepEqual(await participantUserIds(race.id), []);
  });

  it("10: with the prune flag OFF nothing is filtered, pruned or swept", async () => {
    await appSettings.setFlag(PRUNE_FLAG, false);
    const ghost = await makeUser({ autoJoinFeaturedRaces: true });

    const race = await prisma.race.create({
      data: {
        seedId: dailySeed.id,
        name: "Daily",
        targetSteps: 0,
        status: "PENDING",
        isPublic: true,
        timeBased: true,
        maxParticipants: 100,
        maxDurationDays: 1,
        createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
        scheduledStartAt: new Date(Date.now() - 60 * 1000),
        endsAt: new Date(Date.now() + 23 * 60 * 60 * 1000),
      },
      select: { id: true, maxParticipants: true },
    });

    const { enrollAutoJoinUsers } = buildAutoJoinFeaturedRaces({ prisma });
    await enrollAutoJoinUsers(race);
    assert.deepEqual(await participantUserIds(race.id), [ghost.userId]);

    await buildRenewSeededRaces({ prisma })();
    assert.deepEqual(
      await participantUserIds(race.id),
      [ghost.userId],
      "promotion kept the ghost while the flag is off"
    );
  });

  it("11: review accounts survive enrollment, promotion and the weekly sweep", async () => {
    await appSettings.setFlag(PRUNE_FLAG, true);
    const review = await makeUser({
      isReviewAccount: true,
      autoJoinFeaturedRaces: true,
    });

    const pending = await prisma.race.create({
      data: {
        seedId: dailySeed.id,
        name: "Daily",
        targetSteps: 0,
        status: "PENDING",
        isPublic: true,
        timeBased: true,
        maxParticipants: 100,
        maxDurationDays: 1,
        createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
        scheduledStartAt: new Date(Date.now() - 60 * 1000),
        endsAt: new Date(Date.now() + 23 * 60 * 60 * 1000),
      },
    });

    const { enrollAutoJoinUsers } = buildAutoJoinFeaturedRaces({ prisma });
    await enrollAutoJoinUsers({ id: pending.id, maxParticipants: 100 });
    assert.deepEqual(await participantUserIds(pending.id), [review.userId]);

    await buildRenewSeededRaces({ prisma })();
    assert.deepEqual(
      await participantUserIds(pending.id),
      [review.userId],
      "review account survives promotion"
    );
  });

  it("12: a pruned user can re-join the seeded race immediately", async () => {
    await appSettings.setFlag(PRUNE_FLAG, true);
    const ghost = await makeUser();
    const race = await prisma.race.create({
      data: {
        seedId: dailySeed.id,
        name: "Daily",
        targetSteps: 0,
        status: "PENDING",
        isPublic: true,
        timeBased: true,
        maxParticipants: 100,
        maxDurationDays: 1,
        fundedPrize: true,
        createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
        scheduledStartAt: new Date(Date.now() - 60 * 1000),
        endsAt: new Date(Date.now() + 23 * 60 * 60 * 1000),
      },
    });
    await prisma.raceParticipant.create({
      data: { raceId: race.id, userId: ghost.userId, status: "ACCEPTED" },
    });

    await buildRenewSeededRaces({ prisma })();
    assert.deepEqual(await participantUserIds(race.id), []);

    const join = await req("POST", `/races/${race.id}/join`, {
      token: ghost.token,
    });
    assert.ok(join.status < 400, `join status ${join.status}`);
    const row = await prisma.raceParticipant.findFirst({
      where: { raceId: race.id, userId: ghost.userId },
    });
    assert.ok(row, "row recreated");
    assert.equal(row.status, "ACCEPTED");
    assert.equal(await coinsSpent(ghost.userId), 0);
  });

  it("13: signup auto-enroll only targets cohort-compatible seeded races", async () => {
    await appSettings.setFlag(PRUNE_FLAG, true);
    await appSettings.setFlag(CURVE_FLAG, true);

    const active = await prisma.race.create({
      data: {
        seedId: dailySeed.id,
        name: "Daily",
        targetSteps: 0,
        status: "ACTIVE",
        isPublic: true,
        timeBased: true,
        maxParticipants: 100,
        maxDurationDays: 1,
        startedAt: new Date(Date.now() - 60 * 60 * 1000),
        endsAt: new Date(Date.now() + 23 * 60 * 60 * 1000),
      },
    });
    const pending = await prisma.race.create({
      data: {
        seedId: weeklySeed.id,
        name: "Weekly",
        targetSteps: 0,
        status: "PENDING",
        isPublic: true,
        timeBased: true,
        maxParticipants: 100,
        maxDurationDays: 7,
        scheduledStartAt: new Date(Date.now() + 60 * 60 * 1000),
        endsAt: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000),
      },
    });

    // A brand-new account with no step data at all — exactly the signup case.
    const fresh = await makeUser({ createdAt: new Date() });
    await autoEnrollNewUser({
      user: await prisma.user.findUnique({ where: { id: fresh.userId } }),
    });

    // This is a legacy/global active race, not a private finalized cohort.
    assert.deepEqual(await participantUserIds(active.id), []);
    assert.deepEqual(await participantUserIds(pending.id), [fresh.userId]);
    const row = await prisma.user.findUnique({ where: { id: fresh.userId } });
    assert.equal(row.autoJoinFeaturedRaces, true);
  });

  it("13b: signup auto-enroll joins the current private bucket cohort", async () => {
    const legacyActive = await prisma.race.create({
      data: {
        seedId: dailySeed.id,
        name: "Daily field",
        targetSteps: 0,
        status: "ACTIVE",
        isPublic: true,
        timeBased: true,
        maxParticipants: 100,
        maxDurationDays: 1,
        startedAt: new Date(Date.now() - 60 * 60 * 1000),
        endsAt: new Date(Date.now() + 23 * 60 * 60 * 1000),
      },
    });
    // A finalized private bucket: a brand-new signup must still be able to
    // enter the currently running Daily challenge during onboarding.
    const bucketActive = await prisma.race.create({
      data: {
        seedId: dailySeed.id,
        name: "Daily cohort",
        targetSteps: 0,
        status: "ACTIVE",
        isPublic: false,
        seededBucketId: require("node:crypto").randomUUID(),
        timeBased: true,
        maxParticipants: 15,
        maxDurationDays: 1,
        startedAt: new Date(Date.now() - 60 * 60 * 1000),
        endsAt: new Date(Date.now() + 23 * 60 * 60 * 1000),
      },
    });

    const fresh = await makeUser({ createdAt: new Date() });
    await autoEnrollNewUser({
      user: await prisma.user.findUnique({ where: { id: fresh.userId } }),
    });

    assert.deepEqual(await participantUserIds(legacyActive.id), []);
    assert.deepEqual(await participantUserIds(bucketActive.id), [fresh.userId]);
  });

  it("13c: signup auto-enroll chooses one race per Daily/Weekly cadence", async () => {
    const newerDaily = await prisma.race.create({
      data: {
        seedId: dailySeed.id,
        name: "Newer Daily cohort",
        targetSteps: 0,
        status: "ACTIVE",
        isPublic: false,
        seededBucketId: require("node:crypto").randomUUID(),
        timeBased: true,
        maxParticipants: 15,
        maxDurationDays: 1,
        startedAt: new Date(Date.now() - 30 * 60 * 1000),
        endsAt: new Date(Date.now() + 23 * 60 * 60 * 1000),
      },
    });
    const olderDaily = await prisma.race.create({
      data: {
        seedId: dailySeed.id,
        name: "Older Daily cohort",
        targetSteps: 0,
        status: "ACTIVE",
        isPublic: false,
        seededBucketId: require("node:crypto").randomUUID(),
        timeBased: true,
        maxParticipants: 15,
        maxDurationDays: 1,
        startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        endsAt: new Date(Date.now() + 22 * 60 * 60 * 1000),
      },
    });
    const fresh = await makeUser({ createdAt: new Date() });
    await autoEnrollNewUser({
      user: await prisma.user.findUnique({ where: { id: fresh.userId } }),
    });

    assert.deepEqual(await participantUserIds(newerDaily.id), [fresh.userId]);
    assert.deepEqual(await participantUserIds(olderDaily.id), []);
  });

  it("14: a user whose only activity is a future-dated daily row is never pruned", async () => {
    await appSettings.setFlag(PRUNE_FLAG, true);
    // tz-ahead client keying its total to local date D+1.
    const ahead = await makeUser();
    await dailyRow(ahead.userId, dayKeyOffset(1), 7000);
    // and one keying to D (today in ET), also outside the D-2..D-1 window.
    const today = await makeUser();
    await dailyRow(today.userId, dayKeyOffset(0), 7000);
    const ghost = await makeUser();
    await dailyRow(ghost.userId, dayKeyOffset(-5), 7000);

    const race = await prisma.race.create({
      data: {
        seedId: dailySeed.id,
        name: "Daily",
        targetSteps: 0,
        status: "PENDING",
        isPublic: true,
        timeBased: true,
        maxParticipants: 100,
        maxDurationDays: 1,
        createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
        scheduledStartAt: new Date(Date.now() - 60 * 1000),
        endsAt: new Date(Date.now() + 23 * 60 * 60 * 1000),
      },
    });
    for (const user of [ahead, today, ghost]) {
      await prisma.raceParticipant.create({
        data: { raceId: race.id, userId: user.userId, status: "ACCEPTED" },
      });
    }

    await buildRenewSeededRaces({ prisma })();
    assert.deepEqual(
      await participantUserIds(race.id),
      [ahead.userId, today.userId].sort(),
      "only the stale-row ghost is pruned"
    );
  });

  it("15: the weekly sweep removes ghosts once per ET day and spares everyone else", async () => {
    await appSettings.setFlag(PRUNE_FLAG, true);
    const d1 = dayKeyOffset(-1);

    const weekStart = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const weekly = await prisma.race.create({
      data: {
        seedId: weeklySeed.id,
        name: "Weekly",
        targetSteps: 0,
        status: "ACTIVE",
        isPublic: true,
        timeBased: true,
        maxParticipants: 100,
        maxDurationDays: 7,
        createdAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000),
        startedAt: weekStart,
        endsAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
      },
    });
    const daily = await prisma.race.create({
      data: {
        seedId: dailySeed.id,
        name: "Daily",
        targetSteps: 0,
        status: "ACTIVE",
        isPublic: true,
        timeBased: true,
        maxParticipants: 100,
        maxDurationDays: 1,
        createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        startedAt: new Date(Date.now() - 60 * 60 * 1000),
        endsAt: new Date(Date.now() + 23 * 60 * 60 * 1000),
      },
    });

    const ghost = await makeUser();
    const earlyWalker = await makeUser();
    const powerupHolder = await makeUser();
    const effectTarget = await makeUser();
    const recentWalker = await makeUser();
    await walkOn(recentWalker.userId, d1);
    const dailyGhost = await makeUser();

    async function joinRace(raceId, userId, totalSteps = 0) {
      return prisma.raceParticipant.create({
        data: { raceId, userId, status: "ACCEPTED", totalSteps },
      });
    }

    const ghostRow = await joinRace(weekly.id, ghost.userId);
    const earlyRow = await joinRace(weekly.id, earlyWalker.userId, 12000);
    const holderRow = await joinRace(weekly.id, powerupHolder.userId);
    const targetRow = await joinRace(weekly.id, effectTarget.userId);
    await joinRace(weekly.id, recentWalker.userId);
    await joinRace(daily.id, dailyGhost.userId);

    // The holder bought a powerup; the target is under someone's effect. Both
    // are skipped so no cascade can rewrite another racer's scoring mid-race.
    const heldPowerup = await prisma.racePowerup.create({
      data: {
        raceId: weekly.id,
        participantId: holderRow.id,
        userId: powerupHolder.userId,
        type: "TRAIL_MIX",
        status: "HELD",
      },
    });
    const casterPowerup = await prisma.racePowerup.create({
      data: {
        raceId: weekly.id,
        participantId: earlyRow.id,
        userId: earlyWalker.userId,
        type: "LEG_CRAMP",
        status: "USED",
      },
    });
    await prisma.raceActiveEffect.create({
      data: {
        raceId: weekly.id,
        targetParticipantId: targetRow.id,
        targetUserId: effectTarget.userId,
        sourceUserId: earlyWalker.userId,
        powerupId: casterPowerup.id,
        type: "LEG_CRAMP",
        startsAt: new Date(Date.now() - 60 * 60 * 1000),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    void heldPowerup;
    void ghostRow;

    // Fire the tick at 10:00 ET, past the 03:00 sweep hour.
    const sweepAt = new Date(etDayStart(dayKeyOffset(0)).getTime() + 10 * 3600 * 1000);
    const renew = buildRenewSeededRaces({ prisma, now: () => sweepAt });
    await renew();

    assert.deepEqual(
      await participantUserIds(weekly.id),
      [
        earlyWalker.userId,
        powerupHolder.userId,
        effectTarget.userId,
        recentWalker.userId,
      ].sort(),
      "only the pure ghost is swept"
    );
    assert.deepEqual(
      await participantUserIds(daily.id),
      [dailyGhost.userId],
      "the daily is never mid-race swept"
    );

    // claimRun makes it once per ET day: a second tick the same day is a no-op.
    await joinRace(weekly.id, ghost.userId);
    await renew();
    assert.ok(
      (await participantUserIds(weekly.id)).includes(ghost.userId),
      "second tick the same ET day does not sweep again"
    );
  });

  // ── Feature C — auto-enroll flip for ghosts (batch 2026-08-10 item 1) ─────
  //
  // Rule: inactive-by-steps (the existing predicate) AND zero MYSTERY_BOX_OPENED
  // events since the window start => users.auto_join_featured_races is set false,
  // so the renewal cron stops re-enrolling a dead account into every new race.

  it("16: promotion prune ALSO flips auto-enroll off for a boxless ghost", async () => {
    await appSettings.setFlag(PRUNE_FLAG, true);
    await appSettings.setFlag(AUTO_OFF_FLAG, true);

    const ghost = await makeUser({ autoJoinFeaturedRaces: true });
    const race = await duePendingDaily();
    await prisma.raceParticipant.create({
      data: { raceId: race.id, userId: ghost.userId, status: "ACCEPTED" },
    });

    await buildRenewSeededRaces({ prisma })();

    assert.deepEqual(await participantUserIds(race.id), [], "ghost pruned");
    assert.equal(
      await autoJoinFlagOf(ghost.userId),
      false,
      "auto-enroll flipped off so the cron stops re-enrolling them"
    );
  });

  it("16a: promotion prune cannot mutate membership outside the race C0 fence", async () => {
    await appSettings.setFlag(PRUNE_FLAG, true);
    const ghost = await makeUser({ autoJoinFeaturedRaces: true });
    const race = await duePendingDaily();
    await prisma.raceParticipant.create({
      data: { raceId: race.id, userId: ghost.userId, status: "ACCEPTED" },
    });

    let releaseFence;
    let markFence;
    const fenced = new Promise((resolve) => { markFence = resolve; });
    const release = new Promise((resolve) => { releaseFence = resolve; });
    const holder = prisma.$transaction(async (tx) => {
      await RaceResolutionJobV2.acquireForWrite(tx, { raceId: race.id });
      markFence();
      await release;
    }, { timeout: 15_000 });
    await fenced;
    const renewal = buildRenewSeededRaces({
      prisma,
      logger: { log() {}, error() {} },
    })();
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(
        await prisma.raceParticipant.count({
          where: { raceId: race.id, userId: ghost.userId, status: "ACCEPTED" },
        }),
        1,
        "prune waits behind C0 before deleting or declining membership",
      );
    } finally {
      releaseFence();
      await holder;
    }
    await renewal;
    assert.equal(
      await prisma.raceParticipant.count({ where: { raceId: race.id, userId: ghost.userId } }),
      0,
    );
  });

  it("16b: the enrollment filter flips the flag too (the steady-state path)", async () => {
    await appSettings.setFlag(PRUNE_FLAG, true);
    await appSettings.setFlag(AUTO_OFF_FLAG, true);

    const ghost = await makeUser({ autoJoinFeaturedRaces: true });
    const walker = await makeUser({ autoJoinFeaturedRaces: true });
    await walkOn(walker.userId, dayKeyOffset(-1));

    const race = await duePendingDaily({
      scheduledStartAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const { enrollAutoJoinUsers } = buildAutoJoinFeaturedRaces({ prisma });
    await enrollAutoJoinUsers({ id: race.id, maxParticipants: 100 });

    assert.deepEqual(
      await participantUserIds(race.id),
      [walker.userId],
      "ghost is filtered out of enrollment"
    );
    assert.equal(await autoJoinFlagOf(ghost.userId), false, "ghost flipped off");
    assert.equal(
      await autoJoinFlagOf(walker.userId),
      true,
      "an active user's preference is never touched"
    );
  });

  it("17: a ghost who opened a box INSIDE the window keeps auto-enroll on", async () => {
    await appSettings.setFlag(PRUNE_FLAG, true);
    await appSettings.setFlag(AUTO_OFF_FLAG, true);

    const opener = await makeUser({ autoJoinFeaturedRaces: true });
    const race = await duePendingDaily();
    await prisma.raceParticipant.create({
      data: { raceId: race.id, userId: opener.userId, status: "ACCEPTED" },
    });
    await boxEvent(opener.userId, race.id, etNoon(-1));

    await buildRenewSeededRaces({ prisma })();

    assert.deepEqual(
      await participantUserIds(race.id),
      [],
      "the steps-only prune still removes them from the race"
    );
    assert.equal(
      await autoJoinFlagOf(opener.userId),
      true,
      "still engaged with the game loop (maybe HealthKit is broken) — flag stays on"
    );
  });

  it("18: a box opened BEFORE the window does not protect the flag", async () => {
    await appSettings.setFlag(PRUNE_FLAG, true);
    await appSettings.setFlag(AUTO_OFF_FLAG, true);

    const ghost = await makeUser({ autoJoinFeaturedRaces: true });
    const race = await duePendingDaily();
    await prisma.raceParticipant.create({
      data: { raceId: race.id, userId: ghost.userId, status: "ACCEPTED" },
    });
    await boxEvent(ghost.userId, race.id, etNoon(-5));

    await buildRenewSeededRaces({ prisma })();

    assert.equal(await autoJoinFlagOf(ghost.userId), false);
  });

  it("18b: a box opened TODAY protects the flag (no upper bound, deliberately)", async () => {
    await appSettings.setFlag(PRUNE_FLAG, true);
    await appSettings.setFlag(AUTO_OFF_FLAG, true);

    const opener = await makeUser({ autoJoinFeaturedRaces: true });
    const race = await duePendingDaily();
    await prisma.raceParticipant.create({
      data: { raceId: race.id, userId: opener.userId, status: "ACCEPTED" },
    });
    // Right now: after the two-day steps window has already closed.
    await boxEvent(opener.userId, race.id, new Date());

    await buildRenewSeededRaces({ prisma })();

    assert.equal(
      await autoJoinFlagOf(opener.userId),
      true,
      "someone who opened a box an hour ago is engaged"
    );
  });

  it("19: with the auto-enroll sub-switch OFF the prune runs but no flag is touched", async () => {
    await appSettings.setFlag(PRUNE_FLAG, true);
    await appSettings.setFlag(AUTO_OFF_FLAG, false);

    const ghost = await makeUser({ autoJoinFeaturedRaces: true });
    const race = await duePendingDaily();
    await prisma.raceParticipant.create({
      data: { raceId: race.id, userId: ghost.userId, status: "ACCEPTED" },
    });

    await buildRenewSeededRaces({ prisma })();

    assert.deepEqual(await participantUserIds(race.id), [], "prune still runs");
    assert.equal(
      await autoJoinFlagOf(ghost.userId),
      true,
      "default-off setting means zero behavior change at deploy time"
    );
  });

  it("20: the weekly mid-race sweep flips the flag under the same rule", async () => {
    await appSettings.setFlag(PRUNE_FLAG, true);
    await appSettings.setFlag(AUTO_OFF_FLAG, true);

    const weekly = await prisma.race.create({
      data: {
        seedId: weeklySeed.id,
        name: "Weekly",
        targetSteps: 0,
        status: "ACTIVE",
        isPublic: true,
        timeBased: true,
        maxParticipants: 100,
        maxDurationDays: 7,
        createdAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000),
        startedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        endsAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
      },
    });

    const ghost = await makeUser({ autoJoinFeaturedRaces: true });
    const opener = await makeUser({ autoJoinFeaturedRaces: true });
    for (const user of [ghost, opener]) {
      await prisma.raceParticipant.create({
        data: { raceId: weekly.id, userId: user.userId, status: "ACCEPTED" },
      });
    }
    await boxEvent(opener.userId, weekly.id, etNoon(-1));

    const sweepAt = new Date(etDayStart(dayKeyOffset(0)).getTime() + 10 * 3600 * 1000);
    await buildRenewSeededRaces({ prisma, now: () => sweepAt })();

    assert.equal(await autoJoinFlagOf(ghost.userId), false, "swept ghost flipped");
    assert.equal(
      await autoJoinFlagOf(opener.userId),
      true,
      "box opener keeps auto-enroll even though the sweep removed them"
    );
  });

  it("21: review accounts and brand-new accounts never lose auto-enroll", async () => {
    await appSettings.setFlag(PRUNE_FLAG, true);
    await appSettings.setFlag(AUTO_OFF_FLAG, true);

    const review = await makeUser({
      isReviewAccount: true,
      autoJoinFeaturedRaces: true,
    });
    const fresh = await makeUser({
      createdAt: new Date(),
      autoJoinFeaturedRaces: true,
    });

    const race = await duePendingDaily();
    for (const user of [review, fresh]) {
      await prisma.raceParticipant.create({
        data: { raceId: race.id, userId: user.userId, status: "ACCEPTED" },
      });
    }

    await buildRenewSeededRaces({ prisma })();

    assert.equal(await autoJoinFlagOf(review.userId), true);
    assert.equal(await autoJoinFlagOf(fresh.userId), true);
  });

  it("22: the flip is idempotent — an already-off ghost is never re-written", async () => {
    await appSettings.setFlag(PRUNE_FLAG, true);
    await appSettings.setFlag(AUTO_OFF_FLAG, true);

    const ghostOn = await makeUser({ autoJoinFeaturedRaces: true });
    const ghostOff = await makeUser({ autoJoinFeaturedRaces: false });
    const race = await duePendingDaily();
    for (const user of [ghostOn, ghostOff]) {
      await prisma.raceParticipant.create({
        data: { raceId: race.id, userId: user.userId, status: "ACCEPTED" },
      });
    }

    const logs = [];
    const logger = { log: (...a) => logs.push(a.join(" ")), error() {}, warn() {} };
    await buildRenewSeededRaces({ prisma, logger })();

    const flipLogs = logs.filter((line) => /auto-enroll/i.test(line));
    assert.equal(flipLogs.length, 1, "one flip batch logged");
    assert.match(flipLogs[0], /1 /, "exactly one user in the batch");
    assert.equal(await autoJoinFlagOf(ghostOn.userId), false);
    assert.equal(await autoJoinFlagOf(ghostOff.userId), false);

    // Second cron pass over the same users: the `autoJoinFeaturedRaces: true`
    // guard makes the write a no-op, so nothing is logged at all.
    await prisma.race.update({
      where: { id: race.id },
      data: { status: "PENDING", startedAt: null },
    });
    for (const user of [ghostOn, ghostOff]) {
      await prisma.raceParticipant.create({
        data: { raceId: race.id, userId: user.userId, status: "ACCEPTED" },
      });
    }
    logs.length = 0;
    await buildRenewSeededRaces({ prisma, logger })();
    assert.equal(
      logs.filter((line) => /auto-enroll/i.test(line)).length,
      0,
      "second pass writes nothing (updateMany guard)"
    );
  });

  it("23: a reroll event is not a box open and does not protect the flag", async () => {
    await appSettings.setFlag(PRUNE_FLAG, true);
    await appSettings.setFlag(AUTO_OFF_FLAG, true);

    const rerollOnly = await makeUser({ autoJoinFeaturedRaces: true });
    const race = await duePendingDaily();
    await prisma.raceParticipant.create({
      data: { raceId: race.id, userId: rerollOnly.userId, status: "ACCEPTED" },
    });
    await boxEvent(rerollOnly.userId, race.id, etNoon(-1), "MYSTERY_BOX_REROLLED");

    await buildRenewSeededRaces({ prisma })();

    assert.equal(
      await autoJoinFlagOf(rerollOnly.userId),
      false,
      "only MYSTERY_BOX_OPENED counts as engagement"
    );
  });
});

// Mint a session token for an existing user id (details reads are
// participant-gated, so test 2 needs the participant's own token).
async function tokenFor(userId) {
  const {
    signSessionToken,
  } = require("../../src/modules/users/services/sessionToken");
  const user = await prisma.user.findUnique({ where: { id: userId } });
  return signSessionToken({ userId: user.id, appleId: user.appleId });
}

async function coinsSpent(userId) {
  const rows = await prisma.coinTransaction.findMany({ where: { userId } });
  return rows.reduce((sum, t) => sum + Math.abs(t.amount), 0);
}
