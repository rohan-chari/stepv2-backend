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
const {
  buildRenewSeededRaces,
} = require("../../src/modules/races/jobs/seededRaceRenewal");

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

  it("7: a 100-player 14-day race pays the full 16,000 and reports atMax", async () => {
    const { creator, raceId } = await createFundedRace({
      players: 100,
      maxDurationDays: 14,
    });

    const detail = await req("GET", `/races/${raceId}`, { token: creator.token });
    assert.equal(detail.status, 200);
    const body = await detail.json();

    assert.equal(body.prizePool.coins, 16000, "100 x 8 points x 20");
    assert.equal(body.prizePool.atMax, true, "16,000 is the ceiling");
    assert.equal(body.prizePool.maxCoins, 16000);
    assert.equal(body.prizePool.playerCount, 100);
    assert.equal(body.prizePool.durationPoints, 8);
    assert.equal(body.prizePool.coinUnit, 20);
    // Frozen builds read the pool as the pot; it must carry the same figure.
    assert.equal(body.projectedPotCoins, 16000);
  });

  it("7: the duration band is flat above 7 days — 100 x 30 days is also 16,000", async () => {
    const { creator, raceId } = await createFundedRace({
      players: 100,
      maxDurationDays: 30,
    });

    const detail = await req("GET", `/races/${raceId}`, { token: creator.token });
    const body = await detail.json();
    assert.equal(body.prizePool.coins, 16000);
    assert.equal(body.prizePool.durationPoints, 8);
    assert.equal(body.prizePool.maxCoins, 16000);
    assert.equal(body.prizePool.atMax, true);
  });

  it("7: small fields are UNCHANGED — 4 players x 1 day is still 80", async () => {
    const { creator, raceId } = await createFundedRace({
      players: 4,
      maxDurationDays: 1,
    });

    const detail = await req("GET", `/races/${raceId}`, { token: creator.token });
    const body = await detail.json();
    assert.equal(body.prizePool.coins, 80, "4 x 1 point x 20 — the raise is a ceiling only");
    assert.equal(body.prizePool.atMax, false);
    assert.equal(body.prizePool.maxCoins, 16000);
  });

  it("7: tournaments keep their own tighter MAX_CHAMPION_PRIZE ceiling", async () => {
    // 16 players x (4 rounds x 3 days = 12 days -> 8 points) x 20 = 2,560, well
    // over MAX_CHAMPION_PRIZE, so the bracket must still clamp at 1,000 — proof
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
    assert.equal(t.prizePool.maxCoins, 1000, "MAX_CHAMPION_PRIZE, untouched");
    assert.equal(t.prizePool.coins, 1000, "still clamped to the bracket ceiling");
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
