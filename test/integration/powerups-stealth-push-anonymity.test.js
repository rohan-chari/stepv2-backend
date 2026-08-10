const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const {
  registerNotificationHandlers,
} = require("../../src/modules/notifications/notificationHandlers");
const { eventBus } = require("../../src/shared/events/eventBus");
const { balanceConfig } = require("../../src/modules/economy/balanceConfig");
const {
  defaultConfig,
} = require("../../src/modules/economy/balanceConfig.defaults");

// ---------------------------------------------------------------------------
// Batch 2026-08-09 item 11 — Stealth Mode must not leak the attacker's name in
// a PUSH NOTIFICATION.
//
// The in-app feed, race messages and the leaderboard have redacted a stealthed
// player to "???" for a long time (getRaceFeed / getRaceMessages /
// raceIllusions). The two push handlers did not, so the single thing Stealth
// Mode sells was leaking out of the app on every attack — and, worse, on the
// high-multiplier alert, which fires precisely when a stealthed player has
// stacked the buffs they are hiding.
//
// End-to-end, following the powerup-attack-push-durations precedent: the real
// /use HTTP endpoint emits on the singleton event bus and the real notification
// handler composes the body against a captured stub. The FAIL-SAFE direction is
// pinned too — an emit without the flag must show the real name, never
// anonymize by accident (that would be a gameplay change, not a bug fix).
// ---------------------------------------------------------------------------

let server;
let nextAppleId = 0;
let earnCounter = 0;

const captured = [];
const tokenOwner = new Map();

function pushStub() {
  return {
    async sendNotification(args) {
      captured.push(args);
      return { success: true };
    },
  };
}

async function waitForPush(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = captured.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

async function createUser(displayName) {
  const appleId = `apple-stealthpush-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    body: { displayName },
    token: body.sessionToken,
  });
  return { userId: body.user.id, token: body.sessionToken, displayName };
}

async function giveDeviceToken(userId, token) {
  await prisma.deviceToken.create({ data: { userId, token, platform: "ios" } });
  tokenOwner.set(token, userId);
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

async function createActiveRace(creator, others) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Stealth Push Test",
      targetSteps: 200000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 5000,
    },
    token: creator.token,
  });
  const raceId = (await createRes.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: others.map((o) => o.userId) },
    token: creator.token,
  });
  for (const o of others) {
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: o.token,
    });
  }
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: creator.token,
  });
  const start = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await prisma.race.update({
    where: { id: raceId },
    data: { startedAt: start, endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
  });
  await prisma.raceParticipant.updateMany({
    where: { raceId },
    data: { joinedAt: start },
  });
  return raceId;
}

async function giveHeldPowerup(raceId, userId, type) {
  const p = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: p.id,
      userId,
      type,
      rarity: "COMMON",
      status: "HELD",
      earnedAtSteps: ++earnCounter,
    },
  });
}

// Put a live STEALTH_MODE on the caster, exactly as a real cast would.
async function stealthUp(raceId, userId) {
  const p = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  const backing = await prisma.racePowerup.create({
    data: {
      raceId,
      participantId: p.id,
      userId,
      type: "STEALTH_MODE",
      rarity: "UNCOMMON",
      status: "USED",
      earnedAtSteps: ++earnCounter,
    },
  });
  return prisma.raceActiveEffect.create({
    data: {
      raceId,
      targetParticipantId: p.id,
      targetUserId: userId,
      sourceUserId: userId,
      powerupId: backing.id,
      type: "STEALTH_MODE",
      status: "ACTIVE",
      startsAt: new Date(Date.now() - 60 * 1000),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      metadata: {},
    },
  });
}

async function usePowerup(token, raceId, powerupId, body = {}) {
  return request(
    server.baseUrl,
    "POST",
    `/races/${raceId}/powerups/${powerupId}/use`,
    { body, token, headers: { "X-Client-Features": "characters,powerups3,powerups4,powerups5" } }
  );
}

function attackPushTo(userId) {
  return (c) =>
    c.payload &&
    c.payload.type === "POWERUP_USED" &&
    tokenOwner.get(c.deviceToken) === userId;
}

describe("stealthed attacks never name the attacker in a push", () => {
  before(async () => {
    server = await getSharedServer();
    registerNotificationHandlers({
      eventBus,
      apnsService: pushStub(),
      fcmService: pushStub(),
      logger: { warn() {}, error() {}, info() {}, log() {} },
    });
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
    captured.length = 0;
    tokenOwner.clear();
  });

  async function pair() {
    const attacker = await createUser("SneakySteve");
    const victim = await createUser("VictimVic");
    await makeFriends(attacker, victim);
    const raceId = await createActiveRace(attacker, [victim]);
    await giveDeviceToken(victim.userId, `tok-victim-${nextAppleId}`);
    return { attacker, victim, raceId };
  }

  // ── the attack push ───────────────────────────────────────────────────────

  it("a STEALTHED Leg Cramp push says ??? and never the display name", async () => {
    const { attacker, victim, raceId } = await pair();
    await stealthUp(raceId, attacker.userId);

    const cramp = await giveHeldPowerup(raceId, attacker.userId, "LEG_CRAMP");
    const res = await usePowerup(attacker.token, raceId, cramp.id, {
      targetUserId: victim.userId,
    });
    assert.equal(res.status, 200);

    const push = await waitForPush(attackPushTo(victim.userId));
    assert.ok(push, "victim got an attack push");
    assert.match(push.body, /\?\?\?/, "attacker is redacted");
    assert.ok(
      !push.body.includes("SneakySteve"),
      `display name leaked: ${push.body}`
    );
    // The victim must still learn WHAT hit them and for how long — only WHO is
    // hidden.
    assert.match(push.body, /Leg Cramp/);
    assert.match(push.body, /frozen for 1 hour/);
  });

  it("an UN-stealthed attack still names the attacker (no over-redaction)", async () => {
    const { attacker, victim, raceId } = await pair();

    const cramp = await giveHeldPowerup(raceId, attacker.userId, "LEG_CRAMP");
    const res = await usePowerup(attacker.token, raceId, cramp.id, {
      targetUserId: victim.userId,
    });
    assert.equal(res.status, 200);

    const push = await waitForPush(attackPushTo(victim.userId));
    assert.ok(push);
    assert.match(push.body, /SneakySteve/);
    assert.ok(!push.body.includes("???"));
  });

  // NOTE: deliberately does NOT call cleanDatabase() between iterations. The
  // beforeEach hook owns truncation; truncating from inside a test body
  // deadlocks (40P01) against the rest of the suite file when the runner
  // interleaves. Each iteration just builds a fresh race with fresh users —
  // `nextAppleId` keeps identities unique without touching the DB wholesale.
  it("redaction covers the other allowlisted push types too", async () => {
    for (const type of ["WRONG_TURN", "SHORTCUT"]) {
      captured.length = 0;

      const { attacker, victim, raceId } = await pair();
      await stealthUp(raceId, attacker.userId);
      // Shortcut steals from the target, so give the victim something to take.
      const p = await prisma.raceParticipant.findFirst({
        where: { raceId, userId: victim.userId },
      });
      await prisma.raceParticipant.update({
        where: { id: p.id },
        data: { totalSteps: 9000 },
      });

      const pw = await giveHeldPowerup(raceId, attacker.userId, type);
      const res = await usePowerup(attacker.token, raceId, pw.id, {
        targetUserId: victim.userId,
      });
      assert.equal(res.status, 200, `${type} should apply`);

      const push = await waitForPush(attackPushTo(victim.userId));
      assert.ok(push, `${type}: victim got a push`);
      assert.ok(
        !push.body.includes("SneakySteve"),
        `${type} leaked the name: ${push.body}`
      );
      assert.match(push.body, /\?\?\?/, `${type} should redact`);
    }
  });

  // An expired-but-still-ACTIVE stealth row (lazy expiry hasn't run) must NOT
  // anonymize — the buff is over, so the name is public again. This is the same
  // liveness rule every other stealth read uses.
  it("an EXPIRED stealth row does not anonymize", async () => {
    const { attacker, victim, raceId } = await pair();
    const p = await prisma.raceParticipant.findFirst({
      where: { raceId, userId: attacker.userId },
    });
    const backing = await giveHeldPowerup(raceId, attacker.userId, "STEALTH_MODE");
    await prisma.raceActiveEffect.create({
      data: {
        raceId,
        targetParticipantId: p.id,
        targetUserId: attacker.userId,
        sourceUserId: attacker.userId,
        powerupId: backing.id,
        type: "STEALTH_MODE",
        status: "ACTIVE",
        startsAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() - 60 * 1000),
        metadata: {},
      },
    });

    const cramp = await giveHeldPowerup(raceId, attacker.userId, "LEG_CRAMP");
    await usePowerup(attacker.token, raceId, cramp.id, {
      targetUserId: victim.userId,
    });

    const push = await waitForPush(attackPushTo(victim.userId));
    assert.ok(push);
    assert.match(push.body, /SneakySteve/, "an expired stealth must not redact");
  });

  // ── fail-safe: an emit WITHOUT the flag shows the real name ────────────────

  it("an emit with no `stealthed` field defaults to the VISIBLE name", async () => {
    const { attacker, victim, raceId } = await pair();

    // Emit by hand, omitting `stealthed` entirely — this is what a future emit
    // site that forgets to thread the flag would produce. It must degrade to
    // today's behavior (real name), never to silent anonymization.
    eventBus.emit("POWERUP_USED", {
      raceId,
      userId: attacker.userId,
      powerupType: "LEG_CRAMP",
      targetUserId: victim.userId,
      upgradeLevel: 0,
    });

    const push = await waitForPush(attackPushTo(victim.userId));
    assert.ok(push, "the push still fires");
    assert.match(push.body, /SneakySteve/);
    assert.ok(!push.body.includes("???"));
  });

  // ── the high-multiplier push (second leak) ────────────────────────────────

  function multiplierPushTo(userId) {
    return (c) =>
      c.payload &&
      c.payload.type === "HIGH_MULTIPLIER_ALERT" &&
      tokenOwner.get(c.deviceToken) === userId;
  }

  it("a stealthed player's high-multiplier alert is anonymized", async () => {
    const { attacker, victim, raceId } = await pair();

    eventBus.emit("HIGH_MULTIPLIER_ALERT", {
      raceId,
      raceName: "Stealth Push Test",
      actorUserId: attacker.userId,
      actorName: attacker.displayName,
      multiplier: 4,
      recipientUserIds: [victim.userId],
      stealthed: true,
    });

    const push = await waitForPush(multiplierPushTo(victim.userId));
    assert.ok(push, "rival got the multiplier push");
    assert.match(push.body, /\?\?\?/);
    assert.ok(
      !push.body.includes("SneakySteve"),
      `high-multiplier push leaked the name: ${push.body}`
    );
    // The number itself is still useful intel and stays.
    assert.match(push.body, /4x/);
  });

  it("an un-stealthed high-multiplier alert still names the actor", async () => {
    const { attacker, victim, raceId } = await pair();

    eventBus.emit("HIGH_MULTIPLIER_ALERT", {
      raceId,
      raceName: "Stealth Push Test",
      actorUserId: attacker.userId,
      actorName: attacker.displayName,
      multiplier: 4,
      recipientUserIds: [victim.userId],
    });

    const push = await waitForPush(multiplierPushTo(victim.userId));
    assert.ok(push);
    assert.match(push.body, /SneakySteve/);
    assert.ok(!push.body.includes("???"));
  });
});

// ---------------------------------------------------------------------------
// EMIT-SITE COVERAGE (code review, batch 2026-08-09).
// ---------------------------------------------------------------------------
//
// Only the main path was exercised end to end, which is precisely how a
// ReferenceError on the Mystery Potion path shipped: `applyMysteryPotion` is
// MODULE-scope and referenced `casterStealthed`, a const declared inside
// `buildUsePowerup` — no closure relationship, so an enemy roll threw a 500.
//
// IMPORTANT FINDING that shapes these tests: of the six emit sites, only TWO
// can produce a push at all today. The handler returns early unless the payload
// carries a targetUserId AND the powerupType is in its allowlist
// (LEG_CRAMP, RED_CARD, SHORTCUT, WRONG_TURN, SIGNAL_JAMMER, LEECH, HITCHHIKE,
// QUICKSAND). So:
//   * main path + Quicksand  -> a real push; assert the BODY.
//   * Uprising / Rally Flag  -> no targetUserId, no push.
//   * Power Outage / Potion  -> type not allowlisted, no push.
// For those four, asserting a push body would be asserting a thing that cannot
// exist. What IS meaningful — and what actually guards the blocker — is that
// the cast SUCCEEDS (no ReferenceError) and the emitted payload carries the
// flag, so the day one of those types joins the allowlist it is already
// correct. Those are asserted off the event bus.

// Capture POWERUP_USED payloads straight off the bus, alongside the push stub.
//
// ONE listener registered once, never removed: this project's eventBus is a
// tiny custom emitter with `on`/`emit` and NO `off`, so a per-test subscribe
// would leak a handler per test. The array is cleared in beforeEach instead.
const emittedPowerupUsed = [];
let powerupUsedListenerRegistered = false;
function registerPowerupUsedCapture() {
  if (powerupUsedListenerRegistered) return;
  eventBus.on("POWERUP_USED", (data) => emittedPowerupUsed.push(data));
  powerupUsedListenerRegistered = true;
}

function emitsOfType(powerupType) {
  return emittedPowerupUsed.filter((e) => e.powerupType === powerupType);
}

async function pinPotionPool(outcome) {
  const config = defaultConfig();
  config.mysteryPotion = { pool: [{ outcome, weight: 1 }] };
  await prisma.balanceConfig.updateMany({
    where: { active: true },
    data: { active: false },
  });
  // `version` is unique and balance_config is NOT truncated between suites, so
  // a fixed version collides with whatever an earlier file left behind.
  const maxVersion = await prisma.balanceConfig.aggregate({ _max: { version: true } });
  await prisma.balanceConfig.create({
    data: {
      version: (maxVersion._max.version || 0) + 1,
      config,
      active: true,
      note: "stealth push emit-site test",
    },
  });
  balanceConfig.bustCache();
  // bustCache alone is NOT enough for this path. applyMysteryPotion reads the
  // pool through `getConfigSync()`, which cannot hit the DB — right after a bust
  // it falls back to the CODE DEFAULTS until an async load repopulates the
  // cache. So force that load here, or the pinned pool is silently ignored and
  // the test rolls against the default weights.
  await balanceConfig.getSnapshot();
}

async function restoreBalanceConfig() {
  await prisma.balanceConfig.updateMany({
    where: { active: true },
    data: { active: false },
  });
  balanceConfig.bustCache();
  await balanceConfig.getSnapshot();
}

describe("every POWERUP_USED emit site threads the stealth flag", () => {
  before(async () => {
    server = await getSharedServer();
    registerNotificationHandlers({
      eventBus,
      apnsService: pushStub(),
      fcmService: pushStub(),
      logger: { warn() {}, error() {}, info() {}, log() {} },
    });
    registerPowerupUsedCapture();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
    captured.length = 0;
    tokenOwner.clear();
    emittedPowerupUsed.length = 0;
  });

  after(async () => {
    await restoreBalanceConfig();
  });

  // Rally Flag needs a team race; every other case uses the solo helper above.
  async function createTeamRaceFor(a, mate, foeA, foeB) {
    const TEAM = {
      "X-Client-Features": "characters,team_races,powerups3,powerups4,powerups5",
    };
    const createRes = await request(server.baseUrl, "POST", "/races", {
      body: {
        name: "Stealth Team Race",
        targetSteps: 200000,
        maxDurationDays: 7,
        isTeamRace: true,
        teamSize: 2,
        isPublic: true,
        powerupsEnabled: true,
        powerupStepInterval: 5000,
      },
      token: a.token,
      headers: TEAM,
    });
    const raceId = (await createRes.json()).race.id;
    for (const o of [mate, foeA, foeB]) await makeFriends(a, o);
    // Client features are PERSISTED per user from request headers, and the
    // invite endpoint rejects an invitee who has never advertised `team_races`
    // (INVITEE_NEEDS_UPDATE). The shared createUser helper in this file signs up
    // without team headers, so each invitee makes one authenticated call with
    // them before the invite goes out.
    for (const o of [mate, foeA, foeB]) {
      await request(server.baseUrl, "GET", "/auth/me", {
        token: o.token,
        headers: TEAM,
      });
    }
    const inv = await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
      body: { inviteeIds: [mate.userId, foeA.userId, foeB.userId] },
      token: a.token,
      headers: TEAM,
    });
    assert.equal(inv.status, 200, `invite: ${await inv.text()}`);
    for (const [user, team] of [
      [mate, "TEAM_A"],
      [foeA, "TEAM_B"],
      [foeB, "TEAM_B"],
    ]) {
      const r = await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
        body: { accept: true, team },
        token: user.token,
        headers: TEAM,
      });
      assert.equal(r.status, 200, `accept for ${team}: ${await r.text()}`);
    }
    const startRes = await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
      token: a.token,
      headers: TEAM,
    });
    assert.equal(startRes.status, 200);
    const start = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await prisma.race.update({
      where: { id: raceId },
      data: { startedAt: start, endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId },
      data: { joinedAt: start },
    });
    return raceId;
  }

  async function stealthedCaster(opponentCount = 1) {
    const attacker = await createUser("SneakySteve");
    const others = [];
    for (let i = 0; i < opponentCount; i++) {
      others.push(await createUser(`Victim${i}`));
    }
    for (const o of others) await makeFriends(attacker, o);
    const raceId = await createActiveRace(attacker, others);
    for (const o of others) {
      await giveDeviceToken(o.userId, `tok-${o.userId}`);
    }
    await stealthUp(raceId, attacker.userId);
    return { attacker, others, raceId };
  }

  // ── the two sites that really push ────────────────────────────────────────

  it("QUICKSAND (per-victim ternary emit) anonymizes the push body", async () => {
    const { attacker, others, raceId } = await stealthedCaster(2);
    const pw = await giveHeldPowerup(raceId, attacker.userId, "QUICKSAND");

    const res = await usePowerup(attacker.token, raceId, pw.id, {
      targetUserIds: others.map((o) => o.userId),
    });
    assert.equal(res.status, 200, await res.text?.().catch(() => ""));

    for (const victim of others) {
      const push = await waitForPush(attackPushTo(victim.userId));
      assert.ok(push, `victim ${victim.userId} got a push`);
      assert.match(push.body, /\?\?\?/);
      assert.ok(
        !push.body.includes("SneakySteve"),
        `quicksand leaked the name: ${push.body}`
      );
    }
  });

  // ── the four sites that cannot push today ─────────────────────────────────

  it("MYSTERY_POTION enemy roll succeeds and carries the flag (the 500 regression)", async () => {
    // This is the blocker test. Before the ctx fix the cast threw a
    // ReferenceError -> 500, because applyMysteryPotion is module-scope and
    // `casterStealthed` lives inside buildUsePowerup. Pinning the pool makes the
    // enemy branch deterministic instead of a 25%-weighted coin flip.
    await pinPotionPool("LEG_CRAMP");
    try {
      const { attacker, raceId } = await stealthedCaster(1);
      const pw = await giveHeldPowerup(raceId, attacker.userId, "MYSTERY_POTION");

      const res = await usePowerup(attacker.token, raceId, pw.id);
      assert.equal(res.status, 200, "an enemy potion roll must not 500");
      const body = await res.json();
      assert.equal(body.result.rolled, "LEG_CRAMP", "the enemy branch ran");

      const [emit] = emitsOfType("MYSTERY_POTION");
      assert.ok(emit, "the potion emitted POWERUP_USED");
      assert.equal(emit.stealthed, true, "the potion emit carries the flag");
    } finally {
      await restoreBalanceConfig();
    }
  });

  it("POWER_OUTAGE (AoE per-victim emit) carries the flag on every victim", async () => {
    const { attacker, raceId } = await stealthedCaster(2);
    const pw = await giveHeldPowerup(raceId, attacker.userId, "POWER_OUTAGE");

    const res = await usePowerup(attacker.token, raceId, pw.id);
    assert.equal(res.status, 200);

    const emits = emitsOfType("POWER_OUTAGE");
    assert.ok(emits.length > 0, "power outage emitted per victim");
    for (const e of emits) {
      assert.equal(e.stealthed, true, "every AoE victim emit carries the flag");
    }
  });

  it("UPRISING (self-buff emit) carries the flag", async () => {
    {
      // Four runners so the caster sits in the bottom half and the cast is legal.
      const { attacker, others, raceId } = await stealthedCaster(3);
      const p = await prisma.raceParticipant.findFirst({
        where: { raceId, userId: attacker.userId },
      });
      await prisma.raceParticipant.update({
        where: { id: p.id },
        data: { totalSteps: 10 },
      });
      let steps = 9000;
      for (const o of others) {
        const op = await prisma.raceParticipant.findFirst({
          where: { raceId, userId: o.userId },
        });
        await prisma.raceParticipant.update({
          where: { id: op.id },
          data: { totalSteps: steps },
        });
        steps -= 1000;
      }

      const pw = await giveHeldPowerup(raceId, attacker.userId, "UPRISING");
      const res = await usePowerup(attacker.token, raceId, pw.id);
      assert.equal(res.status, 200);

      const [emit] = emitsOfType("UPRISING");
      assert.ok(emit, "uprising emitted POWERUP_USED");
      assert.equal(emit.stealthed, true);
    }
  });

  it("RALLY_FLAG (self-buff emit) carries the flag", async () => {
    {
      // Rally Flag needs a team race, so this one builds its own 2v2.
      const attacker = await createUser("SneakySteve");
      const mate = await createUser("Mate");
      const foeA = await createUser("FoeA");
      const foeB = await createUser("FoeB");
      const raceId = await createTeamRaceFor(attacker, mate, foeA, foeB);
      await stealthUp(raceId, attacker.userId);

      const pw = await giveHeldPowerup(raceId, attacker.userId, "RALLY_FLAG");
      const res = await usePowerup(attacker.token, raceId, pw.id);
      assert.equal(res.status, 200);

      const [emit] = emitsOfType("RALLY_FLAG");
      assert.ok(emit, "rally flag emitted POWERUP_USED");
      assert.equal(emit.stealthed, true);
    }
  });
});
