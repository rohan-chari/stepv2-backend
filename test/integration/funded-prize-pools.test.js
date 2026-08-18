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
const { completeRace } = require("../../src/modules/races/commands/completeRace");
const {
  buildRenewSeededRaces,
} = require("../../src/modules/races/jobs/seededRaceRenewal");

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
      coinUnit: 20,
      maxCoins: 16000,
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

    // The pool grows with the field: 2 players x 3 days x 20 = 80.
    const detail = await req("GET", `/races/${race.id}`, { token: joiner.token });
    const body = await detail.json();
    assert.equal(body.prizePool.coins, 80);
    assert.equal(body.prizePool.playerCount, 2);
    assert.equal(body.projectedPotCoins, 80, "frozen builds read the pool as POT");
    assert.deepEqual(body.payoutTiers, [{ placement: 1, amount: 80 }]);
    assert.deepEqual(body.payouts, { first: 80, second: 0, third: 0 });
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
    assert.equal(summary.prizePool.coins, 160, "2 x 7 days (4 points) x 20");
    assert.equal(summary.prizePool.durationPoints, 4);
    assert.equal(summary.buyInAmount, 0);
    assert.equal(summary.potCoins, 0);
    assert.equal(summary.projectedPotCoins, 160);
    assert.equal(summary.finishReward, null);
    assert.equal(summary.myBuyInStatus, "NONE");

    const third = await makeUser();
    const publicRes = await req("GET", "/races/public", { token: third.token });
    const publicBody = await publicRes.json();
    const card = (publicBody.races || publicBody).find((r) => r.id === race.id);
    assert.ok(card, "race present in the public browser");
    assert.equal(card.prizePool.coins, 160);
    assert.equal(card.buyInAmount, 0);
    assert.equal(card.projectedPotCoins, 160);

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
    assert.equal(previewRace.prizePool.coins, 160);
  });
});
