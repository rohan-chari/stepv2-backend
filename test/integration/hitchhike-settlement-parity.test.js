const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
// The REAL settlement entry point (the cron job's exported function). Settlement
// has no HTTP surface, so this IS its public path. Every number asserted below is
// read back through the API — the scorer is never called directly.
const { resolveExpiredRaces } = require("../../src/jobs/raceExpiry");

// ---------------------------------------------------------------------------
// §12 — HITCHHIKE display and final settlement agree for the same fixture.
//
// WHY THIS CANNOT BE A UNIT TEST. Two other guards already exist and neither
// covers this:
//   * the STRUCTURAL guard proves every assembly site CALLS applyHitchhikeCopies;
//   * the unit parity test proves the scorer is DETERMINISTIC given identical
//     inputs.
// Neither proves the settlement path invokes it with the same ARGUMENTS, MODELS
// and CLOCK the live path uses. A site could pass both while handing the scorer
// a different timezone, a different `now`, an unscoped effect model, or an
// endsAt-clamped window the live path doesn't apply — and the failure would
// surface to a user as their score visibly CHANGING the instant their race ends.
// Only running a real race to settlement can catch that.
//
// The fixture is deliberately sized so that BOTH failure modes are detectable:
//   Alice walks 2,000 and hitchhikes Bob, copying 4,000  -> pre-leech 6,000
//   Carol leeches Alice, earning floor(10,000 / 2) = 5,000 -> Alice settles at 1,000
// If settlement dropped the copy:        max(0, 2,000 - 5,000)          = 0
// If settlement applied it AFTER leech:  max(0, 2,000 - 5,000) + 4,000  = 4,000
// Only the correct ordering — copy folded into preLeechTotal BEFORE the leech
// resolution — yields 1,000.
// ---------------------------------------------------------------------------

let server;
let nextAppleId = 0;

const FEAT = {
  // team_races is needed for the mid-race forfeit case below (forfeit is a
  // team-race feature and its create path is capability-gated).
  "X-Client-Features": "characters,powerups2,powerups3,team_races",
};
const HEADERS = { ...FEAT, "X-Timezone": "UTC" };
const HOUR_MS = 60 * 60 * 1000;

async function createUser(displayName) {
  const appleId = `apple-parity-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    body: { displayName },
    token: body.sessionToken,
  });
  // TR-706: any authed request carrying the header records the user's last-seen
  // capability tokens. Without this an invite to a team race is rejected with
  // INVITEE_NEEDS_UPDATE, because the invitee has nothing recorded.
  await request(server.baseUrl, "GET", "/auth/me", {
    token: body.sessionToken,
    headers: HEADERS,
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

// Whole hourly buckets, exactly as the app uploads them, aligned to hour
// boundaries so every bucket in the effect window is CLOSED.
async function giveHourlyBucket(userId, hoursAgo, steps) {
  const periodStart = new Date(
    Math.floor((Date.now() - hoursAgo * HOUR_MS) / HOUR_MS) * HOUR_MS
  );
  await prisma.stepSample.create({
    data: {
      userId,
      periodStart,
      periodEnd: new Date(periodStart.getTime() + HOUR_MS),
      steps,
      sourceName: "healthkit",
    },
  });
}

function hourFloor(hoursAgo) {
  return new Date(
    Math.floor((Date.now() - hoursAgo * HOUR_MS) / HOUR_MS) * HOUR_MS
  );
}

async function giveHeld(raceId, userId, type) {
  const p = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: p.id,
      userId,
      type,
      rarity: "UNCOMMON",
      status: "HELD",
    },
  });
}

async function usePowerup(raceId, actor, powerupId, body) {
  return request(
    server.baseUrl,
    "POST",
    `/races/${raceId}/powerups/${powerupId}/use`,
    { body, token: actor.token, headers: HEADERS }
  );
}

async function totalsViaApi(raceId, viewer) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, {
    token: viewer.token,
    headers: HEADERS,
  });
  const body = await res.json();
  const totals = {};
  for (const p of body.progress.participants) totals[p.userId] = p.totalSteps;
  return { status: body.progress.status, totals };
}

describe("hitchhike live-vs-settlement parity — integration", () => {
  before(async () => {
    server = await getSharedServer();
  });
  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("the caster's live total survives settlement unchanged, with hitchhike ordered before leech", async () => {
    const alice = await createUser("Alice"); // hitchhikes Bob, leeched by Carol
    const bob = await createUser("Bob"); // walked on
    const carol = await createUser("Carol"); // leeches Alice
    await makeFriends(alice, bob);
    await makeFriends(alice, carol);

    const createRes = await request(server.baseUrl, "POST", "/races", {
      body: {
        name: "Parity",
        targetSteps: 500000,
        maxDurationDays: 7,
        powerupsEnabled: true,
        powerupStepInterval: 50000,
      },
      token: alice.token,
      headers: HEADERS,
    });
    const raceId = (await createRes.json()).race.id;
    await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
      body: { inviteeIds: [bob.userId, carol.userId] },
      token: alice.token,
      headers: HEADERS,
    });
    for (const user of [bob, carol]) {
      await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
        body: { accept: true },
        token: user.token,
        headers: HEADERS,
      });
    }
    await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
      token: alice.token,
      headers: HEADERS,
    });

    // Race started 12h ago in a canonical UTC tz, so live and settlement bucket
    // days identically (raceTimeZone(race, ...) resolves to UTC on both paths).
    const start = hourFloor(12);
    await prisma.race.update({
      where: { id: raceId },
      data: { startedAt: start, timezone: "UTC" },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId },
      data: { joinedAt: start },
    });

    // Steps, all inside CLOSED hourly buckets in [-4h, -2h].
    await giveHourlyBucket(bob.userId, 4, 2000); // Bob: 4,000 total, all in-window
    await giveHourlyBucket(bob.userId, 3, 2000);
    await giveHourlyBucket(alice.userId, 6, 2000); // Alice: 2,000 of her own
    await giveHourlyBucket(carol.userId, 4, 5000); // Carol: 10,000, all in-window
    await giveHourlyBucket(carol.userId, 3, 5000);

    // Alice hitchhikes Bob; Carol leeches Alice. Both through the real endpoint.
    const hh = await giveHeld(raceId, alice.userId, "HITCHHIKE");
    const hhRes = await usePowerup(raceId, alice, hh.id, {
      targetUserId: bob.userId,
    });
    assert.equal(hhRes.status, 200);

    const leech = await giveHeld(raceId, carol.userId, "LEECH");
    const leechRes = await usePowerup(raceId, carol, leech.id, {
      targetUserId: alice.userId,
    });
    assert.equal(leechRes.status, 200);

    // Align both effect windows to the same closed 2-hour span.
    const windowStart = hourFloor(4);
    const windowEnd = hourFloor(2);
    await prisma.raceActiveEffect.updateMany({
      where: { raceId, type: { in: ["HITCHHIKE", "LEECH"] } },
      data: { startsAt: windowStart, expiresAt: windowEnd },
    });

    // ── LIVE: the number the client is shown mid-race ──────────────────────
    const live = await totalsViaApi(raceId, alice);
    assert.equal(live.status, "ACTIVE");
    assert.equal(
      live.totals[alice.userId],
      1000,
      "2,000 walked + 4,000 copied = 6,000 pre-leech, then Carol drains 5,000"
    );
    assert.equal(live.totals[bob.userId], 4000, "the target loses nothing");
    assert.equal(
      live.totals[carol.userId],
      15000,
      "10,000 walked + 5,000 drained from Alice"
    );

    // ── SETTLE through the real settlement path ───────────────────────────
    await prisma.race.update({
      where: { id: raceId },
      data: { endsAt: new Date(Date.now() - 60 * 1000) },
    });
    await resolveExpiredRaces();

    // ── SETTLED: the number the client is shown after the race ends ───────
    const settled = await totalsViaApi(raceId, alice);
    assert.equal(settled.status, "COMPLETED", "the race really settled");

    assert.deepEqual(
      settled.totals,
      live.totals,
      "PARITY: every settled total must equal the live total a client was already shown. A mismatch here is a user watching their score change the moment the race ended."
    );

    // Pin the exact ordering, so a regression that reorders the terms fails with
    // a specific number rather than only as a parity mismatch.
    assert.equal(
      settled.totals[alice.userId],
      1000,
      "hitchhike copy is folded into preLeechTotal BEFORE the leech resolves (0 would mean the copy was dropped; 4,000 would mean it landed after the drain)"
    );

    // And the persisted row agrees with what the API reports.
    const persisted = await prisma.raceParticipant.findFirst({
      where: { raceId, userId: alice.userId },
    });
    assert.equal(persisted.totalSteps, settled.totals[alice.userId]);
  });

  it("a caster who forfeits keeps the copy already accrued in their frozen total", async () => {
    // forfeitRace freezes a final total that feeds standings and payouts, so a
    // dropped copy there would silently delete steps the caster had already been
    // shown. Team race, because mid-race forfeit is a team-race feature.
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    await makeFriends(alice, bob);

    const createRes = await request(server.baseUrl, "POST", "/races", {
      body: {
        name: "Forfeit parity",
        targetSteps: 500000,
        maxDurationDays: 7,
        powerupsEnabled: true,
        powerupStepInterval: 50000,
        isTeamRace: true,
        teamSize: 1,
      },
      token: alice.token,
      headers: HEADERS,
    });
    const created = await createRes.json();
    assert.ok(created.race, `team race created: ${JSON.stringify(created)}`);
    const raceId = created.race.id;
    await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
      body: { inviteeIds: [bob.userId] },
      token: alice.token,
      headers: HEADERS,
    });
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: bob.token,
      headers: HEADERS,
    });
    await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
      token: alice.token,
      headers: HEADERS,
    });

    const start = hourFloor(12);
    await prisma.race.update({
      where: { id: raceId },
      data: { startedAt: start, timezone: "UTC" },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId },
      data: { joinedAt: start },
    });

    await giveHourlyBucket(bob.userId, 4, 3000);
    await giveHourlyBucket(alice.userId, 6, 1000);

    const hh = await giveHeld(raceId, alice.userId, "HITCHHIKE");
    assert.equal(
      (await usePowerup(raceId, alice, hh.id, { targetUserId: bob.userId }))
        .status,
      200
    );
    await prisma.raceActiveEffect.updateMany({
      where: { raceId, type: "HITCHHIKE" },
      data: { startsAt: hourFloor(4), expiresAt: hourFloor(2) },
    });

    const live = await totalsViaApi(raceId, alice);
    assert.equal(
      live.totals[alice.userId],
      4000,
      "1,000 walked + 3,000 copied"
    );

    // Alice forfeits — her total is frozen at this instant, through the real
    // endpoint.
    const forfeitRes = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/forfeit`,
      { token: alice.token, headers: HEADERS }
    );
    const fbody = await forfeitRes.json();
    assert.equal(forfeitRes.status, 200, JSON.stringify(fbody));

    const frozen = await prisma.raceParticipant.findFirst({
      where: { raceId, userId: alice.userId },
    });
    assert.ok(frozen.forfeitedAt, "she really forfeited");
    assert.equal(
      frozen.totalSteps,
      4000,
      "the frozen total RETAINS the accrued copy — dropping it would silently delete steps she had already been shown"
    );
  });
});
