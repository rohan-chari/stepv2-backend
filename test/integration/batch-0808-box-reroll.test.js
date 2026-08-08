// Batch 2026-08-08 — Item 11: rewarded-ad mystery box reroll (once per roll).
//
// Local/staging escape hatch for the SSV signature check. MUST be set before
// `./setup` (and therefore src/app.js -> economy/adRewards.js) is required:
// ADMOB_SSV_SKIP_VERIFY is read at module load, unlike ADS_BOX_REROLL_ENABLED
// which is a true call-time kill switch.
process.env.ADMOB_SSV_SKIP_VERIFY = "true";

const assert = require("node:assert/strict");
const { describe, it, before, beforeEach, afterEach, after } = require("node:test");
const {
  cleanDatabase,
  prisma,
  request,
  getSharedServer,
} = require("./setup");

let server;
let nextAppleId = 0;

const ADS_FEATURES = {
  "X-Client-Features": "characters,jammer,powerups2,powerups3,powerups4,powerups5,ads",
};
// A build that renders powerups but cannot show a rewarded ad.
const NO_ADS_FEATURES = {
  "X-Client-Features": "characters,powerups3,powerups4,powerups5",
};
const REROLL_KIND = "box_reroll";
const EXTRA_SPIN_KIND = "extra_daily_spin";

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function createUser(displayName) {
  const appleId = `apple-reroll-${++nextAppleId}`;
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
  // Pin the stored timezone so the server-derived local date is deterministic
  // and matches `today()` (which is the UTC date) for the whole test run.
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

async function createActiveRace(alice, bob) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Reroll Test",
      targetSteps: 200000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 5000,
    },
    token: alice.token,
  });
  const raceId = (await createRes.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: [bob.userId] },
    token: alice.token,
  });
  await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
    body: { accept: true },
    token: bob.token,
  });
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

// A powerup as it exists AFTER a mystery box has been opened: HELD, with a
// concrete type + rarity and a configVersion stamp.
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

// A real, unopened MYSTERY_BOX row, openable through POST .../open.
async function seedMysteryBox(raceId, user) {
  const participant = await prisma.raceParticipant.findFirst({
    where: { raceId, userId: user.userId },
  });
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: participant.id,
      userId: user.userId,
      type: "MYSTERY_BOX",
      status: "MYSTERY_BOX",
      earnedAtSteps: Math.floor(Math.random() * 1_000_000),
    },
  });
}

async function seedGrant(userId, kind, grantedDate, extra = {}) {
  return prisma.adRewardGrant.create({
    data: {
      userId,
      transactionId: `txn-${kind}-${userId}-${Math.random()}`,
      rewardKind: kind,
      grantedDate,
      ...extra,
    },
  });
}

async function reroll(token, raceId, powerupId, headers = ADS_FEATURES) {
  const res = await request(
    server.baseUrl,
    "POST",
    `/races/${raceId}/powerups/${powerupId}/reroll`,
    { token, headers }
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

describe("Batch 2026-08-08 item 11 — rewarded-ad box reroll", () => {
  let alice;
  let bob;
  let raceId;

  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    process.env.ADS_BOX_REROLL_ENABLED = "true";
    alice = await createUser("Alice");
    bob = await createUser("Bob");
    await makeFriends(alice, bob);
    raceId = await createActiveRace(alice, bob);
  });

  afterEach(() => {
    delete process.env.ADS_BOX_REROLL_ENABLED;
  });

  after(async () => {
    delete process.env.ADMOB_SSV_SKIP_VERIFY;
  });

  // ── Happy path ───────────────────────────────────────────────────────────
  it("rerolls the same row, restamps configVersion, stamps rerolledAt, consumes the grant", async () => {
    const powerup = await seedOpenedPowerup(raceId, alice);
    const grant = await seedGrant(alice.userId, REROLL_KIND, today());

    // Control: a genuine box open through the real handler stamps the CURRENT
    // balance-config version. The reroll must land on the same value.
    const box = await seedMysteryBox(raceId, alice);
    const openRes = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/powerups/${box.id}/open`,
      { token: alice.token, headers: ADS_FEATURES }
    );
    assert.equal(openRes.status, 200);
    const control = await prisma.racePowerup.findUnique({ where: { id: box.id } });

    const { status, body } = await reroll(alice.token, raceId, powerup.id);
    assert.equal(status, 200, JSON.stringify(body));

    // Exact contract shape.
    assert.deepEqual(Object.keys(body).sort(), ["id", "rarity", "rerolled", "type"]);
    assert.equal(body.id, powerup.id);
    assert.equal(body.rerolled, true);
    assert.ok(body.type, "a type is returned");
    assert.ok(body.rarity, "a rarity is returned");

    const row = await prisma.racePowerup.findUnique({ where: { id: powerup.id } });
    assert.equal(row.id, powerup.id, "same RacePowerup row, not a new one");
    assert.equal(row.type, body.type, "new type is PERSISTED");
    assert.equal(row.rarity, body.rarity, "new rarity is PERSISTED");
    assert.equal(row.status, "HELD");
    assert.ok(row.rerolledAt instanceof Date, "rerolledAt stamped");
    assert.notEqual(row.configVersion, 999999, "configVersion RESTAMPED");
    assert.equal(
      row.configVersion,
      control.configVersion,
      "restamped to the same version a fresh open would stamp"
    );

    const consumed = await prisma.adRewardGrant.findUnique({ where: { id: grant.id } });
    assert.ok(consumed.consumedAt, "grant consumedAt is set");

    // Exactly one row for this participant kept its identity (no duplicate mint).
    const rows = await prisma.racePowerup.findMany({
      where: { raceId, userId: alice.userId },
    });
    assert.equal(rows.length, 2, "the seeded powerup + the control box, nothing new");
  });

  // ── Once per roll ────────────────────────────────────────────────────────
  it("second reroll on the same powerup -> 409 ALREADY_REROLLED", async () => {
    const powerup = await seedOpenedPowerup(raceId, alice);
    await seedGrant(alice.userId, REROLL_KIND, today());
    const first = await reroll(alice.token, raceId, powerup.id);
    assert.equal(first.status, 200, JSON.stringify(first.body));

    // A second verified watch does not buy a second reroll of the same roll.
    const grant2 = await seedGrant(alice.userId, REROLL_KIND, today());
    const second = await reroll(alice.token, raceId, powerup.id);
    assert.equal(second.status, 409);
    assert.equal(second.body.code, "ALREADY_REROLLED");

    const stillThere = await prisma.adRewardGrant.findUnique({
      where: { id: grant2.id },
    });
    assert.equal(stillThere.consumedAt, null, "the credit is NOT burned on a 409");
  });

  // ── Grant requirements ───────────────────────────────────────────────────
  it("no grant -> 409 AD_NOT_VERIFIED", async () => {
    const powerup = await seedOpenedPowerup(raceId, alice);
    const { status, body } = await reroll(alice.token, raceId, powerup.id);
    assert.equal(status, 409);
    assert.equal(body.code, "AD_NOT_VERIFIED");

    const row = await prisma.racePowerup.findUnique({ where: { id: powerup.id } });
    assert.equal(row.rerolledAt, null, "nothing stamped");
    assert.equal(row.type, "PROTEIN_SHAKE", "roll untouched");
  });

  it("an already-consumed grant -> 409 AD_NOT_VERIFIED", async () => {
    const powerup = await seedOpenedPowerup(raceId, alice);
    await seedGrant(alice.userId, REROLL_KIND, today(), { consumedAt: new Date() });
    const { status, body } = await reroll(alice.token, raceId, powerup.id);
    assert.equal(status, 409);
    assert.equal(body.code, "AD_NOT_VERIFIED");
  });

  it("a grant for a different local date -> 409 AD_NOT_VERIFIED", async () => {
    const powerup = await seedOpenedPowerup(raceId, alice);
    const stale = await seedGrant(alice.userId, REROLL_KIND, "2020-01-01");
    const { status, body } = await reroll(alice.token, raceId, powerup.id);
    assert.equal(status, 409);
    assert.equal(body.code, "AD_NOT_VERIFIED");
    const untouched = await prisma.adRewardGrant.findUnique({ where: { id: stale.id } });
    assert.equal(untouched.consumedAt, null);
  });

  it("another user's grant -> 409 AD_NOT_VERIFIED", async () => {
    const powerup = await seedOpenedPowerup(raceId, alice);
    await seedGrant(bob.userId, REROLL_KIND, today());
    const { status, body } = await reroll(alice.token, raceId, powerup.id);
    assert.equal(status, 409);
    assert.equal(body.code, "AD_NOT_VERIFIED");
  });

  // ── Eligibility guards ───────────────────────────────────────────────────
  it("upgradeLevel > 0 is rejected and the grant survives", async () => {
    const powerup = await seedOpenedPowerup(raceId, alice, { upgradeLevel: 1 });
    const grant = await seedGrant(alice.userId, REROLL_KIND, today());
    const { status, body } = await reroll(alice.token, raceId, powerup.id);
    assert.equal(status, 400);
    assert.equal(body.code, "NOT_HELD");
    const row = await prisma.racePowerup.findUnique({ where: { id: powerup.id } });
    assert.equal(row.type, "PROTEIN_SHAKE");
    assert.equal(row.rerolledAt, null);
    const g = await prisma.adRewardGrant.findUnique({ where: { id: grant.id } });
    assert.equal(g.consumedAt, null, "an ineligible powerup must not burn the credit");
  });

  it("rarity null (stash-redeemed) -> 400 NOT_HELD", async () => {
    const powerup = await seedOpenedPowerup(raceId, alice, { rarity: null });
    await seedGrant(alice.userId, REROLL_KIND, today());
    const { status, body } = await reroll(alice.token, raceId, powerup.id);
    assert.equal(status, 400);
    assert.equal(body.code, "NOT_HELD");
  });

  it("status USED -> 400 NOT_HELD", async () => {
    const powerup = await seedOpenedPowerup(raceId, alice, {
      status: "USED",
      usedAt: new Date(),
    });
    await seedGrant(alice.userId, REROLL_KIND, today());
    const { status, body } = await reroll(alice.token, raceId, powerup.id);
    assert.equal(status, 400);
    assert.equal(body.code, "NOT_HELD");
  });

  it("status MYSTERY_BOX (unopened) -> 400 NOT_HELD", async () => {
    const box = await seedMysteryBox(raceId, alice);
    await seedGrant(alice.userId, REROLL_KIND, today());
    const { status, body } = await reroll(alice.token, raceId, box.id);
    assert.equal(status, 400);
    assert.equal(body.code, "NOT_HELD");
  });

  it("race COMPLETED -> 400", async () => {
    const powerup = await seedOpenedPowerup(raceId, alice);
    await seedGrant(alice.userId, REROLL_KIND, today());
    await prisma.race.update({
      where: { id: raceId },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    const { status } = await reroll(alice.token, raceId, powerup.id);
    assert.equal(status, 400);
  });

  it("another user's powerup -> 403", async () => {
    const powerup = await seedOpenedPowerup(raceId, alice);
    await seedGrant(bob.userId, REROLL_KIND, today());
    const { status } = await reroll(bob.token, raceId, powerup.id);
    assert.equal(status, 403);
    const row = await prisma.racePowerup.findUnique({ where: { id: powerup.id } });
    assert.equal(row.rerolledAt, null);
  });

  // ── Feed suppression ─────────────────────────────────────────────────────
  it("writes a POWERUP_REROLLED audit row that never surfaces in either feed", async () => {
    const powerup = await seedOpenedPowerup(raceId, alice);
    await seedGrant(alice.userId, REROLL_KIND, today());
    const { status } = await reroll(alice.token, raceId, powerup.id);
    assert.equal(status, 200);

    const audit = await prisma.racePowerupEvent.findMany({
      where: { raceId, eventType: "POWERUP_REROLLED" },
    });
    assert.equal(audit.length, 1, "one POWERUP_REROLLED audit row");

    const feedRes = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, {
      token: alice.token,
      headers: ADS_FEATURES,
    });
    const feed = await feedRes.json();
    assert.ok(
      !(feed.events || []).some((e) => e.eventType === "POWERUP_REROLLED"),
      "hidden from getRaceFeed"
    );

    for (const kind of ["", "?kind=SYSTEM"]) {
      const msgRes = await request(
        server.baseUrl,
        "GET",
        `/races/${raceId}/messages${kind}`,
        { token: alice.token, headers: ADS_FEATURES }
      );
      const page = await msgRes.json();
      assert.ok(
        !(page.messages || []).some((m) => m.eventType === "POWERUP_REROLLED"),
        `hidden from getRaceMessages ${kind || "(merged)"}`
      );
    }
  });

  // ── Kill switch + client-feature gating ──────────────────────────────────
  it("kill switch OFF (default): endpoint refuses and boxReroll is absent", async () => {
    delete process.env.ADS_BOX_REROLL_ENABLED;
    const powerup = await seedOpenedPowerup(raceId, alice);
    const grant = await seedGrant(alice.userId, REROLL_KIND, today());

    const { status } = await reroll(alice.token, raceId, powerup.id);
    assert.ok(status >= 400, `endpoint refuses when disabled (got ${status})`);

    const row = await prisma.racePowerup.findUnique({ where: { id: powerup.id } });
    assert.equal(row.rerolledAt, null);
    const g = await prisma.adRewardGrant.findUnique({ where: { id: grant.id } });
    assert.equal(g.consumedAt, null);

    const { body } = await progress(alice.token, raceId, ADS_FEATURES);
    assert.ok(body.progress.powerupData, "powerupData still present");
    assert.equal(
      "boxReroll" in body.progress.powerupData,
      false,
      "boxReroll absent when the kill switch is off"
    );
  });

  it("kill switch ON + client declares ads -> boxReroll: true", async () => {
    const { body } = await progress(alice.token, raceId, ADS_FEATURES);
    assert.equal(body.progress.powerupData.boxReroll, true);
  });

  it("kill switch ON + client does NOT declare ads -> boxReroll absent", async () => {
    const { body } = await progress(alice.token, raceId, NO_ADS_FEATURES);
    assert.ok(body.progress.powerupData, "powerupData still present");
    assert.equal("boxReroll" in body.progress.powerupData, false);
  });

  it("FROZEN CLIENT: no X-Client-Features -> pre-existing powerupData shape, no boxReroll", async () => {
    const { status, body } = await progress(alice.token, raceId);
    assert.equal(status, 200);
    const pd = body.progress.powerupData;
    assert.ok(pd, "powerupData present for a header-less client");
    assert.equal("boxReroll" in pd, false);
    // The shape a frozen binary already reads must be intact.
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

  // ── Cross-consumption (the headline catch) ───────────────────────────────
  describe("SSV prefix -> rewardKind mapping", () => {
    async function ssv(userId, customData, txn) {
      const qs = new URLSearchParams({
        transaction_id: txn,
        user_id: userId,
        ad_unit: "ad-unit-reroll",
        custom_data: customData,
      }).toString();
      const res = await request(server.baseUrl, "GET", `/ads/ssv?${qs}`);
      return { status: res.status, body: await res.json() };
    }

    it("a box_reroll: watch mints rewardKind 'box_reroll', NOT extra_daily_spin", async () => {
      const date = today();
      const r = await ssv(alice.userId, `box_reroll:${alice.userId}:${date}`, "txn-rr-1");
      assert.equal(r.status, 200, JSON.stringify(r.body));

      const grants = await prisma.adRewardGrant.findMany({
        where: { userId: alice.userId },
      });
      assert.equal(grants.length, 1);
      assert.equal(
        grants[0].rewardKind,
        REROLL_KIND,
        "the reroll prefix must NOT fall through to the extra_daily_spin default"
      );
      assert.equal(grants[0].grantedDate, date, "grantedDate comes from custom_data");
      assert.equal(grants[0].shopItemId, null, "the date is not a sku");
    });

    it("a reroll grant is NOT consumable as an extra daily spin", async () => {
      const date = today();
      await ssv(alice.userId, `box_reroll:${alice.userId}:${date}`, "txn-rr-2");

      // Take today's free daily box first, so the only thing standing between
      // the caller and an extra spin is the grant kind.
      const claim = await request(server.baseUrl, "POST", "/daily-reward/claim", {
        body: { localDate: date },
        token: alice.token,
        headers: ADS_FEATURES,
      });
      assert.equal(claim.status, 200, await claim.text());

      const extra = await request(
        server.baseUrl,
        "POST",
        "/daily-reward/claim-extra-box",
        { body: { localDate: date }, token: alice.token, headers: ADS_FEATURES }
      );
      const extraBody = await extra.json();
      assert.equal(extra.status, 409, JSON.stringify(extraBody));
      assert.equal(extraBody.code, "AD_NOT_VERIFIED");

      const grant = await prisma.adRewardGrant.findFirst({
        where: { userId: alice.userId, rewardKind: REROLL_KIND },
      });
      assert.equal(grant.consumedAt, null, "the extra-spin path did not eat it");

      // …and it still buys the reroll it was minted for.
      const powerup = await seedOpenedPowerup(raceId, alice);
      const { status } = await reroll(alice.token, raceId, powerup.id);
      assert.equal(status, 200);
    });

    it("an extra-spin grant does NOT satisfy a reroll", async () => {
      const date = today();
      // A BARE date is the shipped extra-spin custom_data format.
      const r = await ssv(alice.userId, date, "txn-spin-1");
      assert.equal(r.status, 200);
      const minted = await prisma.adRewardGrant.findFirst({
        where: { userId: alice.userId },
      });
      assert.equal(
        minted.rewardKind,
        EXTRA_SPIN_KIND,
        "bare-date custom_data must keep minting extra_daily_spin (frozen clients)"
      );

      const powerup = await seedOpenedPowerup(raceId, alice);
      const { status, body } = await reroll(alice.token, raceId, powerup.id);
      assert.equal(status, 409);
      assert.equal(body.code, "AD_NOT_VERIFIED");

      const after = await prisma.adRewardGrant.findUnique({ where: { id: minted.id } });
      assert.equal(after.consumedAt, null, "the reroll path did not eat the spin credit");
    });
  });
});
