const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");

const {
  cleanDatabase,
  prisma,
  request,
  getSharedServer,
  createTestUser,
} = require("./setup");

const { resolveExpiredRaces } = require("../../src/jobs/raceExpiry");
const { completeRace } = require("../../src/commands/completeRace");
const {
  computeFinishRewardPool,
  computeFinishRewardPlaces,
} = require("../../src/constants/raceFinishReward");
const { computeGradedPayouts } = require("../../src/utils/racePayoutPresets");

// End-to-end coverage for the system-funded graded finish reward on the seeded
// daily/weekly challenges (commit "graded top-50% finish rewards"). Real DB
// inserts; the headline path drives the real settlement cron (resolveExpiredRaces)
// while the math-heavy field/eligibility cases call completeRace() directly.

const DAILY = "seed-daily-10k";
const WEEKLY = "seed-weekly-50k";
const REASON = "race_finish_reward";

let server;
let appleSeq = 0;

async function makeUser() {
  const { user, token } = await createTestUser({
    appleId: `apple-finish-reward-${++appleSeq}`,
    email: `finish-reward-${appleSeq}@example.com`,
  });
  return { userId: user.id, token };
}

async function seededActiveRace(seedId, { endsAt, startedHoursAgo = 3 } = {}) {
  const startedAt = new Date(Date.now() - startedHoursAgo * 60 * 60 * 1000);
  const race = await prisma.race.create({
    data: {
      seedId,
      creatorId: null,
      name: seedId === WEEKLY ? "Weekly 50K Challenge" : "Daily 10K Sprint",
      targetSteps: 0,
      isPublic: true,
      timeBased: true,
      timezone: "America/New_York",
      maxParticipants: 500,
      maxDurationDays: seedId === WEEKLY ? 7 : 1,
      status: "ACTIVE",
      startedAt,
      endsAt: endsAt || new Date(Date.now() + 60 * 60 * 1000),
      potCoins: 0,
    },
    select: { id: true, startedAt: true },
  });
  return race;
}

async function addParticipant(raceId, userId, overrides = {}) {
  return prisma.raceParticipant.create({
    data: {
      raceId,
      userId,
      status: overrides.status || "ACCEPTED",
      totalSteps: overrides.totalSteps ?? 0,
      placement: overrides.placement ?? null,
      finishedAt: overrides.finishedAt ?? null,
      finishTotalSteps: overrides.finishTotalSteps ?? null,
      joinedAt: overrides.joinedAt ?? new Date(),
    },
  });
}

async function coinsOf(userId) {
  return (await prisma.user.findUnique({ where: { id: userId } })).coins;
}

async function rewardTxns(userId) {
  return prisma.coinTransaction.findMany({
    where: { userId, reason: REASON },
    orderBy: { createdAt: "asc" },
  });
}

async function participantRow(raceId, userId) {
  return prisma.raceParticipant.findFirst({ where: { raceId, userId } });
}

// Build a seeded race, attach `walkers` (distinct step counts, ranked by steps),
// plus optional `noise` participants, then settle by calling completeRace()
// directly. Returns the participants ordered by placement (1..N) and the race id.
async function settleDirect(seedId, walkerSteps, noise = []) {
  const race = await seededActiveRace(seedId);
  const walkers = [];
  for (const steps of walkerSteps) {
    walkers.push({ ...(await makeUser()), steps });
  }
  // Placement is assigned by settlement in prod; for the direct-completeRace
  // path we set it ourselves (completeRace reads placement, it does not rank).
  const bySteps = [...walkers].sort((a, b) => b.steps - a.steps);
  for (let i = 0; i < bySteps.length; i++) {
    await addParticipant(race.id, bySteps[i].userId, {
      totalSteps: bySteps[i].steps,
      placement: i + 1,
    });
  }
  const noiseUsers = [];
  for (const n of noise) {
    const u = await makeUser();
    noiseUsers.push(u);
    await addParticipant(race.id, u.userId, {
      status: n.status,
      totalSteps: n.totalSteps ?? 0,
      placement: n.placement ?? null,
    });
  }
  const ids = [...walkers, ...noiseUsers].map((u) => u.userId);
  await completeRace({
    raceId: race.id,
    winnerUserId: bySteps[0].userId,
    participantUserIds: ids,
  });
  return { raceId: race.id, ranked: bySteps, noiseUsers };
}

describe("seeded race graded finish reward", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    appleSeq = 0;
  });

  // ---- A. pool sizing (field-scaled) ----

  it("A1: a tiny daily field mints the minPool floor (100), not perHead*N", async () => {
    const { raceId, ranked } = await settleDirect(DAILY, [900, 600, 300]);
    const minted = (
      await prisma.coinTransaction.findMany({ where: { reason: REASON, refId: { startsWith: `${raceId}:` } } })
    ).reduce((s, t) => s + t.amount, 0);
    assert.equal(computeFinishRewardPool(DAILY, 3), 100);
    assert.equal(minted, 100);
    // floor 100 across 3 places by descending weight: 51/33/16
    assert.deepEqual(
      await Promise.all(ranked.map((w) => coinsOf(w.userId))),
      [51, 33, 16]
    );
  });

  it("A2: a mid daily field mints exactly perHead*N (12*10=120)", async () => {
    const steps = Array.from({ length: 10 }, (_, i) => 1000 - i * 10);
    const { raceId } = await settleDirect(DAILY, steps);
    const minted = (
      await prisma.coinTransaction.findMany({ where: { reason: REASON, refId: { startsWith: `${raceId}:` } } })
    ).reduce((s, t) => s + t.amount, 0);
    assert.equal(computeFinishRewardPool(DAILY, 10), 120);
    assert.equal(minted, 120);
  });

  it("A3+B5cap: a huge daily field caps pool at 1200 and places at 10", async () => {
    const n = 101;
    const race = await seededActiveRace(DAILY);
    await prisma.user.createMany({
      data: Array.from({ length: n }, (_, i) => ({
        appleId: `apple-cap-${i}`,
        email: `cap-${i}@example.com`,
      })),
    });
    const users = await prisma.user.findMany({
      where: { appleId: { startsWith: "apple-cap-" } },
      select: { id: true },
    });
    await prisma.raceParticipant.createMany({
      data: users.map((u, i) => ({
        raceId: race.id,
        userId: u.id,
        status: "ACCEPTED",
        totalSteps: 100000 - i, // distinct, descending
        placement: i + 1,
      })),
    });
    await completeRace({
      raceId: race.id,
      winnerUserId: users[0].id,
      participantUserIds: users.map((u) => u.id),
    });

    assert.equal(computeFinishRewardPool(DAILY, n), 1200);
    assert.equal(computeFinishRewardPlaces(DAILY, n), 10);
    const txns = await prisma.coinTransaction.findMany({
      where: { reason: REASON, refId: { startsWith: `${race.id}:` } },
    });
    assert.equal(txns.length, 10);
    assert.equal(txns.reduce((s, t) => s + t.amount, 0), 1200);
  });

  it("A4: the weekly seed uses its own knobs (perHead 40, places scale)", async () => {
    const steps = Array.from({ length: 20 }, (_, i) => 5000 - i * 10);
    const { raceId } = await settleDirect(WEEKLY, steps);
    assert.equal(computeFinishRewardPool(WEEKLY, 20), 800); // 40*20
    assert.equal(computeFinishRewardPlaces(WEEKLY, 20), 4); // ceil(0.2*20)
    const txns = await prisma.coinTransaction.findMany({
      where: { reason: REASON, refId: { startsWith: `${raceId}:` } },
    });
    assert.equal(txns.length, 4);
    assert.deepEqual(
      txns.sort((a, b) => b.amount - a.amount).map((t) => t.amount),
      [320, 240, 160, 80]
    );
  });

  // ---- B. paid places (concentrated) ----

  it("B6: places never exceed the field (2 finishers -> 2 places, not 3)", async () => {
    const { raceId, ranked } = await settleDirect(DAILY, [800, 400]);
    assert.equal(computeFinishRewardPlaces(DAILY, 2), 2);
    const txns = await prisma.coinTransaction.findMany({
      where: { reason: REASON, refId: { startsWith: `${raceId}:` } },
    });
    assert.equal(txns.length, 2);
    // both finishers paid; nobody below the field
    for (const w of ranked) assert.ok((await coinsOf(w.userId)) > 0);
  });

  it("B7: finishers below the paid-places cutoff get zero coins and no ledger row", async () => {
    // 10-person daily pays 3 places (clamped to min); ranks 4..10 get nothing.
    const steps = Array.from({ length: 10 }, (_, i) => 1000 - i * 10);
    const { ranked } = await settleDirect(DAILY, steps);
    for (let i = 3; i < ranked.length; i++) {
      assert.equal(await coinsOf(ranked[i].userId), 0);
      assert.equal((await rewardTxns(ranked[i].userId)).length, 0);
    }
  });

  // ---- C. eligibility & field count ----

  it("C8+C9+C10: no-shows/declined are unrewarded AND excluded from field sizing", async () => {
    // 6 real walkers + 6 zero-step ACCEPTED + 2 DECLINED. If the field were sized
    // on accepted count (12) the pool would be 144; sized on walkers (6) it floors
    // to 100. Asserting 100 proves no-shows don't inflate the field.
    const walkerSteps = [600, 500, 400, 300, 200, 100];
    const noise = [
      ...Array.from({ length: 6 }, () => ({ status: "ACCEPTED", totalSteps: 0 })),
      { status: "DECLINED", totalSteps: 0 },
      { status: "DECLINED", totalSteps: 0 },
    ];
    const { raceId, ranked, noiseUsers } = await settleDirect(
      DAILY,
      walkerSteps,
      noise
    );

    assert.equal(computeFinishRewardPool(DAILY, 6), 100);
    const minted = (
      await prisma.coinTransaction.findMany({ where: { reason: REASON, refId: { startsWith: `${raceId}:` } } })
    ).reduce((s, t) => s + t.amount, 0);
    assert.equal(minted, 100); // field == walkers (6), not accepted (12)

    // top 3 walkers paid; remaining walkers + all noise unrewarded
    assert.deepEqual(
      await Promise.all(ranked.slice(0, 3).map((w) => coinsOf(w.userId))),
      [51, 33, 16]
    );
    for (const u of noiseUsers) assert.equal(await coinsOf(u.userId), 0);
  });

  // ---- D. graded split correctness ----

  it("D11+D12: payouts are strictly descending and sum to the pool exactly", async () => {
    const steps = Array.from({ length: 8 }, (_, i) => 2000 - i * 100);
    const { raceId } = await settleDirect(DAILY, steps);
    const pool = computeFinishRewardPool(DAILY, 8);
    const places = computeFinishRewardPlaces(DAILY, 8);
    const expected = computeGradedPayouts({ pool, count: places });

    const txns = await prisma.coinTransaction.findMany({
      where: { reason: REASON, refId: { startsWith: `${raceId}:` } },
    });
    const amounts = txns.map((t) => t.amount).sort((a, b) => b - a);
    assert.equal(amounts.reduce((s, a) => s + a, 0), pool);
    for (let i = 1; i < amounts.length; i++) {
      assert.ok(amounts[i - 1] > amounts[i], "strictly descending by rank");
    }
    assert.deepEqual(amounts, expected);
  });

  // ---- E. coin ledger & balances (headline, via the real cron) ----

  it("E14+E15+E16+D13: resolveExpiredRaces settles a daily and pays the graded reward end-to-end", async () => {
    const race = await seededActiveRace(DAILY, {
      endsAt: new Date(Date.now() - 60 * 60 * 1000), // already expired
      startedHoursAgo: 6,
    });
    const finishSteps = [9000, 7000, 5000, 3000];
    const users = [];
    for (const steps of finishSteps) {
      const u = await makeUser();
      users.push({ ...u, steps });
      await addParticipant(race.id, u.userId, {
        totalSteps: steps,
        finishedAt: new Date(Date.now() - 30 * 60 * 1000),
        finishTotalSteps: steps,
        joinedAt: race.startedAt,
      });
    }

    await resolveExpiredRaces();

    const settled = await prisma.race.findUnique({ where: { id: race.id } });
    assert.equal(settled.status, "COMPLETED");
    assert.equal(settled.winnerUserId, users[0].userId); // most steps

    // placement assigned by steps; pool 100 (floor) over 3 places => 51/33/16
    const expected = [51, 33, 16, 0];
    for (let i = 0; i < users.length; i++) {
      const u = users[i];
      const p = await participantRow(race.id, u.userId);
      assert.equal(p.placement, i + 1, "ranked by descending steps");
      assert.equal(await coinsOf(u.userId), expected[i], "balance credited");
      assert.equal(p.payoutCoins, expected[i], "payoutCoins audit matches");

      const txns = await rewardTxns(u.userId);
      if (expected[i] > 0) {
        assert.equal(txns.length, 1);
        assert.equal(txns[0].amount, expected[i]);
        assert.equal(txns[0].refId, `${race.id}:rank:${i + 1}`);
      } else {
        assert.equal(txns.length, 0);
      }
    }
  });

  // ---- F. idempotency & scope ----

  it("F17: settling the same race twice does not double-pay", async () => {
    const { raceId, ranked } = await settleDirect(DAILY, [900, 600, 300]);
    const before = await Promise.all(ranked.map((w) => coinsOf(w.userId)));
    const txnsBefore = await prisma.coinTransaction.count({
      where: { reason: REASON, refId: { startsWith: `${raceId}:` } },
    });

    // race is already COMPLETED; completeRace early-returns (updateIfActive=0)
    const second = await completeRace({
      raceId,
      winnerUserId: ranked[0].userId,
      participantUserIds: ranked.map((w) => w.userId),
    });
    assert.equal(second, null);

    assert.deepEqual(
      await Promise.all(ranked.map((w) => coinsOf(w.userId))),
      before
    );
    assert.equal(
      await prisma.coinTransaction.count({ where: { reason: REASON, refId: { startsWith: `${raceId}:` } } }),
      txnsBefore
    );
  });

  it("F18: a non-seeded race mints zero finish-reward coins", async () => {
    const creator = await makeUser();
    const race = await prisma.race.create({
      data: {
        creatorId: creator.userId,
        name: "User Race",
        targetSteps: 10000,
        isPublic: false,
        maxDurationDays: 7,
        status: "ACTIVE",
        startedAt: new Date(Date.now() - 60 * 60 * 1000),
        potCoins: 0,
      },
      select: { id: true },
    });
    const users = [creator];
    await addParticipant(race.id, creator.userId, {
      totalSteps: 9000,
      placement: 1,
    });
    for (const steps of [6000, 3000]) {
      const u = await makeUser();
      users.push(u);
      await addParticipant(race.id, u.userId, {
        totalSteps: steps,
        placement: users.length,
      });
    }
    await completeRace({
      raceId: race.id,
      winnerUserId: creator.userId,
      participantUserIds: users.map((u) => u.userId),
    });

    assert.equal(
      await prisma.coinTransaction.count({
        where: { reason: REASON, refId: { startsWith: `${race.id}:` } },
      }),
      0
    );
    for (const u of users) assert.equal(await coinsOf(u.userId), 0);
  });

  it("F19: a seeded race with no buy-in pot still pays the minted reward", async () => {
    const { raceId } = await settleDirect(DAILY, [900, 600, 300]);
    const race = await prisma.race.findUnique({ where: { id: raceId } });
    assert.equal(race.potCoins, 0); // no buy-in pot
    assert.ok(
      (await prisma.coinTransaction.count({
        where: { reason: REASON, refId: { startsWith: `${raceId}:` } },
      })) > 0,
      "minted reward fired despite empty pot"
    );
  });

  // ---- G. time-based behavior + reward exposure ----

  it("G20: a runner crossing 10k mid-race does NOT finish a time-based seeded race early", async () => {
    const race = await seededActiveRace(DAILY, {
      endsAt: new Date(Date.now() + 6 * 60 * 60 * 1000), // still open
    });
    const u = await makeUser();
    await addParticipant(race.id, u.userId, { joinedAt: race.startedAt });

    const now = new Date();
    const start = new Date(now.getTime() - 60 * 60 * 1000);
    const res = await request(server.baseUrl, "POST", "/steps/samples", {
      body: {
        samples: [
          {
            periodStart: start.toISOString(),
            periodEnd: now.toISOString(),
            steps: 12000,
          },
        ],
      },
      token: u.token,
    });
    assert.equal(res.status, 200);

    const after = await prisma.race.findUnique({ where: { id: race.id } });
    assert.equal(after.status, "ACTIVE", "time-based race stays active past 10k");
    const p = await participantRow(race.id, u.userId);
    assert.equal(p.finishedAt, null, "no early finish for a time-based race");
  });

  it("G21: race details expose finishReward {pool, paidPlaces} for the current field", async () => {
    const race = await seededActiveRace(DAILY);
    const viewer = await makeUser();
    await addParticipant(race.id, viewer.userId);
    for (let i = 0; i < 4; i++) {
      const u = await makeUser();
      await addParticipant(race.id, u.userId);
    }
    const acceptedCount = 5;

    const res = await request(server.baseUrl, "GET", `/races/${race.id}`, {
      token: viewer.token,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.finishReward, {
      pool: computeFinishRewardPool(DAILY, acceptedCount),
      paidPlaces: computeFinishRewardPlaces(DAILY, acceptedCount),
    });
  });
});
