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

// Item 5 (batch 2026-08-08) — team race payout buff.
//
// The pool formula is  players x durationPoints(days) x PRIZE_COIN_UNIT , and a
// TEAM race multiplies it by a per-duration-band factor STAMPED on the row at
// creation (races.team_pool_mult_bps, basis points; NULL == 1.0). Every figure
// below is proved through the real expiry path (resolveExpiredRaces ->
// completeRace) and read back off the coin ledger, and every projection is read
// off real HTTP, so a projection can never disagree with a settlement.
//
// Arithmetic, stated once (durationPoints: <=1d 1, <=3d 2, <=7d 4, >=8d 8):
//   14d 5v5 : 10 x 8 x 20 = 1600 ; x1.875 = 3000 ; / 5 winners = 600 each
//    7d 5v5 : 10 x 4 x 20 =  800 ; x1.5   = 1200 ; / 5 winners = 240 each
//    3d 2v2 :  4 x 2 x 20 =  160 ; x1.0   =  160 ; / 2 winners =  80 each

const FUNDED_FLAG = "fundedPrizePoolsEnabled";
const POOL_REASON = "race_prize_pool_payout";
const REFUND_REASON = "race_buy_in_refund";
const TEAM_HEADERS = { "X-Client-Features": "characters,team_races" };

let server;
let seq = 0;

async function makeUser({ coins = 0 } = {}) {
  const { user, token } = await createTestUser({
    appleId: `apple-tpm-${++seq}`,
    email: `tpm-${seq}@example.com`,
    coins,
  });
  return { userId: user.id, token };
}

function req(method, path, { body, token, headers } = {}) {
  return request(server.baseUrl, method, path, { body, token, headers });
}

async function coinsOf(userId) {
  return (await prisma.user.findUnique({ where: { id: userId } })).coins;
}

async function txns(raceId, reason) {
  return prisma.coinTransaction.findMany({
    where: { reason, refId: { startsWith: `${raceId}:` } },
  });
}

// Run `fn` with env overrides applied, restoring the previous values after.
async function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// An ACTIVE team race row, optionally already past its deadline. `multBps` is
// written directly so a test can pin the stamp (including NULL = legacy row)
// without depending on what the env said at creation time.
async function seedTeamRace({
  durationDays,
  multBps,
  funded = true,
  expired = true,
  teamSize = 5,
  payoutRoundingVersion = 0,
  potCoins = 0,
  buyInAmount = 0,
}) {
  return prisma.race.create({
    data: {
      creatorId: null,
      name: `Team ${durationDays}d`,
      targetSteps: 0,
      status: "ACTIVE",
      isPublic: true,
      timeBased: true,
      maxParticipants: teamSize * 2,
      maxDurationDays: durationDays,
      payoutPreset: "WINNER_TAKES_ALL",
      fundedPrize: funded,
      potCoins,
      buyInAmount,
      isTeamRace: true,
      teamSize,
      teamAName: "Reds",
      teamBName: "Blues",
      teamPoolMultBps: multBps === undefined ? null : multBps,
      payoutRoundingVersion,
      startedAt: new Date(Date.now() - durationDays * 24 * 60 * 60 * 1000),
      endsAt: expired
        ? new Date(Date.now() - 60 * 60 * 1000)
        : new Date(Date.now() + 60 * 60 * 1000),
    },
    select: { id: true, startedAt: true },
  });
}

// `members`: [{ team, steps, forfeited?, buyIn? }] in the order they joined.
async function addMembers(race, members) {
  const users = [];
  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    const u = await makeUser();
    users.push(u);
    await prisma.raceParticipant.create({
      data: {
        raceId: race.id,
        userId: u.userId,
        status: "ACCEPTED",
        team: m.team,
        totalSteps: m.steps,
        finishedAt: new Date(Date.now() - 30 * 60 * 1000),
        finishTotalSteps: m.steps,
        joinedAt: new Date(new Date(race.startedAt).getTime() + i * 1000),
        forfeitedAt: m.forfeited ? new Date(Date.now() - 45 * 60 * 1000) : null,
        ...(m.buyIn
          ? { buyInAmount: m.buyIn, buyInStatus: "COMMITTED" }
          : {}),
      },
    });
  }
  return users;
}

// A 5v5 where TEAM_A always out-steps TEAM_B. Returns { a: [...], b: [...] }.
async function addFiveVsFive(race) {
  const users = await addMembers(race, [
    ...[0, 1, 2, 3, 4].map((i) => ({ team: "TEAM_A", steps: 90000 - i * 100 })),
    ...[0, 1, 2, 3, 4].map((i) => ({ team: "TEAM_B", steps: 50000 - i * 100 })),
  ]);
  return { a: users.slice(0, 5), b: users.slice(5) };
}

describe("team race payout buff (item 5)", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    seq = 0;
    await appSettings.setFlag(FUNDED_FLAG, true);
    await appSettings.setFlag("teamRacesEnabled", true);
  });

  after(async () => {
    await appSettings.setFlag(FUNDED_FLAG, false);
  });

  // ── 1. the three duration bands ──────────────────────────────────────────

  it("1: a 14-day 5v5 pays each winner 600 (1600 x 1.875 = 3000, / 5)", async () => {
    const race = await seedTeamRace({ durationDays: 14, multBps: 18750 });
    const { a, b } = await addFiveVsFive(race);

    await resolveExpiredRaces();

    const settled = await prisma.race.findUnique({ where: { id: race.id } });
    assert.equal(settled.status, "COMPLETED");
    assert.equal(settled.winnerTeam, "TEAM_A");
    assert.equal(settled.prizePoolCoins, 3000, "10 x durationPoints(14)=8 x 20 = 1600, x1.875");
    assert.equal(settled.potCoins, 3000);

    for (const w of a) assert.equal(await coinsOf(w.userId), 600);
    for (const l of b) assert.equal(await coinsOf(l.userId), 0);

    const rows = await txns(race.id, POOL_REASON);
    assert.equal(rows.length, 5);
    assert.deepEqual(
      rows.map((r) => r.amount).sort((x, y) => x - y),
      [600, 600, 600, 600, 600]
    );
    assert.equal(rows.reduce((s, r) => s + r.amount, 0), 3000);
  });

  it("2: a 7-day 5v5 pays each winner 240 (800 x 1.5 = 1200, / 5)", async () => {
    const race = await seedTeamRace({ durationDays: 7, multBps: 15000 });
    const { a, b } = await addFiveVsFive(race);

    await resolveExpiredRaces();

    const settled = await prisma.race.findUnique({ where: { id: race.id } });
    assert.equal(settled.prizePoolCoins, 1200, "10 x durationPoints(7)=4 x 20 = 800, x1.5");
    for (const w of a) assert.equal(await coinsOf(w.userId), 240);
    for (const l of b) assert.equal(await coinsOf(l.userId), 0);
    assert.equal((await txns(race.id, POOL_REASON)).length, 5);
  });

  it("3: a 3-day 2v2 is unchanged — 160 pool, 80 each (multiplier 1.0)", async () => {
    const race = await seedTeamRace({
      durationDays: 3,
      multBps: 10000,
      teamSize: 2,
    });
    const users = await addMembers(race, [
      { team: "TEAM_A", steps: 9000 },
      { team: "TEAM_A", steps: 8000 },
      { team: "TEAM_B", steps: 3000 },
      { team: "TEAM_B", steps: 2000 },
    ]);

    await resolveExpiredRaces();

    const settled = await prisma.race.findUnique({ where: { id: race.id } });
    assert.equal(settled.prizePoolCoins, 160, "4 x durationPoints(3)=2 x 20, x1.0");
    assert.equal(await coinsOf(users[0].userId), 80);
    assert.equal(await coinsOf(users[1].userId), 80);
    assert.equal(await coinsOf(users[2].userId), 0);
    assert.equal(await coinsOf(users[3].userId), 0);
  });

  // ── 2. legacy rows: NULL stamp == today's numbers ─────────────────────────

  it("4: a legacy team race (teamPoolMultBps NULL) settles at exactly today's numbers", async () => {
    const race = await seedTeamRace({ durationDays: 14, multBps: null });
    const { a, b } = await addFiveVsFive(race);

    await resolveExpiredRaces();

    const settled = await prisma.race.findUnique({ where: { id: race.id } });
    assert.equal(settled.teamPoolMultBps, null);
    assert.equal(settled.prizePoolCoins, 1600, "pre-buff pool");
    for (const w of a) assert.equal(await coinsOf(w.userId), 320, "pre-buff per-head");
    for (const l of b) assert.equal(await coinsOf(l.userId), 0);
  });

  // ── 3. the cap binds AFTER multiplication ─────────────────────────────────

  it("5: poolMax clamps the MULTIPLIED pool, not the base pool", async () => {
    // Base pool 1600 is under the 2000 ceiling; multiplied 3000 is over it, so
    // a cap applied before the multiplier would leave 1600 x 1.875 = 3000.
    await withEnv({ PRIZE_POOL_MAX_COINS: "2000" }, async () => {
      const race = await seedTeamRace({ durationDays: 14, multBps: 18750 });
      const { a } = await addFiveVsFive(race);

      await resolveExpiredRaces();

      const settled = await prisma.race.findUnique({ where: { id: race.id } });
      assert.equal(settled.prizePoolCoins, 2000, "clamped to poolMax after x1.875");
      for (const w of a) assert.equal(await coinsOf(w.userId), 400);
    });
  });

  // ── 4. stamp at creation, settle from the stamp ───────────────────────────

  it("6: creation stamps the band from env; team races only", async () => {
    const creator = await makeUser();
    await req("GET", "/auth/me", { token: creator.token, headers: TEAM_HEADERS });

    // A non-team race never carries a multiplier.
    const solo = await req("POST", "/races", {
      token: creator.token,
      body: { name: "Solo", maxDurationDays: 14, isPublic: true },
    });
    assert.equal(solo.status, 201);
    const soloRow = await prisma.race.findUnique({
      where: { id: (await solo.json()).race.id },
    });
    assert.equal(soloRow.teamPoolMultBps, null, "solo races stamp NULL");

    for (const [days, bps] of [[3, 10000], [7, 15000], [14, 18750]]) {
      const teamCreator = await makeUser();
      await req("GET", "/auth/me", { token: teamCreator.token, headers: TEAM_HEADERS });
      const res = await req("POST", "/races", {
        token: teamCreator.token,
        headers: TEAM_HEADERS,
        body: {
          name: `Team ${days}`,
          maxDurationDays: days,
          isTeamRace: true,
          teamSize: 2,
        },
      });
      assert.equal(res.status, 201, `create ${days}d status ${res.status}`);
      const row = await prisma.race.findUnique({
        where: { id: (await res.json()).race.id },
      });
      assert.equal(row.teamPoolMultBps, bps, `${days}-day band`);
    }
  });

  it("7: an env change reprices only NEW races — an in-flight stamped race never reprices", async () => {
    // Created under today's env: 1.875 for a 14-day race.
    const inFlight = await seedTeamRace({ durationDays: 14, multBps: 18750 });
    const { a } = await addFiveVsFive(inFlight);

    await withEnv({ TEAM_POOL_MULT_LONG: "3.0" }, async () => {
      const creator = await makeUser();
      await req("GET", "/auth/me", { token: creator.token, headers: TEAM_HEADERS });
      const res = await req("POST", "/races", {
        token: creator.token,
        headers: TEAM_HEADERS,
        body: {
          name: "Repriced",
          maxDurationDays: 14,
          isTeamRace: true,
          teamSize: 2,
        },
      });
      assert.equal(res.status, 201);
      const fresh = await prisma.race.findUnique({
        where: { id: (await res.json()).race.id },
      });
      assert.equal(fresh.teamPoolMultBps, 30000, "new race takes the new env");

      // The already-stamped race settles off its STAMP, not the live env.
      await resolveExpiredRaces();
    });

    const settled = await prisma.race.findUnique({ where: { id: inFlight.id } });
    assert.equal(settled.prizePoolCoins, 3000, "still 1.875, not 3.0");
    for (const w of a) assert.equal(await coinsOf(w.userId), 600);
  });

  it("8: a malformed multiplier env falls back to the default, never NaN", async () => {
    await withEnv(
      { TEAM_POOL_MULT_LONG: "not-a-number", TEAM_POOL_MULT_MID: "0" },
      async () => {
        const creator = await makeUser();
        await req("GET", "/auth/me", {
          token: creator.token,
          headers: TEAM_HEADERS,
        });
        for (const [days, bps] of [[14, 18750], [7, 15000]]) {
          const res = await req("POST", "/races", {
            token: creator.token,
            headers: TEAM_HEADERS,
            body: {
              name: `Bad env ${days}`,
              maxDurationDays: days,
              isTeamRace: true,
              teamSize: 2,
            },
          });
          assert.equal(res.status, 201);
          const row = await prisma.race.findUnique({
            where: { id: (await res.json()).race.id },
          });
          assert.equal(row.teamPoolMultBps, bps, `${days}d fell back to default`);
        }
      }
    );
  });

  // ── 5. projection == settlement ───────────────────────────────────────────

  it("9: the pool advertised on GET /races/:id mid-race is what settlement pays", async () => {
    const race = await seedTeamRace({
      durationDays: 14,
      multBps: 18750,
      expired: false,
    });
    const { a } = await addFiveVsFive(race);

    const detail = await req("GET", `/races/${race.id}`, {
      token: a[0].token,
      headers: TEAM_HEADERS,
    });
    assert.equal(detail.status, 200);
    const body = await detail.json();
    assert.equal(body.prizePool.coins, 3000, "projection carries the multiplier");
    assert.equal(body.prizePool.projected, true);
    assert.equal(body.projectedPotCoins, 3000);

    // Now let the deadline pass and settle for real.
    await prisma.race.update({
      where: { id: race.id },
      data: { endsAt: new Date(Date.now() - 60 * 1000) },
    });
    await resolveExpiredRaces();

    const settled = await prisma.race.findUnique({ where: { id: race.id } });
    assert.equal(
      settled.prizePoolCoins,
      body.prizePool.coins,
      "settlement matches the advertised projection"
    );
    const paid = (await txns(race.id, POOL_REASON)).reduce(
      (s, r) => s + r.amount,
      0
    );
    assert.equal(paid, body.prizePool.coins);

    const after = await req("GET", `/races/${race.id}`, {
      token: a[0].token,
      headers: TEAM_HEADERS,
    });
    const afterBody = await after.json();
    assert.equal(afterBody.prizePool.coins, 3000);
    assert.equal(afterBody.prizePool.projected, false);
  });

  it("9a: an active v1 team race still advertises its projected pool", async () => {
    const race = await seedTeamRace({
      durationDays: 14,
      multBps: 18750,
      payoutRoundingVersion: 1,
      expired: false,
    });
    const { a } = await addFiveVsFive(race);

    const detail = await req("GET", `/races/${race.id}`, {
      token: a[0].token,
      headers: TEAM_HEADERS,
    });
    assert.equal(detail.status, 200);
    const body = await detail.json();
    assert.equal(body.prizePool.coins, 3000);
    assert.equal(body.prizePool.projected, true);
    assert.equal(body.projectedPotCoins, 3000);
  });

  // ── 6. tie: mint and split across BOTH teams ──────────────────────────────

  it("10: a funded team-race tie splits the multiplied pool evenly across all non-forfeited members, remainder to the top stepper", async () => {
    // 1-day band (x1.0) with a forfeiter, so the pool (4 walkers) does not
    // divide evenly across the 3 members who actually split it:
    //   4 x durationPoints(1)=1 x 20 = 80 ; 80 / 3 = 26 each, remainder 2.
    // Team totals tie at 100 each (forfeited totals still count for the team).
    const race = await seedTeamRace({
      durationDays: 1,
      multBps: 10000,
      teamSize: 2,
    });
    const users = await addMembers(race, [
      { team: "TEAM_A", steps: 60 },
      { team: "TEAM_A", steps: 40, forfeited: true },
      { team: "TEAM_B", steps: 70 },
      { team: "TEAM_B", steps: 30 },
    ]);
    const [a1, aForfeit, b1, b2] = users;

    await resolveExpiredRaces();

    const settled = await prisma.race.findUnique({ where: { id: race.id } });
    assert.equal(settled.status, "COMPLETED");
    assert.equal(settled.winnerTeam, null, "tie");
    assert.equal(settled.prizePoolCoins, 80, "the tie now STAMPS the pool");
    assert.equal(settled.potCoins, 80);

    assert.equal(await coinsOf(b1.userId), 28, "top stepper takes the remainder");
    assert.equal(await coinsOf(a1.userId), 26);
    assert.equal(await coinsOf(b2.userId), 26);
    assert.equal(await coinsOf(aForfeit.userId), 0, "forfeiters are paid nothing");

    const rows = await txns(race.id, POOL_REASON);
    assert.equal(rows.length, 3);
    assert.equal(rows.reduce((s, r) => s + r.amount, 0), 80);

    const parts = await prisma.raceParticipant.findMany({
      where: { raceId: race.id },
    });
    for (const p of parts) {
      assert.equal(p.placement, 1, "a tie places everyone 1st");
    }
  });

  it("11: a tied team race with a multiplier band mints the MULTIPLIED pool", async () => {
    const race = await seedTeamRace({ durationDays: 14, multBps: 18750 });
    const users = await addMembers(race, [
      { team: "TEAM_A", steps: 5000 },
      { team: "TEAM_B", steps: 5000 },
    ]);

    await resolveExpiredRaces();

    const settled = await prisma.race.findUnique({ where: { id: race.id } });
    // 2 x 8 x 20 = 320 ; x1.875 = 600 ; / 2 = 300 each.
    assert.equal(settled.prizePoolCoins, 600);
    assert.equal(await coinsOf(users[0].userId), 300);
    assert.equal(await coinsOf(users[1].userId), 300);
  });

  it("12: a tie still refunds every buy-in (legacy buy-in team race, no minting)", async () => {
    const race = await seedTeamRace({
      durationDays: 1,
      multBps: null,
      funded: false,
      teamSize: 1,
      potCoins: 100,
      buyInAmount: 50,
    });
    const users = await addMembers(race, [
      { team: "TEAM_A", steps: 5000, buyIn: 50 },
      { team: "TEAM_B", steps: 5000, buyIn: 50 },
    ]);

    await resolveExpiredRaces();

    const settled = await prisma.race.findUnique({ where: { id: race.id } });
    assert.equal(settled.winnerTeam, null);
    assert.equal(settled.potCoins, 0, "pot zeroed");
    assert.equal(settled.prizePoolCoins, 0, "a buy-in race mints nothing");
    for (const u of users) assert.equal(await coinsOf(u.userId), 50, "refunded");
    assert.equal((await txns(race.id, REFUND_REASON)).length, 2);
    assert.equal((await txns(race.id, POOL_REASON)).length, 0);
  });

  // ── 7. tournaments are explicitly unaffected ──────────────────────────────

  it("13: tournaments ignore the team multiplier entirely", async () => {
    await appSettings.setFlag("tournamentsEnabled", true);
    const FEAT = { "X-Client-Features": "tournaments" };

    await withEnv(
      {
        TEAM_POOL_MULT_SHORT: "5",
        TEAM_POOL_MULT_MID: "5",
        TEAM_POOL_MULT_LONG: "5",
      },
      async () => {
        const users = [];
        for (let i = 0; i < 4; i++) {
          const u = await makeUser();
          await req("GET", "/races", { token: u.token, headers: FEAT });
          users.push(u);
        }
        const created = await req("POST", "/tournaments", {
          token: users[0].token,
          headers: FEAT,
          body: {
            name: "Cup 4",
            bracketSize: 4,
            matchupDurationDays: 2,
            buyInAmount: 0,
            isPublic: true,
          },
        });
        assert.equal(created.status, 201);
        const { tournament } = await created.json();
        for (const u of users.slice(1)) {
          const join = await req("POST", `/tournaments/${tournament.id}/join`, {
            token: u.token,
            headers: FEAT,
          });
          assert.equal(join.status, 201);
        }

        const detail = await req("GET", `/tournaments/${tournament.id}`, {
          token: users[0].token,
          headers: FEAT,
        });
        const body = await detail.json();
        const t = body.tournament || body;
        // 4 players x durationPoints(4)=4 x the permanent v2 unit 10 = 160.
        assert.equal(t.prizePool.coins, 160, "tournament pool unmultiplied");

        // ...and the matchup races the bracket created carry no stamp.
        const matchups = await prisma.race.findMany({
          where: { tournamentId: tournament.id },
        });
        assert.ok(matchups.length > 0);
        for (const m of matchups) {
          assert.equal(m.teamPoolMultBps, null, "tournament race stamps NULL");
        }
      }
    );
  });
});
