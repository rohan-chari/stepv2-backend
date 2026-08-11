// Batch 2026-08-10 (part 2) — Item 1: REROLL ALL after OPEN ALL.
//
// One rewarded ad re-rolls every eligible box from an "Open All" batch.
// POST /races/:raceId/powerups/reroll-batch
//
// The response contract is FROZEN and keyed `powerupId` (NOT `id`) — see
// architect finding R2: the client joins these rows against
// MultiCaseOpeningScreen._results, which open-batch keys `powerupId`. An
// id/powerupId mismatch fails SILENTLY (every reel keeps its old result, no
// error surfaces), so test 10c pins the key name.
//
// Local/staging escape hatch for the SSV signature check. MUST be set before
// `./setup` is required (read at module load, unlike ADS_BOX_REROLL_ENABLED
// which is a true call-time kill switch).
process.env.ADMOB_SSV_SKIP_VERIFY = "true";

const assert = require("node:assert/strict");
const { describe, it, before, beforeEach, afterEach, after } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const {
  POWERUPS5_GATED_TYPES,
} = require("../../src/modules/powerups/constants/powerupGating");

let server;
let nextAppleId = 0;

const ADS_FEATURES = {
  "X-Client-Features": "characters,jammer,powerups2,powerups3,powerups4,powerups5,ads",
};
// A build that renders powerups but cannot show a rewarded ad.
const NO_ADS_FEATURES = {
  "X-Client-Features": "characters,powerups3,powerups4,powerups5",
};
// A build with ads but WITHOUT the wave-5 token.
const NO_P5_FEATURES = {
  "X-Client-Features": "characters,powerups3,powerups4,ads",
};
const REROLL_KIND = "box_reroll";
// Mirrors REROLL_BATCH_MAX_COUNT in the command. Duplicated deliberately: a
// test that imported the constant would pass no matter what value shipped.
const MAX_COUNT = 8;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function shiftDate(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

async function createUser(displayName) {
  const appleId = `apple-rrbatch-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  if (displayName) {
    await request(server.baseUrl, "PUT", "/auth/me/display-name", {
      body: { displayName },
      token: body.sessionToken,
    });
  }
  // Pin the stored zone so the server-derived local date matches `today()`.
  await prisma.user.update({
    where: { id: body.user.id },
    data: { timezone: "UTC" },
  });
  return { userId: body.user.id, token: body.sessionToken };
}

async function makeFriends(a, b) {
  const sendRes = await request(server.baseUrl, "POST", "/friends/request", {
    body: { addresseeId: b.userId },
    token: a.token,
  });
  const fId = (await sendRes.json()).friendship.id;
  await request(server.baseUrl, "PUT", `/friends/request/${fId}`, {
    body: { accept: true },
    token: b.token,
  });
}

async function createActiveRace(alice, others) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Reroll Batch Test",
      targetSteps: 200000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 5000,
    },
    token: alice.token,
  });
  const raceId = (await createRes.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: others.map((o) => o.userId) },
    token: alice.token,
  });
  for (const o of others) {
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: o.token,
    });
  }
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: alice.token,
  });
  const start = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: start } });
  await prisma.raceParticipant.updateMany({
    where: { raceId },
    data: { joinedAt: start },
  });
  return raceId;
}

// A powerup as it exists AFTER a mystery box has been opened.
async function seedOpenedPowerup(raceId, user, overrides = {}) {
  const participant = await prisma.raceParticipant.findFirst({
    where: { raceId, userId: user.userId },
  });
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: participant.id,
      userId: user.userId,
      type: "PROTEIN_SHAKE",
      rarity: "COMMON",
      status: "HELD",
      configVersion: 999999,
      earnedAtSteps: Math.floor(Math.random() * 1_000_000),
      ...overrides,
    },
  });
}

async function seedGrant(userId, grantedDate = today(), extra = {}) {
  return prisma.adRewardGrant.create({
    data: {
      userId,
      transactionId: `txn-rrb-${userId}-${Math.random()}`,
      rewardKind: REROLL_KIND,
      grantedDate,
      ...extra,
    },
  });
}

async function rerollBatch(token, raceId, body, headers = ADS_FEATURES) {
  const res = await request(
    server.baseUrl,
    "POST",
    `/races/${raceId}/powerups/reroll-batch`,
    { token, headers, ...(body === undefined ? {} : { body }) }
  );
  return { status: res.status, body: await res.json() };
}

async function progress(token, raceId, headers) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, {
    token,
    ...(headers ? { headers } : {}),
  });
  return { status: res.status, body: await res.json() };
}

function rowFor(body, powerupId) {
  return (body.results || []).find((r) => r.powerupId === powerupId);
}

describe("Batch 2026-08-10b item 1 — POST /races/:raceId/powerups/reroll-batch", () => {
  let alice;
  let bob;
  let raceId;

  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    process.env.ADS_BOX_REROLL_ENABLED = "true";
    nextAppleId = 0;
    alice = await createUser("Alice");
    bob = await createUser("Bob");
    await makeFriends(alice, bob);
    raceId = await createActiveRace(alice, [bob]);
  });

  afterEach(() => {
    delete process.env.ADS_BOX_REROLL_ENABLED;
  });

  after(async () => {
    delete process.env.ADMOB_SSV_SKIP_VERIFY;
  });

  // ── 1. Kill switch ───────────────────────────────────────────────────────
  it("kill switch OFF -> 503 DISABLED and no grant consumed", async () => {
    delete process.env.ADS_BOX_REROLL_ENABLED;
    const p1 = await seedOpenedPowerup(raceId, alice);
    const grant = await seedGrant(alice.userId);

    const { status, body } = await rerollBatch(alice.token, raceId, {
      powerupIds: [p1.id],
    });
    assert.equal(status, 503, JSON.stringify(body));
    assert.equal(body.code, "DISABLED");

    const g = await prisma.adRewardGrant.findUnique({ where: { id: grant.id } });
    assert.equal(g.consumedAt, null, "the credit survives a disabled endpoint");
    const row = await prisma.racePowerup.findUnique({ where: { id: p1.id } });
    assert.equal(row.rerolledAt, null);
  });

  // ── 2. Happy path ────────────────────────────────────────────────────────
  it("rerolls all three, stamps rerolledAt, consumes EXACTLY one grant", async () => {
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await seedOpenedPowerup(raceId, alice)).id);
    const g1 = await seedGrant(alice.userId);
    const g2 = await seedGrant(alice.userId);

    const { status, body } = await rerollBatch(alice.token, raceId, {
      powerupIds: ids,
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.rerolledCount, 3);
    assert.equal(body.results.length, 3);
    assert.deepEqual(
      body.results.map((r) => r.powerupId),
      ids,
      "results come back in REQUEST order"
    );
    for (const r of body.results) {
      assert.equal(r.rerolled, true);
      assert.ok(r.type, "a type is returned");
      assert.ok(r.rarity, "a rarity is returned");
      assert.equal("skipped" in r, false, "no skip reason on a rerolled row");
    }

    for (const id of ids) {
      const row = await prisma.racePowerup.findUnique({ where: { id } });
      assert.ok(row.rerolledAt instanceof Date, "rerolledAt stamped");
      assert.equal(row.status, "HELD");
      assert.notEqual(row.configVersion, 999999, "configVersion RESTAMPED");
      assert.equal(row.type, rowFor(body, id).type, "new type PERSISTED");
      assert.equal(row.rarity, rowFor(body, id).rarity, "new rarity PERSISTED");
    }

    const grants = await prisma.adRewardGrant.findMany({
      where: { userId: alice.userId },
    });
    const consumed = grants.filter((g) => g.consumedAt != null);
    assert.equal(consumed.length, 1, "ONE ad = N rerolls (exactly one grant burnt)");
    assert.ok([g1.id, g2.id].includes(consumed[0].id));

    // One hidden audit row PER rerolled box, never a new event type.
    const audit = await prisma.racePowerupEvent.findMany({
      where: { raceId, eventType: "POWERUP_REROLLED" },
    });
    assert.equal(audit.length, 3, "one POWERUP_REROLLED audit row per box");

    const feed = await (
      await request(server.baseUrl, "GET", `/races/${raceId}/feed`, {
        token: alice.token,
        headers: ADS_FEATURES,
      })
    ).json();
    assert.ok(
      !(feed.events || []).some((e) => e.eventType === "POWERUP_REROLLED"),
      "hidden from the visible feed (box contents must not leak)"
    );
  });

  // ── 3. Mixed batch ───────────────────────────────────────────────────────
  it("mixed batch: rerolls the eligible one, skips the rest with UNCHANGED type/rarity", async () => {
    const held = await seedOpenedPowerup(raceId, alice);
    const already = await seedOpenedPowerup(raceId, alice, {
      type: "RED_CARD",
      rarity: "RARE",
      rerolledAt: new Date(),
    });
    const used = await seedOpenedPowerup(raceId, alice, {
      type: "LEG_CRAMP",
      rarity: "UNCOMMON",
      status: "USED",
      usedAt: new Date(),
    });
    const grant = await seedGrant(alice.userId);

    const { status, body } = await rerollBatch(alice.token, raceId, {
      powerupIds: [held.id, already.id, used.id],
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.rerolledCount, 1);
    assert.equal(body.results.length, 3);

    assert.equal(rowFor(body, held.id).rerolled, true);

    const a = rowFor(body, already.id);
    assert.equal(a.rerolled, false);
    assert.equal(a.skipped, "ALREADY_REROLLED");
    assert.equal(a.type, "RED_CARD", "skipped rows carry their CURRENT type");
    assert.equal(a.rarity, "RARE");

    const u = rowFor(body, used.id);
    assert.equal(u.rerolled, false);
    assert.equal(u.skipped, "NOT_HELD");
    assert.equal(u.type, "LEG_CRAMP");
    assert.equal(u.rarity, "UNCOMMON");

    const g = await prisma.adRewardGrant.findUnique({ where: { id: grant.id } });
    assert.ok(g.consumedAt, "one grant consumed for the one successful reroll");

    const usedRow = await prisma.racePowerup.findUnique({ where: { id: used.id } });
    assert.equal(usedRow.type, "LEG_CRAMP", "the skipped rows are untouched in the DB");
    assert.equal(usedRow.rerolledAt, null);
  });

  it("a null-rarity (stash-redeemed) and an upgraded powerup are both NOT_HELD", async () => {
    const stash = await seedOpenedPowerup(raceId, alice, { rarity: null });
    const upgraded = await seedOpenedPowerup(raceId, alice, { upgradeLevel: 1 });
    const held = await seedOpenedPowerup(raceId, alice);
    await seedGrant(alice.userId);

    const { status, body } = await rerollBatch(alice.token, raceId, {
      powerupIds: [stash.id, upgraded.id, held.id],
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.rerolledCount, 1);
    assert.equal(rowFor(body, stash.id).skipped, "NOT_HELD");
    assert.equal(rowFor(body, upgraded.id).skipped, "NOT_HELD");
    assert.equal(rowFor(body, held.id).rerolled, true);
  });

  // ── 4. All ineligible: the ad is NOT burned ──────────────────────────────
  it("all-ineligible batch -> 409 NOTHING_TO_REROLL and the grant is STILL unconsumed", async () => {
    const used = await seedOpenedPowerup(raceId, alice, {
      status: "USED",
      usedAt: new Date(),
    });
    const already = await seedOpenedPowerup(raceId, alice, { rerolledAt: new Date() });
    const grant = await seedGrant(alice.userId);

    const { status, body } = await rerollBatch(alice.token, raceId, {
      powerupIds: [used.id, already.id],
    });
    assert.equal(status, 409, JSON.stringify(body));
    assert.equal(body.code, "NOTHING_TO_REROLL");

    const g = await prisma.adRewardGrant.findUnique({ where: { id: grant.id } });
    assert.equal(g.consumedAt, null, "the eligibility sweep runs BEFORE the consume");
  });

  it("a NOT_FOUND id alone -> 409 NOTHING_TO_REROLL", async () => {
    const grant = await seedGrant(alice.userId);
    const { status, body } = await rerollBatch(alice.token, raceId, {
      powerupIds: ["00000000-0000-0000-0000-000000000000"],
    });
    assert.equal(status, 409, JSON.stringify(body));
    assert.equal(body.code, "NOTHING_TO_REROLL");
    const g = await prisma.adRewardGrant.findUnique({ where: { id: grant.id } });
    assert.equal(g.consumedAt, null);
  });

  // ── 5. No grant ──────────────────────────────────────────────────────────
  it("no grant -> 409 AD_NOT_VERIFIED, nothing rerolled", async () => {
    const p1 = await seedOpenedPowerup(raceId, alice);
    const { status, body } = await rerollBatch(alice.token, raceId, {
      powerupIds: [p1.id],
    });
    assert.equal(status, 409, JSON.stringify(body));
    assert.equal(body.code, "AD_NOT_VERIFIED");
    const row = await prisma.racePowerup.findUnique({ where: { id: p1.id } });
    assert.equal(row.rerolledAt, null);
    assert.equal(row.type, "PROTEIN_SHAKE");
  });

  it("an already-consumed grant -> 409 AD_NOT_VERIFIED", async () => {
    const p1 = await seedOpenedPowerup(raceId, alice);
    await seedGrant(alice.userId, today(), { consumedAt: new Date() });
    const { status, body } = await rerollBatch(alice.token, raceId, {
      powerupIds: [p1.id],
    });
    assert.equal(status, 409);
    assert.equal(body.code, "AD_NOT_VERIFIED");
  });

  it("another user's grant does not satisfy the batch", async () => {
    const p1 = await seedOpenedPowerup(raceId, alice);
    await seedGrant(bob.userId);
    const { status, body } = await rerollBatch(alice.token, raceId, {
      powerupIds: [p1.id],
    });
    assert.equal(status, 409);
    assert.equal(body.code, "AD_NOT_VERIFIED");
  });

  // ── 6. Foreign ids are OMITTED, never echoed ─────────────────────────────
  it("a foreign powerupId is omitted from results, not rerolled, and leaks no 403", async () => {
    const mine = await seedOpenedPowerup(raceId, alice);
    const theirs = await seedOpenedPowerup(raceId, bob, {
      type: "RED_CARD",
      rarity: "RARE",
    });
    await seedGrant(alice.userId);

    const { status, body } = await rerollBatch(alice.token, raceId, {
      powerupIds: [mine.id, theirs.id],
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.rerolledCount, 1);
    assert.equal(body.results.length, 1, "the foreign id is not echoed at all");
    assert.equal(body.results[0].powerupId, mine.id);
    assert.equal(
      rowFor(body, theirs.id),
      undefined,
      "another user's powerup must never be confirmed to exist"
    );

    const theirRow = await prisma.racePowerup.findUnique({ where: { id: theirs.id } });
    assert.equal(theirRow.type, "RED_CARD", "untouched");
    assert.equal(theirRow.rerolledAt, null);
  });

  it("a batch of ONLY foreign ids -> 409 NOTHING_TO_REROLL, grant untouched", async () => {
    const theirs = await seedOpenedPowerup(raceId, bob);
    const grant = await seedGrant(alice.userId);
    const { status, body } = await rerollBatch(alice.token, raceId, {
      powerupIds: [theirs.id],
    });
    assert.equal(status, 409, JSON.stringify(body));
    assert.equal(body.code, "NOTHING_TO_REROLL");
    const g = await prisma.adRewardGrant.findUnique({ where: { id: grant.id } });
    assert.equal(g.consumedAt, null);
  });

  // ── 7. Race / participant guards ─────────────────────────────────────────
  it("race not ACTIVE -> 400, grant untouched", async () => {
    const p1 = await seedOpenedPowerup(raceId, alice);
    const grant = await seedGrant(alice.userId);
    await prisma.race.update({
      where: { id: raceId },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    const { status } = await rerollBatch(alice.token, raceId, {
      powerupIds: [p1.id],
    });
    assert.equal(status, 400);
    const g = await prisma.adRewardGrant.findUnique({ where: { id: grant.id } });
    assert.equal(g.consumedAt, null);
  });

  it("a non-participant -> 403", async () => {
    const charlie = await createUser("Charlie");
    const p1 = await seedOpenedPowerup(raceId, alice);
    await seedGrant(charlie.userId);
    const { status } = await rerollBatch(charlie.token, raceId, {
      powerupIds: [p1.id],
    });
    assert.equal(status, 403);
  });

  // ── 8. localDate ─────────────────────────────────────────────────────────
  it("malformed localDate -> 400 INVALID_LOCAL_DATE, grant untouched", async () => {
    const p1 = await seedOpenedPowerup(raceId, alice);
    const grant = await seedGrant(alice.userId);
    const { status, body } = await rerollBatch(alice.token, raceId, {
      powerupIds: [p1.id],
      localDate: "not-a-date",
    });
    assert.equal(status, 400, JSON.stringify(body));
    assert.equal(body.code, "INVALID_LOCAL_DATE");
    const g = await prisma.adRewardGrant.findUnique({ where: { id: grant.id } });
    assert.equal(g.consumedAt, null);
  });

  it("a localDate far from server time -> 400 INVALID_LOCAL_DATE", async () => {
    const p1 = await seedOpenedPowerup(raceId, alice);
    const { status, body } = await rerollBatch(alice.token, raceId, {
      powerupIds: [p1.id],
      localDate: "2020-01-01",
    });
    assert.equal(status, 400);
    assert.equal(body.code, "INVALID_LOCAL_DATE");
  });

  it("a grant stamped YESTERDAY is spendable today (adjacent-date lookup)", async () => {
    const p1 = await seedOpenedPowerup(raceId, alice);
    const grant = await seedGrant(alice.userId, shiftDate(-1));
    const { status, body } = await rerollBatch(alice.token, raceId, {
      powerupIds: [p1.id],
      localDate: today(),
    });
    assert.equal(status, 200, JSON.stringify(body));
    const g = await prisma.adRewardGrant.findUnique({ where: { id: grant.id } });
    assert.ok(g.consumedAt, "a midnight-straddling credit must not be stranded");
  });

  it("localDate is OPTIONAL — the server derives it from the stored zone", async () => {
    const p1 = await seedOpenedPowerup(raceId, alice);
    await seedGrant(alice.userId);
    const { status, body } = await rerollBatch(alice.token, raceId, {
      powerupIds: [p1.id],
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.rerolledCount, 1);
  });

  // ── 9. Wave-5 gate ───────────────────────────────────────────────────────
  it("without the powerups5 token no reroll ever lands a wave-5 type", async () => {
    // 4 batches × 8 boxes = 32 rolls from a build that cannot render wave-5
    // types. The gate is a deterministic pool filter, so a break shows up as a
    // gated type appearing at all — this can never produce a false FAILURE.
    for (let batch = 0; batch < 4; batch++) {
      const ids = [];
      for (let i = 0; i < MAX_COUNT; i++) {
        ids.push((await seedOpenedPowerup(raceId, alice)).id);
      }
      await seedGrant(alice.userId);
      const { status, body } = await rerollBatch(
        alice.token,
        raceId,
        { powerupIds: ids },
        NO_P5_FEATURES
      );
      assert.equal(status, 200, JSON.stringify(body));
      for (const r of body.results) {
        assert.ok(
          !POWERUPS5_GATED_TYPES.includes(r.type),
          `wave-5 type ${r.type} rolled for a non-powerups5 client`
        );
      }
    }
  });

  // ── 10. Input validation + de-duplication ────────────────────────────────
  it("missing / non-array / empty powerupIds -> 400, grant untouched", async () => {
    const grant = await seedGrant(alice.userId);
    for (const body of [undefined, {}, { powerupIds: [] }, { powerupIds: "x" }]) {
      const res = await rerollBatch(alice.token, raceId, body);
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    }
    const g = await prisma.adRewardGrant.findUnique({ where: { id: grant.id } });
    assert.equal(g.consumedAt, null);
  });

  it("a duplicate-listed id is de-duplicated and appears exactly once", async () => {
    const p1 = await seedOpenedPowerup(raceId, alice);
    const p2 = await seedOpenedPowerup(raceId, alice);
    await seedGrant(alice.userId);

    const { status, body } = await rerollBatch(alice.token, raceId, {
      powerupIds: [p1.id, p2.id, p1.id, p1.id],
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.results.length, 2, "de-duplicated");
    assert.equal(body.rerolledCount, 2, "a repeat is not a second reroll");
    assert.deepEqual(body.results.map((r) => r.powerupId), [p1.id, p2.id]);
  });

  // ── 10b. The cap ─────────────────────────────────────────────────────────
  it("more than REROLL_BATCH_MAX_COUNT eligible ids -> the first N reroll, the rest are OVER_CAP", async () => {
    const ids = [];
    for (let i = 0; i < MAX_COUNT + 3; i++) {
      ids.push((await seedOpenedPowerup(raceId, alice)).id);
    }
    const grant = await seedGrant(alice.userId);

    const { status, body } = await rerollBatch(alice.token, raceId, {
      powerupIds: ids,
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.rerolledCount, MAX_COUNT);
    assert.equal(body.results.length, ids.length, "every owned id appears in results");

    for (let i = 0; i < ids.length; i++) {
      const r = rowFor(body, ids[i]);
      if (i < MAX_COUNT) {
        assert.equal(r.rerolled, true, `id ${i} should have rerolled`);
      } else {
        assert.equal(r.rerolled, false);
        assert.equal(r.skipped, "OVER_CAP");
        assert.equal(r.type, "PROTEIN_SHAKE", "over-cap rows keep their CURRENT type");
        assert.equal(r.rarity, "COMMON");
        const row = await prisma.racePowerup.findUnique({ where: { id: ids[i] } });
        assert.equal(row.rerolledAt, null, "over-cap rows are not written");
      }
    }

    const grants = await prisma.adRewardGrant.findMany({
      where: { userId: alice.userId, consumedAt: { not: null } },
    });
    assert.equal(grants.length, 1, "still exactly one ad watch");
    assert.equal(grants[0].id, grant.id);
  });

  // Code review 2026-08-10, issue 2: the cap counts ELIGIBLE rows, not request
  // positions. Capping the raw id list instead let N ineligible ids listed
  // first push the only rerollable box past the cap, turning a perfectly valid
  // batch into a 409 NOTHING_TO_REROLL.
  it("the cap counts ELIGIBLE rows: MAX_COUNT ineligible ids first do not crowd out a rerollable one", async () => {
    const ids = [];
    for (let i = 0; i < MAX_COUNT; i++) {
      ids.push((await seedOpenedPowerup(raceId, alice, { rerolledAt: new Date() })).id);
    }
    const fresh = await seedOpenedPowerup(raceId, alice);
    ids.push(fresh.id);
    await seedGrant(alice.userId);

    const { status, body } = await rerollBatch(alice.token, raceId, {
      powerupIds: ids,
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.rerolledCount, 1, "the eligible box still rerolls");
    assert.equal(rowFor(body, fresh.id).rerolled, true);
    assert.equal(rowFor(body, fresh.id).skipped, undefined, "not OVER_CAP");
    for (let i = 0; i < MAX_COUNT; i++) {
      assert.equal(rowFor(body, ids[i]).skipped, "ALREADY_REROLLED");
    }
  });

  // Code review 2026-08-10, issue 1: the raw input list must be bounded BEFORE
  // it reaches `findMany({ id: { in: ids } })`, otherwise an authenticated
  // participant can buy an unbounded IN on the one-vCPU box for free — the
  // 409 lands afterwards, so no ad is spent.
  it("rejects an oversized powerupIds list before touching the database", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `pw_flood_${i}`);
    const grant = await seedGrant(alice.userId);

    const { status, body } = await rerollBatch(alice.token, raceId, {
      powerupIds: ids,
    });
    assert.equal(status, 400, JSON.stringify(body));
    const row = await prisma.adRewardGrant.findUnique({ where: { id: grant.id } });
    assert.equal(row.consumedAt, null, "an over-long request never spends the watch");
  });

  it("de-duplication happens BEFORE the cap", async () => {
    // MAX_COUNT distinct ids, each listed twice. If the cap were applied to the
    // raw list, only MAX_COUNT/2 distinct boxes would reroll.
    const ids = [];
    for (let i = 0; i < MAX_COUNT; i++) {
      ids.push((await seedOpenedPowerup(raceId, alice)).id);
    }
    await seedGrant(alice.userId);
    const { status, body } = await rerollBatch(alice.token, raceId, {
      powerupIds: [...ids, ...ids],
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.rerolledCount, MAX_COUNT, "all MAX_COUNT distinct ids rerolled");
    assert.equal(body.results.length, MAX_COUNT);
  });

  // ── 10c. The frozen key name (architect R2) ──────────────────────────────
  it("SCHEMA: rows are keyed `powerupId`, never `id`", async () => {
    const p1 = await seedOpenedPowerup(raceId, alice);
    const p2 = await seedOpenedPowerup(raceId, alice, {
      status: "USED",
      usedAt: new Date(),
    });
    await seedGrant(alice.userId);
    const { status, body } = await rerollBatch(alice.token, raceId, {
      powerupIds: [p1.id, p2.id],
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(Object.keys(body).sort(), ["rerolledCount", "results"]);

    const rerolled = body.results[0];
    assert.deepEqual(
      Object.keys(rerolled).sort(),
      ["powerupId", "rarity", "rerolled", "type"],
      "a rerolled row: powerupId/type/rarity/rerolled — NOT `id`"
    );
    const skipped = body.results[1];
    assert.deepEqual(
      Object.keys(skipped).sort(),
      ["powerupId", "rarity", "rerolled", "skipped", "type"],
      "a skipped row adds exactly `skipped`"
    );
    for (const r of body.results) {
      assert.equal("id" in r, false, "the client joins on powerupId; `id` would fail SILENTLY");
    }
  });

  // ── 11. The advertisement ────────────────────────────────────────────────
  it("progress advertises boxRerollBatch: true with ads + switch on", async () => {
    const { body } = await progress(alice.token, raceId, ADS_FEATURES);
    assert.equal(body.progress.powerupData.boxRerollBatch, true);
    assert.equal(body.progress.powerupData.boxReroll, true, "sibling flag unchanged");
  });

  it("boxRerollBatch is ABSENT (not false) when the kill switch is off", async () => {
    delete process.env.ADS_BOX_REROLL_ENABLED;
    const { body } = await progress(alice.token, raceId, ADS_FEATURES);
    const pd = body.progress.powerupData;
    assert.ok(pd, "powerupData still present");
    assert.equal("boxRerollBatch" in pd, false);
    assert.equal("boxReroll" in pd, false);
  });

  it("boxRerollBatch is ABSENT for a client that cannot show ads", async () => {
    const { body } = await progress(alice.token, raceId, NO_ADS_FEATURES);
    assert.equal("boxRerollBatch" in body.progress.powerupData, false);
  });

  it("FROZEN CLIENT: no X-Client-Features -> no boxRerollBatch, shape intact", async () => {
    const { status, body } = await progress(alice.token, raceId);
    assert.equal(status, 200);
    const pd = body.progress.powerupData;
    assert.equal("boxRerollBatch" in pd, false);
    for (const key of [
      "enabled",
      "newMysteryBoxes",
      "newQueuedBoxes",
      "powerupStepInterval",
      "upgradeCosts",
      "rarityByType",
      "powerupSlots",
      "inventory",
      "queuedBoxCount",
      "activeEffects",
    ]) {
      assert.ok(key in pd, `powerupData.${key} still present`);
    }
  });
});
