const assert = require("node:assert/strict");
const { describe, it, before, beforeEach, after } = require("node:test");

const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const { appSettings } = require("../../src/shared/config/appSettings");
const { completeRace } = require("../../src/modules/races/commands/completeRace");

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
  });

  after(async () => {
    await appSettings.setFlag(FLAG, false);
  });

  // ── 14. the bracket fixtures ─────────────────────────────────────────────

  const FIXTURES = [
    { bracketSize: 4, matchupDurationDays: 2, totalDays: 4, pool: 320, atMax: false },
    { bracketSize: 8, matchupDurationDays: 2, totalDays: 6, pool: 640, atMax: false },
    { bracketSize: 16, matchupDurationDays: 3, totalDays: 12, pool: 1000, atMax: true },
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
        coinUnit: 20,
        maxCoins: 1000,
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
