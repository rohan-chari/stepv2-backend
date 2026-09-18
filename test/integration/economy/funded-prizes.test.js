// Canonical lean integration suite.


// ---- consolidated from funded-prize-pools.test.js ----
(function funded_prize_pools_test_js(){
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach, after } = require("node:test");

const {
  cleanDatabase,
  prisma,
  request,
  getSharedServer,
  createTestUser,
} = require("../setup");

const { appSettings } = require("../../../src/shared/config/appSettings");
const { resolveExpiredRaces } = require("../../../src/modules/races/jobs/raceExpiry");
const { completeRace } = require("../../../src/modules/races/commands/completeRace");
const {
  buildRenewSeededRaces,
} = require("../../../src/modules/races/jobs/seededRaceRenewal");

// App-funded prize pools (spec §9, backend tests 1-13). Money-in assertions run
// through real HTTP; every pool figure is proved by running a race to real
// settlement (resolveExpiredRaces / completeRace) and reading the coin ledger.

const FLAG = "fundedPrizePoolsEnabled";
const POOL_REASON = "race_prize_pool_payout";
const POT_REASON = "race_buy_in_payout";
const FINISH_REASON = "race_finish_reward";

let server;
let seq = 0;

async function makeUser({ coins = 0 } = {}) {
  const { user, token } = await createTestUser({
    appleId: `apple-funded-${++seq}`,
    email: `funded-${seq}@example.com`,
    coins,
  });
  return { userId: user.id, token };
}

function req(method, path, { body, token } = {}) {
  return request(server.baseUrl, method, path, { body, token });
}

async function coinsOf(userId) {
  return (await prisma.user.findUnique({ where: { id: userId } })).coins;
}

async function txns(raceId, reason) {
  return prisma.coinTransaction.findMany({
    where: { reason, refId: { startsWith: `${raceId}:` } },
  });
}

async function amountsByPlacement(raceId) {
  const rows = await prisma.raceParticipant.findMany({
    where: { raceId },
    orderBy: { placement: "asc" },
  });
  return rows
    .filter((p) => p.placement != null)
    .map((p) => ({ placement: p.placement, payoutCoins: p.payoutCoins }));
}

// An ACTIVE, already-expired race row. `funded` decides which money model it
// settles under — exactly what the production column does.
async function seedRace({
  funded = true,
  durationDays = 1,
  preset = "WINNER_TAKES_ALL",
  seedId = null,
  potCoins = 0,
  buyInAmount = 0,
  isTeamRace = false,
  teamSize = null,
  expired = true,
  creatorId = null,
}) {
  const startedAt = new Date(Date.now() - durationDays * 24 * 60 * 60 * 1000);
  return prisma.race.create({
    data: {
      creatorId,
      seedId,
      name: "Funded Race",
      targetSteps: 0,
      status: "ACTIVE",
      isPublic: true,
      timeBased: true,
      maxParticipants: null,
      maxDurationDays: durationDays,
      payoutPreset: preset,
      fundedPrize: funded,
      potCoins,
      buyInAmount,
      isTeamRace,
      teamSize,
      startedAt,
      endsAt: expired
        ? new Date(Date.now() - 60 * 60 * 1000)
        : new Date(Date.now() + 60 * 60 * 1000),
    },
    select: { id: true, startedAt: true },
  });
}

// `walkers`: number of participants that actually walked (distinct descending
// steps, frozen via finishedAt so settlement keeps them). `noShows`: ACCEPTED
// participants with zero steps — they must not inflate the settled pool.
async function addField(race, { walkers, noShows = 0, teams = null, buyIn = null }) {
  const users = [];
  for (let i = 0; i < walkers; i++) {
    const u = await makeUser();
    users.push(u);
    await prisma.raceParticipant.create({
      data: {
        raceId: race.id,
        userId: u.userId,
        status: "ACCEPTED",
        totalSteps: 100000 - i * 100,
        finishedAt: new Date(Date.now() - 30 * 60 * 1000),
        finishTotalSteps: 100000 - i * 100,
        joinedAt: race.startedAt,
        team: teams ? teams[i] : null,
        ...(buyIn
          ? { buyInAmount: buyIn, buyInStatus: "COMMITTED" }
          : {}),
      },
    });
  }
  const noShowUsers = [];
  for (let i = 0; i < noShows; i++) {
    const u = await makeUser();
    noShowUsers.push(u);
    await prisma.raceParticipant.create({
      data: {
        raceId: race.id,
        userId: u.userId,
        status: "ACCEPTED",
        totalSteps: 0,
        joinedAt: race.startedAt,
        team: teams ? teams[walkers + i] : null,
      },
    });
  }
  return { users, noShowUsers };
}

describe("app-funded prize pools — races", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    seq = 0;
    await appSettings.setFlag(FLAG, true);
    await appSettings.setFlag("payoutRoundingV1Enabled", true);
  });

  after(async () => {
    await appSettings.setFlag(FLAG, false);
    await appSettings.setFlag("payoutRoundingV1Enabled", true);
  });

  // ── 1. create is free, and a frozen client's buy-in is ignored (never 400) ──

  it("1: POST /races with buyInAmount:100 from a 0-coin user creates a free funded race", async () => {
    const creator = await makeUser({ coins: 0 });
    const res = await req("POST", "/races", {
      token: creator.token,
      body: {
        name: "Free Race",
        maxDurationDays: 3,
        buyInAmount: 100,
        isPublic: true,
        maxParticipants: 10,
      },
    });
    assert.equal(res.status, 201);
    const { race } = await res.json();
    assert.equal(race.buyInAmount, 0, "buy-in coerced to 0");

    const row = await prisma.race.findUnique({ where: { id: race.id } });
    assert.equal(row.fundedPrize, true);
    assert.equal(row.buyInAmount, 0);
    assert.equal(row.potCoins, 0);
    assert.equal(await coinsOf(creator.userId), 0, "nothing charged");
    assert.equal(
      await prisma.coinTransaction.count({ where: { userId: creator.userId } }),
      0
    );

    // The creator's own participant row holds no buy-in either.
    const me = await prisma.raceParticipant.findFirst({
      where: { raceId: race.id, userId: creator.userId },
    });
    assert.equal(me.buyInAmount, 0);
    assert.equal(me.buyInStatus, "NONE");

    // ...and an off-band amount a frozen client could send (below the old
    // 10-coin minimum) must also be accepted, not rejected.
    const res2 = await req("POST", "/races", {
      token: creator.token,
      body: { name: "Odd Buyin", maxDurationDays: 3, buyInAmount: 5 },
    });
    assert.equal(res2.status, 201);
    const { race: race2 } = await res2.json();
    assert.equal(race2.buyInAmount, 0);
  });

  it("stamps v1 only at creation, and the payout-rounding kill switch stamps later funded rows v0", async () => {
    const creator = await makeUser({ coins: 0 });
    const first = await req("POST", "/races", {
      token: creator.token,
      body: { name: "v1 stamp", maxDurationDays: 3, isPublic: true },
    });
    assert.equal(first.status, 201);
    const { race: firstRace } = await first.json();
    assert.equal(firstRace.payoutRoundingVersion, 1);
    assert.equal(
      (await prisma.race.findUnique({ where: { id: firstRace.id } })).payoutRoundingVersion,
      1
    );
    const firstDetail = await req("GET", `/races/${firstRace.id}`, { token: creator.token });
    assert.equal(firstDetail.status, 200);
    assert.equal((await firstDetail.json()).payoutRoundingVersion, 1);
    const firstList = await req("GET", "/races", { token: creator.token });
    assert.equal(firstList.status, 200);
    assert.equal(
      (await firstList.json()).pending.find((row) => row.id == firstRace.id)?.payoutRoundingVersion,
      1
    );

    await appSettings.setFlag("payoutRoundingV1Enabled", false);
    const second = await req("POST", "/races", {
      token: creator.token,
      body: { name: "v0 stamp", maxDurationDays: 3, isPublic: true },
    });
    assert.equal(second.status, 201);
    const { race: secondRace } = await second.json();
    assert.equal(secondRace.payoutRoundingVersion, 0);
    assert.equal(
      (await prisma.race.findUnique({ where: { id: secondRace.id } })).payoutRoundingVersion,
      0
    );
    assert.equal(
      (await prisma.race.findUnique({ where: { id: firstRace.id } })).payoutRoundingVersion,
      1,
      "kill switch never reinterprets an existing row"
    );
  });

  it("1b: the create response and GET /races/:id carry the projected prizePool", async () => {
    const creator = await makeUser();
    const res = await req("POST", "/races", {
      token: creator.token,
      body: { name: "Pool Preview", maxDurationDays: 3, isPublic: true },
    });
    const { race } = await res.json();

    const detail = await req("GET", `/races/${race.id}`, { token: creator.token });
    assert.equal(detail.status, 200);
    const body = await detail.json();
    // A single accepted player mints nothing yet, but the shape is present.
    assert.deepEqual(body.prizePool, {
      coins: 0,
      projected: true,
      atMax: false,
      playerCount: 1,
      durationDays: 3,
      durationPoints: 2,
      coinUnit: 10,
      maxCoins: 8000,
      funded: true,
    });
    assert.equal(body.buyInAmount, 0);
    assert.equal(body.potCoins, 0);
    assert.equal(body.heldPotCoins, 0);
    assert.equal(body.finishReward, null);
  });

  // ── 2. joining is free ─────────────────────────────────────────────────────

  it("2: POST /races/:id/join with 0 coins moves no coins and never 400s", async () => {
    const creator = await makeUser();
    const created = await req("POST", "/races", {
      token: creator.token,
      body: { name: "Public Free", maxDurationDays: 3, isPublic: true },
    });
    const { race } = await created.json();

    const joiner = await makeUser({ coins: 0 });
    const join = await req("POST", `/races/${race.id}/join`, { token: joiner.token });
    assert.ok(join.status === 200 || join.status === 201, `join status ${join.status}`);
    assert.equal(await coinsOf(joiner.userId), 0);
    assert.equal(
      await prisma.coinTransaction.count({ where: { userId: joiner.userId } }),
      0
    );

    // The v2 pool grows with the field: 2 players x 2 duration points x 10 = 40.
    const detail = await req("GET", `/races/${race.id}`, { token: joiner.token });
    const body = await detail.json();
    assert.equal(body.prizePool.coins, 40);
    assert.equal(body.prizePool.playerCount, 2);
    assert.equal(body.projectedPotCoins, 40, "frozen builds read the pool as POT");
    assert.deepEqual(body.payoutTiers, [{ placement: 1, amount: 40 }]);
    assert.deepEqual(body.payouts, { first: 40, second: 0, third: 0 });
  });

  it("2b: invite accept is free too", async () => {
    const creator = await makeUser();
    const created = await req("POST", "/races", {
      token: creator.token,
      body: { name: "Invite Race", maxDurationDays: 1 },
    });
    const { race } = await created.json();
    const friend = await makeUser({ coins: 0 });

    // Friendship so the invite is allowed.
    await prisma.friendship.create({
      data: {
        requesterId: creator.userId,
        addresseeId: friend.userId,
        status: "ACCEPTED",
      },
    });
    const invite = await req("POST", `/races/${race.id}/invite`, {
      token: creator.token,
      body: { inviteeIds: [friend.userId] },
    });
    assert.ok(invite.status < 400, `invite status ${invite.status}`);

    const accept = await req("PUT", `/races/${race.id}/respond`, {
      token: friend.token,
      body: { accept: true },
    });
    assert.equal(accept.status, 200);
    const accepted = await accept.json();
    assert.equal(accepted.participant.buyInAmount, 0);
    assert.equal(accepted.participant.buyInStatus, "NONE");
    assert.equal(await coinsOf(friend.userId), 0);
    assert.equal(
      await prisma.coinTransaction.count({ where: { userId: friend.userId } }),
      0
    );
  });

  // ── 3. the owner fixtures, through real settlement ──────────────────────────

  const FIXTURES = [
    { players: 4, durationDays: 3, pool: 160 },
    { players: 20, durationDays: 14, pool: 3200 },
    { players: 2, durationDays: 1, pool: 40 },
    { players: 10, durationDays: 7, pool: 800 },
  ];

  for (const fixture of FIXTURES) {
    it(`3: ${fixture.players} players / ${fixture.durationDays} days settles a ${fixture.pool}-coin pool`, async () => {
      const race = await seedRace({ durationDays: fixture.durationDays });
      const { users } = await addField(race, { walkers: fixture.players });

      await resolveExpiredRaces();

      const settled = await prisma.race.findUnique({ where: { id: race.id } });
      assert.equal(settled.status, "COMPLETED");
      assert.equal(settled.prizePoolCoins, fixture.pool, "settled pool stamped");
      assert.equal(settled.potCoins, fixture.pool, "potCoins carries the settled pool");

      const rows = await txns(race.id, POOL_REASON);
      assert.equal(
        rows.reduce((s, t) => s + t.amount, 0),
        fixture.pool,
        "minted exactly the pool"
      );
      // WINNER_TAKES_ALL: the top stepper takes it all.
      assert.equal(await coinsOf(users[0].userId), fixture.pool);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].refId, `${race.id}:1`);
      for (const u of users.slice(1)) assert.equal(await coinsOf(u.userId), 0);
      // No buy-in pot money and no retired finish reward.
      assert.equal((await txns(race.id, POT_REASON)).length, 0);
      assert.equal((await txns(race.id, FINISH_REASON)).length, 0);
    });
  }

  // ── 4. all four presets, even splits, exact pool (D1 + D2) ─────────────────

  const PRESET_CASES = [
    // field 4, 1 day -> pool 80
    { field: 4, preset: "WINNER_TAKES_ALL", expected: [80] },
    { field: 4, preset: "TOP3_70_20_10", expected: [56, 16, 8] },
    { field: 4, preset: "TOP_HALF", expected: [40, 40] },
    { field: 4, preset: "ALL_BUT_LAST", expected: [28, 26, 26] },
    // field 20, 1 day -> pool 400
    { field: 20, preset: "WINNER_TAKES_ALL", expected: [400] },
    { field: 20, preset: "TOP3_70_20_10", expected: [280, 80, 40] },
    { field: 20, preset: "TOP_HALF", expected: Array(10).fill(40) },
    {
      field: 20,
      preset: "ALL_BUT_LAST",
      expected: [22, ...Array(18).fill(21)],
    },
  ];

  for (const testCase of PRESET_CASES) {
    it(`4: ${testCase.preset} over a field of ${testCase.field} splits the pool exactly`, async () => {
      const race = await seedRace({
        durationDays: 1,
        preset: testCase.preset,
        expired: false,
      });
      const { users } = await addField(race, { walkers: testCase.field });

      // The API's projected payoutTiers...
      const detail = await req("GET", `/races/${race.id}`, {
        token: users[0].token,
      });
      const body = await detail.json();
      assert.deepEqual(
        body.payoutTiers.map((t) => t.amount),
        testCase.expected,
        "projected payoutTiers"
      );
      assert.equal(
        body.payoutTiers.reduce((s, t) => s + t.amount, 0),
        body.prizePool.coins,
        "tiers sum to the advertised pool"
      );
      assert.deepEqual(body.payouts, {
        first: testCase.expected[0] || 0,
        second: testCase.expected[1] || 0,
        third: testCase.expected[2] || 0,
      });

      // ...match what settlement actually pays.
      await prisma.race.update({
        where: { id: race.id },
        data: { endsAt: new Date(Date.now() - 60 * 1000) },
      });
      await resolveExpiredRaces();

      const paid = (await amountsByPlacement(race.id))
        .filter((p) => p.payoutCoins > 0)
        .map((p) => p.payoutCoins);
      assert.deepEqual(paid, testCase.expected, "settled payouts");
      const minted = (await txns(race.id, POOL_REASON)).reduce(
        (s, t) => s + t.amount,
        0
      );
      assert.equal(minted, testCase.expected.reduce((s, a) => s + a, 0));
    });
  }

  // ── 5. projected vs settled, and immutability after completion ─────────────

  it("5: no-shows count toward the projection but not the settled pool", async () => {
    const race = await seedRace({ durationDays: 1, expired: false });
    const { users } = await addField(race, { walkers: 4, noShows: 2 });

    const detail = await req("GET", `/races/${race.id}`, { token: users[0].token });
    const body = await detail.json();
    assert.equal(body.prizePool.playerCount, 6, "projection counts all accepted");
    assert.equal(body.prizePool.coins, 120, "6 x 1 x 20");
    assert.equal(body.prizePool.projected, true);

    await prisma.race.update({
      where: { id: race.id },
      data: { endsAt: new Date(Date.now() - 60 * 1000) },
    });
    await resolveExpiredRaces();

    const settled = await prisma.race.findUnique({ where: { id: race.id } });
    assert.equal(settled.prizePoolCoins, 80, "4 walkers x 1 x 20");
    assert.equal(await coinsOf(users[0].userId), 80);

    const after = await req("GET", `/races/${race.id}`, { token: users[0].token });
    const afterBody = await after.json();
    assert.equal(afterBody.prizePool.coins, 80);
    assert.equal(afterBody.prizePool.projected, false);
    assert.equal(afterBody.prizePool.playerCount, 4);
    assert.equal(afterBody.potCoins, 80);

    // A completed race's numbers must not drift when the field changes.
    const latecomer = await makeUser();
    await prisma.raceParticipant.create({
      data: {
        raceId: race.id,
        userId: latecomer.userId,
        status: "ACCEPTED",
        totalSteps: 999999,
      },
    });
    const reread = await req("GET", `/races/${race.id}`, { token: users[0].token });
    const rereadBody = await reread.json();
    assert.equal(rereadBody.prizePool.coins, 80, "stamped pool is immutable");
    assert.deepEqual(
      rereadBody.payoutTiers.map((t) => t.amount),
      afterBody.payoutTiers.map((t) => t.amount)
    );
  });

  // ── 6. the two money models never overlap ─────────────────────────────────

  it("6a: a legacy buy-in race settles from its pot only — no funded mint", async () => {
    const race = await seedRace({
      funded: false,
      durationDays: 3,
      potCoins: 200,
      buyInAmount: 50,
    });
    const { users } = await addField(race, { walkers: 4, buyIn: 50 });

    await resolveExpiredRaces();

    assert.equal((await txns(race.id, POOL_REASON)).length, 0, "no funded mint");
    const potRows = await txns(race.id, POT_REASON);
    assert.equal(potRows.reduce((s, t) => s + t.amount, 0), 200);
    assert.equal(await coinsOf(users[0].userId), 200);
    const settled = await prisma.race.findUnique({ where: { id: race.id } });
    assert.equal(settled.prizePoolCoins, 0, "legacy races stamp nothing");
    assert.equal(settled.fundedPrize, false);
  });

  it("6b: a funded race mints the pool only — no pot payout row", async () => {
    const race = await seedRace({ durationDays: 3 });
    await addField(race, { walkers: 4 });
    await resolveExpiredRaces();
    assert.equal((await txns(race.id, POT_REASON)).length, 0);
    assert.equal((await txns(race.id, POOL_REASON)).length, 1);
  });

  it("6c: a funded seeded race mints no race_finish_reward and serializes finishReward null", async () => {
    const race = await seedRace({
      durationDays: 1,
      preset: "TOP_HALF",
      seedId: "seed-daily-10k",
      expired: false,
    });
    const { users } = await addField(race, { walkers: 10 });

    const detail = await req("GET", `/races/${race.id}`, { token: users[0].token });
    const body = await detail.json();
    assert.equal(body.finishReward, null, "retired as a pool source");
    assert.equal(body.prizePool.coins, 200);

    await prisma.race.update({
      where: { id: race.id },
      data: { endsAt: new Date(Date.now() - 60 * 1000) },
    });
    await resolveExpiredRaces();

    assert.equal((await txns(race.id, FINISH_REASON)).length, 0);
    const pool = await txns(race.id, POOL_REASON);
    assert.equal(pool.reduce((s, t) => s + t.amount, 0), 200);
    // TOP_HALF of 10 -> 5 even shares of 40.
    assert.deepEqual(
      pool.map((t) => t.amount).sort((a, b) => b - a),
      Array(5).fill(40)
    );
  });

  // ── 7. idempotency ────────────────────────────────────────────────────────

  it("7: replaying settlement mints the pool exactly once", async () => {
    const race = await seedRace({ durationDays: 3, preset: "TOP_HALF" });
    const { users } = await addField(race, { walkers: 4 });

    await resolveExpiredRaces();
    const before = await Promise.all(users.map((u) => coinsOf(u.userId)));
    const rowsBefore = (await txns(race.id, POOL_REASON)).length;
    assert.ok(rowsBefore > 0);

    // Both replay routes: the cron sweep and a direct settlement call.
    await resolveExpiredRaces();
    const second = await completeRace({
      raceId: race.id,
      winnerUserId: users[0].userId,
      participantUserIds: users.map((u) => u.userId),
    });
    assert.equal(second, null, "already COMPLETED");

    assert.deepEqual(
      await Promise.all(users.map((u) => coinsOf(u.userId))),
      before
    );
    assert.equal((await txns(race.id, POOL_REASON)).length, rowsBefore);
    const settled = await prisma.race.findUnique({ where: { id: race.id } });
    assert.equal(settled.prizePoolCoins, 160);
  });

  // ── 8. in-flight legacy money still drains correctly ──────────────────────

  it("8: an ACTIVE pre-flip buy-in race cancelled after the flip refunds everyone", async () => {
    await appSettings.setFlag(FLAG, false);
    const creator = await makeUser({ coins: 500 });
    const created = await req("POST", "/races", {
      token: creator.token,
      body: {
        name: "Paid Race",
        maxDurationDays: 3,
        buyInAmount: 50,
        isPublic: true,
      },
    });
    assert.equal(created.status, 201);
    const { race } = await created.json();
    assert.equal(race.buyInAmount, 50);

    const joiner = await makeUser({ coins: 500 });
    await req("POST", `/races/${race.id}/join`, { token: joiner.token });
    assert.equal(await coinsOf(creator.userId), 450);
    assert.equal(await coinsOf(joiner.userId), 450);

    const started = await req("POST", `/races/${race.id}/start`, {
      token: creator.token,
    });
    assert.equal(started.status, 200);
    let row = await prisma.race.findUnique({ where: { id: race.id } });
    assert.equal(row.potCoins, 100);
    assert.equal(row.fundedPrize, false);

    // The flag flips ON mid-race — the in-flight race must be untouched.
    await appSettings.setFlag(FLAG, true);

    const cancelled = await req("DELETE", `/races/${race.id}`, {
      token: creator.token,
    });
    assert.ok(cancelled.status < 400, `cancel status ${cancelled.status}`);

    assert.equal(await coinsOf(creator.userId), 500, "creator refunded");
    assert.equal(await coinsOf(joiner.userId), 500, "joiner refunded");
    assert.equal((await txns(race.id, POOL_REASON)).length, 0, "no funded mint");
    row = await prisma.race.findUnique({ where: { id: race.id } });
    assert.equal(row.potCoins, 0);
    assert.equal(row.prizePoolCoins, 0);
  });

  it("8b: an ACTIVE pre-flip buy-in race that SETTLES after the flip still pays its pot", async () => {
    const race = await seedRace({
      funded: false,
      durationDays: 3,
      potCoins: 100,
      buyInAmount: 50,
      preset: "WINNER_TAKES_ALL",
    });
    const { users } = await addField(race, { walkers: 2, buyIn: 50 });
    await resolveExpiredRaces();

    assert.equal(await coinsOf(users[0].userId), 100, "pot paid, exactly as today");
    assert.equal((await txns(race.id, POOL_REASON)).length, 0);
  });

  // ── 9. kill switch OFF keeps today's behavior ─────────────────────────────

  it("9: with the flag OFF, POST /races still charges the buy-in", async () => {
    await appSettings.setFlag(FLAG, false);
    const creator = await makeUser({ coins: 100 });
    const res = await req("POST", "/races", {
      token: creator.token,
      body: { name: "Paid", maxDurationDays: 3, buyInAmount: 50 },
    });
    assert.equal(res.status, 201);
    const { race } = await res.json();
    assert.equal(race.buyInAmount, 50);
    assert.equal(await coinsOf(creator.userId), 50, "charged");

    const row = await prisma.race.findUnique({ where: { id: race.id } });
    assert.equal(row.fundedPrize, false);

    const detail = await req("GET", `/races/${race.id}`, { token: creator.token });
    const body = await detail.json();
    assert.equal(body.prizePool, null, "legacy races expose no prizePool");
    assert.equal(body.buyInAmount, 50);
    assert.equal(body.heldPotCoins, 50);
    assert.equal(body.projectedPotCoins, 50);
  });

  it("9b: a 0-coin user still cannot create a paid race while the flag is OFF", async () => {
    await appSettings.setFlag(FLAG, false);
    const broke = await makeUser({ coins: 0 });
    const res = await req("POST", "/races", {
      token: broke.token,
      body: { name: "Nope", maxDurationDays: 3, buyInAmount: 50 },
    });
    assert.equal(res.status, 400);
  });

  // ── 10. team races ───────────────────────────────────────────────────────

  it("10: the winning team's members split the funded pool evenly", async () => {
    const race = await seedRace({
      durationDays: 1,
      isTeamRace: true,
      teamSize: 2,
    });
    // TEAM_A takes the two highest step counts, so TEAM_A wins.
    const { users } = await addField(race, {
      walkers: 4,
      teams: ["TEAM_A", "TEAM_A", "TEAM_B", "TEAM_B"],
    });

    await resolveExpiredRaces();

    const settled = await prisma.race.findUnique({ where: { id: race.id } });
    assert.equal(settled.status, "COMPLETED");
    assert.equal(settled.winnerTeam, "TEAM_A");
    assert.equal(settled.prizePoolCoins, 80, "4 players x 1 day x 20");
    assert.equal(await coinsOf(users[0].userId), 40);
    assert.equal(await coinsOf(users[1].userId), 40);
    assert.equal(await coinsOf(users[2].userId), 0);
    assert.equal(await coinsOf(users[3].userId), 0);
    const rows = await txns(race.id, POOL_REASON);
    assert.equal(rows.reduce((s, t) => s + t.amount, 0), 80);
  });

  // Batch 2026-08-08 item 5 (decided by Rohan): a funded tie no longer pays
  // everyone 0. It mints the pool and splits it across both teams, and it now
  // STAMPS prizePoolCoins (the old branch never did, so a completed funded tie
  // read as pool 0 on every read path). There is still nothing to refund — a
  // funded race holds no buy-ins. Split arithmetic lives in
  // test/integration/team-pool-multiplier.test.js.
  it("10b: a tied funded team race mints the pool and splits it across both teams", async () => {
    const race = await seedRace({
      durationDays: 1,
      isTeamRace: true,
      teamSize: 1,
    });
    const a = await makeUser();
    const b = await makeUser();
    for (const [user, team] of [
      [a, "TEAM_A"],
      [b, "TEAM_B"],
    ]) {
      await prisma.raceParticipant.create({
        data: {
          raceId: race.id,
          userId: user.userId,
          status: "ACCEPTED",
          totalSteps: 5000,
          finishedAt: new Date(Date.now() - 30 * 60 * 1000),
          finishTotalSteps: 5000,
          joinedAt: race.startedAt,
          team,
        },
      });
    }

    await resolveExpiredRaces();

    const settled = await prisma.race.findUnique({ where: { id: race.id } });
    assert.equal(settled.status, "COMPLETED");
    assert.equal(settled.winnerTeam, null);
    // 2 players x durationPoints(1)=1 x 20 = 40, split evenly across both.
    assert.equal(settled.prizePoolCoins, 40);
    assert.equal(settled.potCoins, 40);
    assert.equal(await coinsOf(a.userId), 20);
    assert.equal(await coinsOf(b.userId), 20);
    const tieRows = await txns(race.id, POOL_REASON);
    assert.equal(tieRows.length, 2);
    assert.equal(tieRows.reduce((s, t) => s + t.amount, 0), 40);
    // Still nothing refunded — a funded race never held a buy-in.
    assert.equal(
      (await txns(race.id, "race_buy_in_refund")).length,
      0
    );
  });

  // ── 11. PATCH ignores buy-in fields on a funded race ─────────────────────

  it("11: PATCH /races/:id with buyInAmount:50 on a funded race moves no coins", async () => {
    const creator = await makeUser({ coins: 300 });
    const created = await req("POST", "/races", {
      token: creator.token,
      body: { name: "Editable", maxDurationDays: 3, isPublic: true },
    });
    const { race } = await created.json();

    const res = await req("PATCH", `/races/${race.id}`, {
      token: creator.token,
      body: { buyInAmount: 50, buyInEnabled: true, payoutPreset: "TOP_HALF" },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    const updated = body.race || body;
    assert.equal(updated.buyInAmount, 0);
    assert.equal(updated.payoutPreset, "TOP_HALF", "preset edits still apply");

    const row = await prisma.race.findUnique({ where: { id: race.id } });
    assert.equal(row.buyInAmount, 0);
    assert.equal(row.potCoins, 0);
    assert.equal(await coinsOf(creator.userId), 300);
    assert.equal(
      await prisma.coinTransaction.count({ where: { userId: creator.userId } }),
      0
    );
  });

  // ── 12. the cap ──────────────────────────────────────────────────────────

  it("12: a 100-player 14-day race reaches the 16,000 cap with atMax", async () => {
    const race = await seedRace({ durationDays: 14, expired: false });
    const viewer = await makeUser();
    await prisma.raceParticipant.create({
      data: {
        raceId: race.id,
        userId: viewer.userId,
        status: "ACCEPTED",
        joinedAt: race.startedAt,
      },
    });
    await prisma.user.createMany({
      data: Array.from({ length: 99 }, (_, i) => ({
        appleId: `apple-cap-${i}`,
        email: `cap-${i}@example.com`,
      })),
    });
    const filler = await prisma.user.findMany({
      where: { appleId: { startsWith: "apple-cap-" } },
      select: { id: true },
    });
    await prisma.raceParticipant.createMany({
      data: filler.map((u) => ({
        raceId: race.id,
        userId: u.id,
        status: "ACCEPTED",
        joinedAt: race.startedAt,
      })),
    });

    const detail = await req("GET", `/races/${race.id}`, { token: viewer.token });
    const body = await detail.json();
    assert.equal(body.prizePool.coins, 16000);
    assert.equal(body.prizePool.atMax, true);
    assert.equal(body.prizePool.playerCount, 100);
    assert.equal(body.prizePool.maxCoins, 16000);
    assert.equal(body.projectedPotCoins, 16000);
  });

  // ── 13. seeded races ────────────────────────────────────────────────────

  it("13: seededRaceRenewal creates funded TOP_HALF dailies", async () => {
    const renew = buildRenewSeededRaces({ prisma });
    await renew();

    const races = await prisma.race.findMany({
      where: { seedId: "seed-daily-10k" },
    });
    assert.ok(races.length >= 1);
    for (const race of races) {
      assert.equal(race.payoutPreset, "TOP_HALF", "D8");
      assert.equal(race.fundedPrize, true);
      assert.equal(race.buyInAmount, 0);
    }
  });

  it("13b: a 10-player funded daily settles 5 even shares", async () => {
    const race = await seedRace({ durationDays: 1, preset: "TOP_HALF" });
    const { users } = await addField(race, { walkers: 10 });
    await resolveExpiredRaces();

    const paid = (await amountsByPlacement(race.id))
      .filter((p) => p.payoutCoins > 0)
      .map((p) => p.payoutCoins);
    assert.deepEqual(paid, Array(5).fill(40));
    for (const u of users.slice(5)) assert.equal(await coinsOf(u.userId), 0);
  });

  // ── extra contract coverage: list + public + share endpoints ─────────────

  it("14: GET /races and GET /races/public carry the same prizePool block", async () => {
    const creator = await makeUser();
    const created = await req("POST", "/races", {
      token: creator.token,
      body: { name: "Listed", maxDurationDays: 7, isPublic: true },
    });
    const { race } = await created.json();
    const other = await makeUser();
    await req("POST", `/races/${race.id}/join`, { token: other.token });

    const list = await req("GET", "/races", { token: creator.token });
    const listBody = await list.json();
    const summary = [...listBody.pending, ...listBody.active].find(
      (r) => r.id === race.id
    );
    assert.ok(summary, "race present in the list");
    assert.equal(summary.prizePool.coins, 80, "2 x 7 days (4 points) x 10");
    assert.equal(summary.prizePool.durationPoints, 4);
    assert.equal(summary.buyInAmount, 0);
    assert.equal(summary.potCoins, 0);
    assert.equal(summary.projectedPotCoins, 80);
    assert.equal(summary.finishReward, null);
    assert.equal(summary.myBuyInStatus, "NONE");

    const third = await makeUser();
    const publicRes = await req("GET", "/races/public", { token: third.token });
    const publicBody = await publicRes.json();
    const card = (publicBody.races || publicBody).find((r) => r.id === race.id);
    assert.ok(card, "race present in the public browser");
    assert.equal(card.prizePool.coins, 80);
    assert.equal(card.buyInAmount, 0);
    assert.equal(card.projectedPotCoins, 80);

    // Share preview (unauthenticated) also exposes the pool.
    const linkRes = await req("POST", `/races/${race.id}/share-link`, {
      token: creator.token,
    });
    const linkBody = await linkRes.json();
    const token = linkBody.shareToken || linkBody.token || linkBody.race?.shareToken;
    assert.ok(token, "share token minted");
    const preview = await req("GET", `/races/share/${token}`);
    const previewBody = await preview.json();
    const previewRace = previewBody.race || previewBody;
    assert.equal(previewRace.buyInAmount, 0);
    assert.equal(previewRace.prizePool.coins, 80);
  });
});

})();


// ---- consolidated from funded-prize-pools-tournaments.test.js ----
(function funded_prize_pools_tournaments_test_js(){
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach, after } = require("node:test");

const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");
const { appSettings } = require("../../../src/shared/config/appSettings");
const { completeRace } = require("../../../src/modules/races/commands/completeRace");

// App-funded bracket pools (spec §9, backend tests 14-16). Brackets are created
// and filled through real HTTP, then every matchup is run to real settlement so
// the champion's coins come out of the production advancement path.

const FLAG = "fundedPrizePoolsEnabled";
const FEAT = "tournaments";
const POOL_REASON = "tournament_prize_pool_payout";
const POT_REASON = "tournament_payout";
const SEED_REASON = "tournament_champion_reward";

let server;
let seq = 0;

function authReq(method, path, { body, token } = {}) {
  return request(server.baseUrl, method, path, {
    body,
    token,
    headers: { "X-Client-Features": FEAT },
  });
}

async function createUser({ coins = 0 } = {}) {
  const appleId = `apple-fpt-${++seq}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  const token = body.sessionToken;
  const userId = body.user.id;
  if (coins) {
    await prisma.user.update({ where: { id: userId }, data: { coins } });
  }
  // Stamp the sticky tournaments feature.
  await authReq("GET", "/races", { token });
  return { userId, token };
}

async function coinsOf(userId) {
  return (await prisma.user.findUnique({ where: { id: userId } })).coins;
}

async function ledger(tournamentId, reason) {
  return prisma.coinTransaction.findMany({
    where: { reason, refId: { startsWith: `${tournamentId}:` } },
  });
}

// Create a bracket and fill it through HTTP joins. The final joiner pops the
// bracket into ACTIVE (pop-when-full), so no manual start is needed.
async function fillBracket({ bracketSize, matchupDurationDays, buyInAmount = 0, coins = 0 }) {
  const users = [];
  for (let i = 0; i < bracketSize; i++) users.push(await createUser({ coins }));

  const created = await authReq("POST", "/tournaments", {
    token: users[0].token,
    body: {
      name: `Cup ${bracketSize}`,
      bracketSize,
      matchupDurationDays,
      buyInAmount,
      isPublic: true,
    },
  });
  assert.equal(created.status, 201, `create status ${created.status}`);
  const { tournament } = await created.json();

  for (const user of users.slice(1)) {
    const join = await authReq("POST", `/tournaments/${tournament.id}/join`, {
      token: user.token,
    });
    assert.equal(join.status, 201, `join status ${join.status}`);
  }

  return { tournamentId: tournament.id, users, created: tournament };
}

// Settle every matchup of the current round until the bracket completes. The
// lower-index participant of each matchup always wins, so the champion is
// deterministic. Returns the champion userId.
async function runBracketToChampion(tournamentId) {
  for (let guard = 0; guard < 10; guard++) {
    const t = await prisma.tournament.findUnique({ where: { id: tournamentId } });
    if (t.status === "COMPLETED") return t.championUserId;
    const races = await prisma.race.findMany({
      where: { tournamentId, tournamentRound: t.currentRound, status: "ACTIVE" },
      include: { participants: { where: { status: "ACCEPTED" } } },
      orderBy: { tournamentMatchIndex: "asc" },
    });
    for (const race of races) {
      const [p0, p1] = race.participants;
      await prisma.raceParticipant.update({
        where: { id: p0.id },
        data: { totalSteps: 9000 },
      });
      if (p1) {
        await prisma.raceParticipant.update({
          where: { id: p1.id },
          data: { totalSteps: 1000 },
        });
      }
      await completeRace({
        raceId: race.id,
        winnerUserId: p0.userId,
        participantUserIds: race.participants.map((p) => p.userId),
      });
    }
  }
  throw new Error("bracket did not complete");
}

describe("app-funded prize pools — tournaments", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    seq = 0;
    await appSettings.setFlag("tournamentsEnabled", true);
    await appSettings.setFlag(FLAG, true);
    await appSettings.setFlag("payoutRoundingV1Enabled", true);
  });

  after(async () => {
    await appSettings.setFlag(FLAG, false);
    await appSettings.setFlag("payoutRoundingV1Enabled", true);
  });

  it("stamps public app-funded tournament rows v1 by default and v0 after the creation kill switch", async () => {
    const firstUser = await createUser();
    const first = await authReq("POST", "/tournaments", {
      token: firstUser.token,
      body: { name: "v1 cup", bracketSize: 4, matchupDurationDays: 1, isPublic: true },
    });
    assert.equal(first.status, 201);
    const { tournament: firstTournament } = await first.json();
    assert.equal(
      (await prisma.tournament.findUnique({ where: { id: firstTournament.id } })).payoutRoundingVersion,
      1
    );

    await appSettings.setFlag("payoutRoundingV1Enabled", false);
    const secondUser = await createUser();
    const second = await authReq("POST", "/tournaments", {
      token: secondUser.token,
      body: { name: "v0 cup", bracketSize: 4, matchupDurationDays: 1, isPublic: true },
    });
    assert.equal(second.status, 201);
    const { tournament: secondTournament } = await second.json();
    assert.equal(
      (await prisma.tournament.findUnique({ where: { id: secondTournament.id } })).payoutRoundingVersion,
      0
    );
  });

  // ── 14. the bracket fixtures ─────────────────────────────────────────────

  const FIXTURES = [
    { bracketSize: 4, matchupDurationDays: 2, totalDays: 4, pool: 160, atMax: false },
    { bracketSize: 8, matchupDurationDays: 2, totalDays: 6, pool: 320, atMax: false },
    { bracketSize: 16, matchupDurationDays: 3, totalDays: 12, pool: 500, atMax: true },
  ];

  for (const fixture of FIXTURES) {
    it(`14: a ${fixture.bracketSize}-bracket with ${fixture.matchupDurationDays}-day rounds pays ${fixture.pool} to the champion`, async () => {
      const { tournamentId, users } = await fillBracket({
        bracketSize: fixture.bracketSize,
        matchupDurationDays: fixture.matchupDurationDays,
      });

      // Nobody was charged to enter.
      for (const user of users) {
        assert.equal(await coinsOf(user.userId), 0);
        assert.equal(
          await prisma.coinTransaction.count({ where: { userId: user.userId } }),
          0
        );
      }

      const row = await prisma.tournament.findUnique({ where: { id: tournamentId } });
      assert.equal(row.fundedPrize, true);
      assert.equal(row.buyInAmount, 0);

      // Projection on GET /tournaments/:id before the champion is crowned.
      const detail = await authReq("GET", `/tournaments/${tournamentId}`, {
        token: users[0].token,
      });
      assert.equal(detail.status, 200);
      const body = await detail.json();
      const t = body.tournament || body;
      assert.deepEqual(t.prizePool, {
        coins: fixture.pool,
        projected: true,
        atMax: fixture.atMax,
        playerCount: fixture.bracketSize,
        durationDays: fixture.totalDays,
        durationPoints: fixture.totalDays >= 8 ? 8 : fixture.totalDays >= 4 ? 4 : 2,
        coinUnit: 10,
        maxCoins: 500,
        funded: true,
      });
      assert.equal(t.buyInAmount, 0);
      assert.equal(t.potCoins, fixture.pool, "frozen builds read the pool as potCoins");

      const champion = await runBracketToChampion(tournamentId);

      const settled = await prisma.tournament.findUnique({
        where: { id: tournamentId },
      });
      assert.equal(settled.status, "COMPLETED");
      assert.equal(settled.prizePoolCoins, fixture.pool);
      assert.equal(settled.potCoins, fixture.pool);
      assert.equal(await coinsOf(champion), fixture.pool);

      const rows = await ledger(tournamentId, POOL_REASON);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].amount, fixture.pool);
      assert.equal(rows[0].refId, `${tournamentId}:champion`);
      assert.equal((await ledger(tournamentId, POT_REASON)).length, 0);
      assert.equal((await ledger(tournamentId, SEED_REASON)).length, 0);

      // Everyone else still has nothing.
      for (const user of users.filter((u) => u.userId !== champion)) {
        assert.equal(await coinsOf(user.userId), 0);
      }

      const after = await authReq("GET", `/tournaments/${tournamentId}`, {
        token: users[0].token,
      });
      const afterBody = await after.json();
      const afterT = afterBody.tournament || afterBody;
      assert.equal(afterT.prizePool.coins, fixture.pool);
      assert.equal(afterT.prizePool.projected, false);
    });
  }

  it("14b: a frozen client's tournament buy-in is ignored, never rejected", async () => {
    const creator = await createUser({ coins: 0 });
    const res = await authReq("POST", "/tournaments", {
      token: creator.token,
      body: {
        name: "Ignored Buyin",
        bracketSize: 4,
        matchupDurationDays: 2,
        // 500 is above every legacy TOURNAMENT_BUYIN_MAX — a frozen client can
        // still create, because the field is coerced before validation.
        buyInAmount: 500,
        isPublic: true,
      },
    });
    assert.equal(res.status, 201);
    const { tournament } = await res.json();
    assert.equal(tournament.buyInAmount, 0);
    assert.equal(await coinsOf(creator.userId), 0);
  });

  // ── 15. a featured (seeded) bracket keeps its own minted prize ────────────

  it("15: a featured bracket mints seed.championPrizeCoins, not a funded pool", async () => {
    const seed = await prisma.tournamentSeed.create({
      data: {
        id: "seed-tournament-daily-dash",
        kind: "DAILY_DASH",
        name: "Daily Dash",
        bracketSize: 4,
        matchupDurationDays: 2,
        championPrizeCoins: 500,
        active: true,
      },
    });

    // A seeded bracket, ALSO marked fundedPrize, proves the branch ORDER: the
    // seed prize wins and the funded pool never fires.
    const tournament = await prisma.tournament.create({
      data: {
        creatorId: null,
        seedId: seed.id,
        name: seed.name,
        status: "PENDING",
        bracketSize: 4,
        matchupDurationDays: 2,
        buyInAmount: 0,
        potCoins: 0,
        fundedPrize: true,
        isPublic: true,
        currentRound: 0,
        totalRounds: 2,
      },
    });

    const users = [];
    for (let i = 0; i < 4; i++) users.push(await createUser());
    for (const user of users) {
      const join = await authReq("POST", `/tournaments/${tournament.id}/join`, {
        token: user.token,
      });
      assert.equal(join.status, 201, `join status ${join.status}`);
    }

    const champion = await runBracketToChampion(tournament.id);

    assert.equal(await coinsOf(champion), 500, "seed prize, not the 320 pool");
    const seedRows = await ledger(tournament.id, SEED_REASON);
    assert.equal(seedRows.length, 1);
    assert.equal(seedRows[0].amount, 500);
    assert.equal((await ledger(tournament.id, POOL_REASON)).length, 0);
    const settled = await prisma.tournament.findUnique({
      where: { id: tournament.id },
    });
    assert.equal(settled.prizePoolCoins, 0, "no funded pool stamped");
  });

  // ── 16. an in-flight paid bracket still pays its pot ─────────────────────

  it("16: a pre-flip paid bracket pays its pot to the champion after the flip", async () => {
    await appSettings.setFlag(FLAG, false);
    const { tournamentId, users } = await fillBracket({
      bracketSize: 4,
      matchupDurationDays: 2,
      buyInAmount: 50,
      coins: 500,
    });

    const row = await prisma.tournament.findUnique({ where: { id: tournamentId } });
    assert.equal(row.fundedPrize, false);
    assert.equal(row.buyInAmount, 50);
    assert.equal(row.potCoins, 200, "pot committed at start");
    for (const user of users) assert.equal(await coinsOf(user.userId), 450);

    // Flag flips ON mid-bracket; the in-flight bracket must be unaffected.
    await appSettings.setFlag(FLAG, true);

    const champion = await runBracketToChampion(tournamentId);

    assert.equal(await coinsOf(champion), 650, "450 + the 200 pot");
    const potRows = await ledger(tournamentId, POT_REASON);
    assert.equal(potRows.length, 1);
    assert.equal(potRows[0].amount, 200);
    assert.equal((await ledger(tournamentId, POOL_REASON)).length, 0, "no funded mint");
    const settled = await prisma.tournament.findUnique({
      where: { id: tournamentId },
    });
    assert.equal(settled.prizePoolCoins, 0);

    // A legacy paid bracket keeps exposing its buy-in and pot, and no prizePool.
    const detail = await authReq("GET", `/tournaments/${tournamentId}`, {
      token: users[0].token,
    });
    const body = await detail.json();
    const t = body.tournament || body;
    assert.equal(t.prizePool, null);
    assert.equal(t.buyInAmount, 50);
    assert.equal(t.potCoins, 200);
  });
});

})();


// ---- consolidated from payout-rounding-v1.test.js ----
(function payout_rounding_v1_test_js(){
const assert = require("node:assert/strict");
const { before, beforeEach, describe, it } = require("node:test");

const { cleanDatabase, createTestUser, getSharedServer, prisma, request } = require("../setup");
const {
  buildCompleteRace,
  completeRace,
} = require("../../../src/modules/races/commands/completeRace");
const { awardCoins } = require("../../../src/shared/economy/awardCoins");

let server;

describe("payout rounding v1 — real settlement and read contract", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(cleanDatabase);

  it("credits and serializes the per-recipient rounded funded split exactly once", async () => {
    const users = await Promise.all(Array.from({ length: 4 }, () => createTestUser()));
    const startedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const race = await prisma.race.create({
      data: {
        name: "Rounded split", targetSteps: 0, status: "ACTIVE", isPublic: true,
        timeBased: true, maxDurationDays: 1, startedAt,
        endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        fundedPrize: true, payoutRoundingVersion: 1,
        // 4 walkers yield raw pool 80, whose TOP3 split is 56/16/8.
        teamPoolMultBps: 2500, payoutPreset: "TOP3_70_20_10",
      },
    });
    for (const [index, entry] of users.entries()) {
      await prisma.raceParticipant.create({
        data: {
          raceId: race.id, userId: entry.user.id, status: "ACCEPTED",
          totalSteps: 10000 - index, placement: index + 1,
        },
      });
    }

    await completeRace({
      raceId: race.id,
      winnerUserId: users[0].user.id,
      participantUserIds: users.map(({ user }) => user.id),
    });
    // The completion call is safe to retry: no second ledger credits appear.
    await completeRace({
      raceId: race.id,
      winnerUserId: users[0].user.id,
      participantUserIds: users.map(({ user }) => user.id),
    });

    const participants = await prisma.raceParticipant.findMany({
      where: { raceId: race.id }, orderBy: { placement: "asc" },
    });
    assert.deepEqual(participants.map((row) => row.payoutCoins), [60, 20, 10, 0]);
    const credits = await prisma.coinTransaction.findMany({
      where: { reason: "race_prize_pool_payout", refId: { startsWith: `${race.id}:` } },
      orderBy: { refId: "asc" },
    });
    assert.deepEqual(credits.map((row) => row.amount).sort((a, b) => b - a), [60, 20, 10]);
    assert.equal(credits.length, 3);
    assert.deepEqual(credits[0].payoutMetadata, {
      recipientId: participants.find((row) => row.payoutCoins === credits[0].amount)?.id,
      placement: 1,
      rawAwardCoins: 56,
      awardCoins: 60,
      roundingSubsidyCoins: 4,
    });

    const detail = await request(server.baseUrl, "GET", `/races/${race.id}`, {
      token: users[0].token,
    });
    assert.equal(detail.status, 200);
    const body = await detail.json();
    assert.deepEqual(body.payoutTiers.map((row) => row.amount), [60, 20, 10]);
    assert.equal(body.projectedPotCoins, 90);
    assert.equal(body.prizePool.coins, 90);
  });

  it("reconciles a v1 credit that committed before participant/result persistence", async () => {
    const users = await Promise.all(Array.from({ length: 4 }, () => createTestUser()));
    const race = await prisma.race.create({
      data: {
        name: "Rounded recovery", targetSteps: 0, status: "ACTIVE", isPublic: true,
        timeBased: true, maxDurationDays: 1,
        startedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        fundedPrize: true, payoutRoundingVersion: 1,
        teamPoolMultBps: 2500, payoutPreset: "TOP3_70_20_10",
      },
    });
    for (const [index, entry] of users.entries()) {
      await prisma.raceParticipant.create({
        data: {
          raceId: race.id, userId: entry.user.id, status: "ACCEPTED",
          totalSteps: 10000 - index, placement: index + 1,
        },
      });
    }

    let crashAfterCredit = true;
    const crashesAfterFirstCommittedCredit = buildCompleteRace({
      awardCoins: async (input) => {
        const outcome = await awardCoins(input);
        if (crashAfterCredit && outcome.awarded) {
          crashAfterCredit = false;
          throw new Error("simulated crash after durable credit");
        }
        return outcome;
      },
    });
    await assert.rejects(
      crashesAfterFirstCommittedCredit({
        raceId: race.id,
        winnerUserId: users[0].user.id,
        participantUserIds: users.map(({ user }) => user.id),
      }),
      /simulated crash/
    );

    await completeRace({
      raceId: race.id,
      winnerUserId: users[0].user.id,
      participantUserIds: users.map(({ user }) => user.id),
    });

    const participants = await prisma.raceParticipant.findMany({
      where: { raceId: race.id }, orderBy: { placement: "asc" },
    });
    assert.deepEqual(participants.map((row) => row.payoutCoins), [60, 20, 10, 0]);
    const credits = await prisma.coinTransaction.findMany({
      where: { reason: "race_prize_pool_payout", refId: { startsWith: `${race.id}:` } },
    });
    assert.equal(credits.length, 3);
    const completed = await prisma.race.findUnique({ where: { id: race.id } });
    assert.equal(completed.prizePoolCoins, 90);
    assert.equal(completed.payoutRoundingMetadata.roundingSubsidyCoins, 10);
  });
});

})();


// ---- consolidated from feature-batch-2026-07-27.test.js ----
(function feature_batch_2026_07_27_test_js(){
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach, after } = require("node:test");

const {
  cleanDatabase,
  prisma,
  request,
  getSharedServer,
  createTestUser,
} = require("../setup");

const { appSettings } = require("../../../src/shared/config/appSettings");
const {
  buildRenewSeededRaces,
} = require("../../../src/modules/races/jobs/seededRaceRenewal");

// Feature batch 2026-07-27 — the backend half (spec §4, §8.1).
//
// Two config changes, no shape changes:
//   item 7  PRIZE_POOL_MAX_COINS 3200 -> 16000 (the exact max the formula can
//           produce at the legal field cap of 100: 100 x 8 points x 20 unit)
//   item 12 REFERRAL_REFERRER_COINS 1000 -> 500, and the two figures served on
//           the wire (additively) so copy never hardcodes an economy number.
//
// Plus item 9, which is a CHARACTERISATION test: seeded daily AND weekly
// challenges are already created TOP_HALF, so this must pass before and after.
//
// Every assertion is on the API response a client actually receives.

const FLAG = "fundedPrizePoolsEnabled";
const FEAT = "tournaments";

let server;
let seq = 0;

function req(method, path, { body, token, headers } = {}) {
  return request(server.baseUrl, method, path, { body, token, headers });
}

async function makeUser({ coins = 0 } = {}) {
  const { user, token } = await createTestUser({
    appleId: `apple-b0727-${++seq}`,
    email: `b0727-${seq}@example.com`,
    coins,
  });
  return { userId: user.id, token };
}

// Pad a race out to `total` ACCEPTED participants with real user rows, so the
// projection the endpoint computes is driven by a real field.
async function padField(raceId, total, startedAt) {
  const existing = await prisma.raceParticipant.count({ where: { raceId } });
  const needed = total - existing;
  if (needed <= 0) return;
  const tag = `apple-pad-${raceId}-`;
  await prisma.user.createMany({
    data: Array.from({ length: needed }, (_, i) => ({
      appleId: `${tag}${i}`,
      email: `pad-${raceId}-${i}@example.com`,
    })),
  });
  const padded = await prisma.user.findMany({
    where: { appleId: { startsWith: tag } },
    select: { id: true },
  });
  await prisma.raceParticipant.createMany({
    data: padded.map((u) => ({
      raceId,
      userId: u.id,
      status: "ACCEPTED",
      joinedAt: startedAt || new Date(),
    })),
  });
}

// A funded race created through the real endpoint, then padded to `players`.
async function createFundedRace({ players, maxDurationDays }) {
  const creator = await makeUser();
  const created = await req("POST", "/races", {
    token: creator.token,
    body: {
      name: "Pool Ceiling",
      maxDurationDays,
      isPublic: true,
      maxParticipants: 100,
    },
  });
  assert.equal(created.status, 201, `create status ${created.status}`);
  const { race } = await created.json();
  await padField(race.id, players);
  return { creator, raceId: race.id };
}

describe("feature batch 2026-07-27 — backend", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    seq = 0;
    await appSettings.setFlag(FLAG, true);
  });

  after(async () => {
    await appSettings.setFlag(FLAG, false);
  });

  // ── item 7: the prize-pool ceiling ────────────────────────────────────────

  it("7: a 100-player 14-day v2 race pays the full 8,000 and reports atMax", async () => {
    const { creator, raceId } = await createFundedRace({
      players: 100,
      maxDurationDays: 14,
    });

    const detail = await req("GET", `/races/${raceId}`, { token: creator.token });
    assert.equal(detail.status, 200);
    const body = await detail.json();

    assert.equal(body.prizePool.coins, 8000, "100 x 8 points x 10");
    assert.equal(body.prizePool.atMax, true, "8,000 is the v2 ceiling");
    assert.equal(body.prizePool.maxCoins, 8000);
    assert.equal(body.prizePool.playerCount, 100);
    assert.equal(body.prizePool.durationPoints, 8);
    assert.equal(body.prizePool.coinUnit, 10);
    // Frozen builds read the pool as the pot; it must carry the same figure.
    assert.equal(body.projectedPotCoins, 8000);
  });

  it("7: the duration band is flat above 7 days — 100 x 30 days is also 8,000", async () => {
    const { creator, raceId } = await createFundedRace({
      players: 100,
      maxDurationDays: 30,
    });

    const detail = await req("GET", `/races/${raceId}`, { token: creator.token });
    const body = await detail.json();
    assert.equal(body.prizePool.coins, 8000);
    assert.equal(body.prizePool.durationPoints, 8);
    assert.equal(body.prizePool.maxCoins, 8000);
    assert.equal(body.prizePool.atMax, true);
  });

  it("7: a small v2 field uses the permanent 10-coin unit", async () => {
    const { creator, raceId } = await createFundedRace({
      players: 4,
      maxDurationDays: 1,
    });

    const detail = await req("GET", `/races/${raceId}`, { token: creator.token });
    const body = await detail.json();
    assert.equal(body.prizePool.coins, 40, "4 x 1 point x 10");
    assert.equal(body.prizePool.atMax, false);
    assert.equal(body.prizePool.maxCoins, 8000);
  });

  it("7: tournaments keep their own tighter MAX_CHAMPION_PRIZE ceiling", async () => {
    // 16 players x (4 rounds x 3 days = 12 days -> 8 points) x 10 = 1,280, well
    // over the v2 MAX_CHAMPION_PRIZE, so the bracket clamps at 500 — proof
    // the race ceiling raise did not leak into the bracket path.
    const users = [];
    for (let i = 0; i < 16; i++) {
      const res = await request(server.baseUrl, "POST", "/auth/apple", {
        body: { identityToken: `apple-tourney-b0727-${i}` },
      });
      const body = await res.json();
      users.push({ token: body.sessionToken, userId: body.user.id });
      // Stamp the sticky tournaments feature for this client.
      await req("GET", "/races", {
        token: body.sessionToken,
        headers: { "X-Client-Features": FEAT },
      });
    }

    const created = await req("POST", "/tournaments", {
      token: users[0].token,
      headers: { "X-Client-Features": FEAT },
      body: {
        name: "Ceiling Cup",
        bracketSize: 16,
        matchupDurationDays: 3,
        buyInAmount: 0,
        isPublic: true,
      },
    });
    assert.equal(created.status, 201, `create status ${created.status}`);
    const { tournament } = await created.json();

    for (const user of users.slice(1)) {
      const join = await req("POST", `/tournaments/${tournament.id}/join`, {
        token: user.token,
        headers: { "X-Client-Features": FEAT },
      });
      assert.equal(join.status, 201, `join status ${join.status}`);
    }

    const detail = await req("GET", `/tournaments/${tournament.id}`, {
      token: users[0].token,
      headers: { "X-Client-Features": FEAT },
    });
    assert.equal(detail.status, 200);
    const body = await detail.json();
    const t = body.tournament || body;
    assert.equal(t.prizePool.maxCoins, 500, "v2 MAX_CHAMPION_PRIZE");
    assert.equal(t.prizePool.coins, 500, "still clamped to the bracket ceiling");
    assert.equal(t.prizePool.atMax, true);
  });

  // ── item 9: characterisation — seeded challenges already pay TOP_HALF ─────

  // NOTE: spec §8.1 says "floor(field/2)" tiers. The implementation pays
  // ceil(field/2) (`gradedSlotCount`, racePayoutPresets.js:60-62) — an odd field
  // of 9 pays 5, not 4. Characterised as the code actually behaves; the spec
  // wording is what is wrong, and the frontend's "Top N of M" copy must use ceil.
  it("9: seeded DAILY and WEEKLY challenges already come back TOP_HALF with ceil(field/2) tiers", async () => {
    const renew = buildRenewSeededRaces({ prisma });
    await renew();

    const seeds = await prisma.raceSeed.findMany({ where: { active: true } });
    // Prefer the production kinds; fall back to any seed of that cadence so the
    // test does not depend on which seed rows a given environment carries.
    const pick = (cadence, kind) =>
      seeds.find((s) => s.kind === kind) ||
      seeds.find((s) => s.cadence === cadence);
    const daily = pick("DAILY", "DAILY_10K");
    const weekly = pick("WEEKLY", "WEEKLY_50K");
    assert.ok(daily, "an active daily seed exists");
    assert.ok(weekly, "an active weekly seed exists");

    // `field` is the TOTAL accepted field, viewer included.
    for (const [label, seed, field] of [
      ["daily", daily, 10],
      ["weekly", weekly, 9],
    ]) {
      const race = await prisma.race.findFirst({
        where: { seedId: seed.id, status: "ACTIVE" },
        orderBy: { startedAt: "desc" },
      });
      assert.ok(race, `${label}: renewal created an ACTIVE race`);

      const viewer = await makeUser();
      await prisma.raceParticipant.create({
        data: {
          raceId: race.id,
          userId: viewer.userId,
          status: "ACCEPTED",
          joinedAt: race.startedAt,
        },
      });
      await padField(race.id, field, race.startedAt);

      const detail = await req("GET", `/races/${race.id}`, {
        token: viewer.token,
      });
      assert.equal(detail.status, 200, `${label}: detail status`);
      const body = await detail.json();

      assert.equal(
        body.payoutPreset,
        "TOP_HALF",
        `${label} challenge pays the top half`
      );
      assert.equal(
        body.payoutTiers.length,
        Math.ceil(field / 2),
        `${label}: ceil(field/2) paid places`
      );
      // TOP_HALF is an even split, so every tier carries the same amount.
      const amounts = body.payoutTiers.map((t) => t.amount);
      assert.equal(
        new Set(amounts).size,
        1,
        `${label}: even shares across the paid half`
      );
    }
  });

  // ── item 12: the referral figures on the wire ─────────────────────────────

  it("12: GET /referrals/me serves both referral coin figures at 500/500", async () => {
    const user = await makeUser();
    const res = await req("GET", "/referrals/me", { token: user.token });
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.referrerCoins, 500, "the sharer's reward (D6)");
    assert.equal(body.refereeCoins, 500, "the joiner's reward, unchanged");
    // Additive only — everything a frozen client already reads is still here.
    assert.ok(typeof body.code === "string" && body.code.length > 0);
    assert.ok(typeof body.url === "string");
    assert.equal(body.referredCount, 0);
    assert.equal(body.completedCount, 0);
    assert.equal(body.coinsEarned, 0);
    assert.deepEqual(body.friends, []);
  });

  it("12: the public referral preview serves both figures alongside the existing rewardCoins", async () => {
    const referrer = await makeUser();
    const link = await req("POST", "/referrals/link", { token: referrer.token });
    assert.equal(link.status, 200);
    const { code } = await link.json();

    const res = await req("GET", `/referrals/${code}`);
    assert.equal(res.status, 200);
    const { referral } = await res.json();

    assert.equal(referral.referrerCoins, 500);
    assert.equal(referral.refereeCoins, 500);
    // The pre-existing key an older client reads must be untouched.
    assert.equal(referral.rewardCoins, 500);
    assert.ok("inviterName" in referral);
    assert.ok("inviterRace" in referral);
  });
});

})();
