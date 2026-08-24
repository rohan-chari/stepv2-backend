// Integration tests: Trail Mine targeting.
//
// Expected behavior (per triggerTrailMines in raceStateResolution.js): the mine
// is planted at the owner's current step total; the FIRST runner (other than
// the owner) whose total CROSSES that point triggers it, and when several cross
// in the same resolution the one closest past the mine (lowest new total) is
// hit. Runners already ahead at plant time never trigger.
//
// UPDATED FOR C0 (docs/redis-derived-data-layer-requirements.md §5a):
// DETONATION IS THE WORKER'S. Trail mines are a cross-participant, fire-once
// event evaluated inside `resolveRaceState`, and after C0 exactly one actor may
// bulk-write a race's participant rows: the fenced race-keyed worker. A step
// sync therefore no longer detonates inline — it ENQUEUES, and the worker
// detonates on its next tick (250ms in production). That is the point of the
// change: detonation used to race between the sync path, the placement cron and
// the worker, and is now serialized by the job-row fence for free.
//
// These tests consequently drive an explicit worker tick where they used to
// rely on the sync's inline resolve, and additionally assert FIRE-ONCE across
// ticks — the property the old inline evaluation could not guarantee.
//
// The PLANT side is unchanged and still inline: usePowerup computes fresh totals
// read-only (computeRaceState) so the mine lands at the owner's real position.
const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");

// The worker's startup handoff gate and debounce are irrelevant to mine
// semantics; zero them so a test can tick immediately and repeatedly.
process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS = "0";
process.env.RACE_RESOLVE_DEBOUNCE_MS = "0";

const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const {
  buildRaceResolutionWorkerV2,
} = require("../../src/modules/races/jobs/raceResolutionQueueV2");

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-tm-${++nextAppleId}`;
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

async function createActiveRace(creator, others) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Trail Mine Test",
      targetSteps: 500000,
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
  for (const other of others) {
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: other.token,
    });
  }
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, { token: creator.token });
  // Backdate so samples recorded hours ago fall within the race window
  const defaultStart = new Date(Date.now() - 7 * 60 * 60 * 1000);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: defaultStart } });
  await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: defaultStart } });
  return raceId;
}

async function giveHeldPowerup(raceId, userId, type, earnedAtSteps) {
  const participant = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: participant.id,
      userId,
      type,
      rarity: "RARE",
      status: "HELD",
      earnedAtSteps,
    },
  });
}

async function usePowerup(token, raceId, powerupId, targetUserId) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, {
    body: targetUserId ? { targetUserId } : {},
    token,
  });
}

// Syncing through the route triggers resolveRaceState → totals stored +
// trail mines evaluated. This is "a step sync" from the user's phone.
async function recordSamples(token, samples) {
  return request(server.baseUrl, "POST", "/steps/samples", {
    body: { samples },
    token,
  });
}

// Inserting rows directly does NOT resolve the race — simulates steps the
// user has walked but not yet synced (stale stored totals).
async function insertSamplesDirect(userId, samples) {
  for (const s of samples) {
    await prisma.stepSample.create({
      data: { userId, periodStart: s.periodStart, periodEnd: s.periodEnd, steps: s.steps },
    });
  }
}

// Drain the race-keyed queue to quiescence — the production worker does this on
// a 250ms interval. Returns how many jobs it ran, so a test can assert that a
// SECOND drain found nothing left to do.
async function runWorker() {
  const worker = buildRaceResolutionWorkerV2({ bootAt: 0 });
  let ran = 0;
  for (let i = 0; i < 20; i++) {
    if (!(await worker.processOne())) break;
    ran += 1;
  }
  return ran;
}

async function getProgress(token, raceId) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, { token });
  return (await res.json()).progress;
}

async function getMessages(token, raceId, kind) {
  const suffix = kind ? `?kind=${kind}` : "";
  const res = await request(
    server.baseUrl,
    "GET",
    `/races/${raceId}/messages${suffix}`,
    { token }
  );
  assert.equal(res.status, 200);
  return res.json();
}

async function getFeed(token, raceId) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, {
    token,
  });
  assert.equal(res.status, 200);
  return res.json();
}

function findUser(progress, userId) {
  return progress.participants.find((p) => p.userId === userId);
}

function hoursAgo(h) {
  return new Date(Date.now() - h * 60 * 60 * 1000);
}

function minutesAgo(m) {
  return new Date(Date.now() - m * 60 * 1000);
}

function sample(fromHoursAgo, toHoursAgo, steps) {
  return {
    periodStart: hoursAgo(fromHoursAgo).toISOString(),
    periodEnd: hoursAgo(toHoursAgo).toISOString(),
    steps,
  };
}

async function getMine(raceId) {
  return prisma.raceActiveEffect.findFirst({ where: { raceId, type: "TRAIL_MINE" } });
}

// Trigger events carry metadata.penalty; the plant event does not.
async function mineTriggerEvents(raceId) {
  const events = await prisma.racePowerupEvent.findMany({
    where: { raceId, powerupType: "TRAIL_MINE" },
    orderBy: { createdAt: "asc" },
  });
  return events.filter((e) => e.metadata && typeof e.metadata.penalty === "number");
}

describe("trail mine targeting", () => {
  before(async () => {
    server = await getSharedServer();
  });

  after(async () => {});

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("planting a trail mine stays hidden from current and legacy activity feeds", async () => {
    const alice = await createUser("AliceMineHidden");
    const bob = await createUser("BobMineHiddenAA");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);

    await recordSamples(alice.token, [sample(6, 5, 10000)]);
    await recordSamples(bob.token, [sample(6, 5.5, 1000)]);

    const mine = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MINE", 99901);
    const useResponse = await usePowerup(alice.token, raceId, mine.id);
    assert.equal(useResponse.status, 200);

    const systemMessages = await getMessages(alice.token, raceId, "SYSTEM");
    const mergedMessages = await getMessages(alice.token, raceId);
    const legacyFeed = await getFeed(alice.token, raceId);

    for (const [surface, rows] of [
      ["SYSTEM messages", systemMessages.messages],
      ["merged messages", mergedMessages.messages],
      ["legacy feed", legacyFeed.events],
    ]) {
      assert.ok(
        !(rows || []).some((row) => row.powerupType === "TRAIL_MINE"),
        `${surface} must not reveal that a trail mine was planted`
      );
    }

    const plantAudit = await prisma.racePowerupEvent.findFirst({
      where: {
        raceId,
        eventType: "POWERUP_USED",
        powerupType: "TRAIL_MINE",
        description: { contains: " planted a " },
      },
    });
    assert.ok(plantAudit, "the hidden plant audit row is still retained");
    assert.equal(plantAudit.metadata.hiddenFromFeed, true);

    // Rows created before this fix had no hidden marker. Their plant metadata
    // remains a safe discriminator, so old history must also stay private.
    const { hiddenFromFeed: _hiddenFromFeed, ...legacyMetadata } =
      plantAudit.metadata;
    await prisma.racePowerupEvent.update({
      where: { id: plantAudit.id },
      data: { metadata: legacyMetadata },
    });
    const legacySystem = await getMessages(alice.token, raceId, "SYSTEM");
    const legacyMerged = await getMessages(alice.token, raceId);
    const legacyOldFeed = await getFeed(alice.token, raceId);
    for (const [surface, rows] of [
      ["SYSTEM messages", legacySystem.messages],
      ["merged messages", legacyMerged.messages],
      ["legacy feed", legacyOldFeed.events],
    ]) {
      assert.ok(
        !(rows || []).some((row) =>
          String(row.body || row.description).includes("planted a")
        ),
        `${surface} must also hide pre-fix trail mine plant rows`
      );
    }

    await recordSamples(bob.token, [sample(4, 3, 12000)]);
    await runWorker();

    const triggeredSystem = await getMessages(alice.token, raceId, "SYSTEM");
    const triggeredMerged = await getMessages(alice.token, raceId);
    const triggeredLegacy = await getFeed(alice.token, raceId);
    for (const [surface, rows] of [
      ["SYSTEM messages", triggeredSystem.messages],
      ["merged messages", triggeredMerged.messages],
      ["legacy feed", triggeredLegacy.events],
    ]) {
      assert.ok(
        (rows || []).some(
          (row) =>
            row.powerupType === "TRAIL_MINE" &&
            String(row.body || row.description).includes("triggered a Trail Mine")
        ),
        `${surface} must still show the later trail mine detonation`
      );
    }
  });

  it("the runner whose sync crosses the mine point is hit for 3% of their total", async () => {
    const alice = await createUser("AliceMineAAA");
    const bob = await createUser("BobMineAAAAA");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);

    // Alice at 10,000 (synced), Bob at 1,000 (synced)
    await recordSamples(alice.token, [sample(6, 5, 10000)]);
    await recordSamples(bob.token, [sample(6, 5.5, 1000)]);

    const mine = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MINE", 99901);
    const res = await usePowerup(alice.token, raceId, mine.id);
    assert.equal(res.status, 200);

    const planted = await getMine(raceId);
    assert.equal(planted.metadata.positionSteps, 10000, "mine planted at Alice's total");
    assert.equal(planted.metadata.penaltyPercent, 0.03);

    // Bob's next sync carries him past the mine: 1,000 → 13,000. The sync
    // enqueues; the worker detonates.
    await recordSamples(bob.token, [sample(4, 3, 12000)]);
    assert.equal(
      (await mineTriggerEvents(raceId)).length,
      0,
      "the request path itself never detonates — it enqueues"
    );
    await runWorker();

    const triggers = await mineTriggerEvents(raceId);
    assert.equal(triggers.length, 1, "exactly one trigger event");
    assert.equal(triggers[0].targetUserId, bob.userId);
    // 3% of Bob's total at the crossing (13,000) = 390
    assert.equal(triggers[0].metadata.penalty, 390);
    assert.equal(triggers[0].metadata.blocked, false);

    const after1 = await getMine(raceId);
    assert.equal(after1.status, "EXPIRED", "mine is consumed");

    const progress = await getProgress(alice.token, raceId);
    assert.equal(findUser(progress, bob.userId).totalSteps, 13000 - 390);
    assert.equal(findUser(progress, alice.userId).totalSteps, 10000, "owner unaffected");

    // FIRE-ONCE across ticks: re-dirty the race and drain again. The mine is
    // EXPIRED, so no second detonation and no second penalty.
    await recordSamples(bob.token, [sample(2, 1, 5)]);
    await runWorker();
    assert.equal(
      (await mineTriggerEvents(raceId)).length,
      1,
      "a later worker tick must not re-detonate a consumed mine"
    );
  });

  it("a runner who stays behind the mine point is NOT hit", async () => {
    const alice = await createUser("AliceMineBBB");
    const bob = await createUser("BobMineBBBBB");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);

    await recordSamples(alice.token, [sample(6, 5, 10000)]);
    await recordSamples(bob.token, [sample(6, 5.5, 1000)]);

    const mine = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MINE", 99901);
    await usePowerup(alice.token, raceId, mine.id);

    // Bob walks, but only to 3,000 — still behind the 10,000 mine
    await recordSamples(bob.token, [sample(4, 3, 2000)]);
    await runWorker();

    assert.equal((await mineTriggerEvents(raceId)).length, 0, "no trigger");
    assert.equal((await getMine(raceId)).status, "ACTIVE", "mine still armed");

    const progress = await getProgress(alice.token, raceId);
    assert.equal(findUser(progress, bob.userId).totalSteps, 3000, "no penalty");
  });

  it("a runner already ahead of the mine when it is planted never triggers it", async () => {
    const alice = await createUser("AliceMineCCC");
    const bob = await createUser("BobMineCCCCC");
    const dave = await createUser("DaveMineCCCC");
    await makeFriends(alice, bob);
    await makeFriends(alice, dave);
    const raceId = await createActiveRace(alice, [bob, dave]);

    // Dave 12,000 > Alice 10,000 > Bob 1,000 (Alice is not last, so she can plant)
    await recordSamples(alice.token, [sample(6, 5, 10000)]);
    await recordSamples(dave.token, [sample(6, 5, 12000)]);
    await recordSamples(bob.token, [sample(6, 5.5, 1000)]);

    const mine = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MINE", 99901);
    const res = await usePowerup(alice.token, raceId, mine.id);
    assert.equal(res.status, 200);
    assert.equal((await getMine(raceId)).metadata.positionSteps, 10000);

    // Dave (already past the mine) keeps walking
    await recordSamples(dave.token, [sample(4, 3, 1000)]);
    await runWorker();

    assert.equal((await mineTriggerEvents(raceId)).length, 0);
    assert.equal((await getMine(raceId)).status, "ACTIVE");

    const progress = await getProgress(alice.token, raceId);
    assert.equal(findUser(progress, dave.userId).totalSteps, 13000, "Dave untouched");
  });

  it("when two runners cross in the same resolution, the one closest past the mine is hit (single use)", async () => {
    const alice = await createUser("AliceMineDDD");
    const bob = await createUser("BobMineDDDDD");
    const carol = await createUser("CarolMineDDD");
    await makeFriends(alice, bob);
    await makeFriends(alice, carol);
    const raceId = await createActiveRace(alice, [bob, carol]);

    await recordSamples(alice.token, [sample(6, 5, 10000)]);
    await recordSamples(bob.token, [sample(6, 5.5, 1000)]);
    await recordSamples(carol.token, [sample(6, 5.5, 1000)]);

    const mine = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MINE", 99901);
    await usePowerup(alice.token, raceId, mine.id);

    // Both cross the 10,000 mine in the SAME resolution: insert their walked
    // steps directly (no resolve), then let ONE worker run evaluate the race.
    // Post-C0 this is the natural shape — the worker resolves the whole race in
    // one fenced pass, so "the same resolution" is exactly one worker run.
    await insertSamplesDirect(bob.userId, [sample(4, 3, 14000)]); // → 15,000
    await insertSamplesDirect(carol.userId, [sample(4, 3, 11000)]); // → 12,000
    await recordSamples(alice.token, [
      { periodStart: minutesAgo(20).toISOString(), periodEnd: minutesAgo(10).toISOString(), steps: 10 },
    ]);
    await runWorker();

    const triggers = await mineTriggerEvents(raceId);
    assert.equal(triggers.length, 1, "mine fires exactly once");
    assert.equal(
      triggers[0].targetUserId,
      carol.userId,
      "Carol (12,000) is closer past the 10,000 mine than Bob (15,000)"
    );
    assert.equal(triggers[0].metadata.penalty, Math.round(12000 * 0.03));
    assert.equal((await getMine(raceId)).status, "EXPIRED");

    const progress = await getProgress(alice.token, raceId);
    assert.equal(findUser(progress, carol.userId).totalSteps, 12000 - 360);
    assert.equal(findUser(progress, bob.userId).totalSteps, 15000, "Bob untouched");
  });

  it("cannot plant while in last place", async () => {
    const alice = await createUser("AliceMineEEE");
    const bob = await createUser("BobMineEEEEE");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);

    await recordSamples(alice.token, [sample(6, 5, 1000)]);
    await recordSamples(bob.token, [sample(6, 5, 10000)]);

    const mine = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MINE", 99901);
    const res = await usePowerup(alice.token, raceId, mine.id);
    assert.equal(res.status, 400);
    assert.equal(await getMine(raceId), null);
  });

  // ------------------------------------------------------------------
  // REGRESSION — usePowerup computes fresh totals (READ-ONLY, computeRaceState)
  // BEFORE planting, so a stale stored total can't place the mine behind the
  // owner's real position (the old behavior instantly hit runners far behind
  // the owner). Pre-C0 this freshening was a resolve-and-PERSIST; it is now a
  // pure computation, which is what keeps the request path out of the
  // bulk-writer role. The observable plant behavior is identical.
  // ------------------------------------------------------------------

  it("mine is planted at the owner's REAL walked position even when their stored total is stale", async () => {
    const alice = await createUser("AliceMineFFF");
    const bob = await createUser("BobMineFFFFF");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);

    // Stored totals: Alice 2,000, Bob 1,000
    await recordSamples(alice.token, [sample(6, 5.5, 2000)]);
    await recordSamples(bob.token, [sample(6, 5.5, 1000)]);
    await runWorker();

    // Alice has really walked 10,000 but her phone hasn't synced the last 8,000
    await insertSamplesDirect(alice.userId, [sample(5, 4, 8000)]);

    const mine = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MINE", 99901);
    const res = await usePowerup(alice.token, raceId, mine.id);
    assert.equal(res.status, 200);

    // usePowerup computes race state before planting, so the mine lands at
    // Alice's real 10,000 — not the stale stored 2,000.
    const planted = await getMine(raceId);
    assert.equal(
      planted.metadata.positionSteps,
      10000,
      "mine placed at the owner's real position, not the stale stored total"
    );

    // …and it did so WITHOUT persisting: the freshening is read-only, so the
    // stored column is still stale until the worker (enqueued by this use) runs.
    const stored = await prisma.raceParticipant.findFirst({
      where: { raceId, userId: alice.userId },
      select: { totalSteps: true },
    });
    assert.equal(
      stored.totalSteps,
      2000,
      "the plant read fresh numbers but wrote none — the worker owns that write"
    );
  });

  it("ACTIVE/null-started races fall back to the stored lean context without participant writes", async () => {
    const alice = await createUser("AliceMineNull");
    const bob = await createUser("BobMineNullAA");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);
    const participants = await prisma.raceParticipant.findMany({
      where: { raceId },
    });
    const aliceParticipant = participants.find((p) => p.userId === alice.userId);
    const bobParticipant = participants.find((p) => p.userId === bob.userId);
    await prisma.raceParticipant.update({
      where: { id: aliceParticipant.id },
      data: { totalSteps: 10000, bonusSteps: 111, maxBonusSteps: 222 },
    });
    await prisma.raceParticipant.update({
      where: { id: bobParticipant.id },
      data: { totalSteps: 1000 },
    });
    await prisma.race.update({
      where: { id: raceId },
      data: { startedAt: null },
    });

    const mine = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MINE", 99901);
    const response = await usePowerup(alice.token, raceId, mine.id);
    assert.equal(response.status, 200);
    const planted = await getMine(raceId);
    assert.equal(planted.metadata.positionSteps, 10000);

    const after = await prisma.raceParticipant.findUnique({
      where: { id: aliceParticipant.id },
      select: { totalSteps: true, bonusSteps: true, maxBonusSteps: true },
    });
    assert.deepEqual(after, {
      totalSteps: 10000,
      bonusSteps: 111,
      maxBonusSteps: 222,
    });
  });

  it("plants from canonical scoring across 300 participants without persisting captured totals", async () => {
    const alice = await createUser("AliceMine300");
    const startedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const race = await prisma.race.create({
      data: {
        creatorId: alice.userId,
        name: "Trail Mine 300",
        targetSteps: 500000,
        status: "ACTIVE",
        startedAt,
        endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        timezone: "UTC",
        powerupsEnabled: true,
        powerupStepInterval: 5000,
      },
    });
    const others = Array.from({ length: 299 }, (_, index) => ({
      id: `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      appleId: `trail-300-${index}`,
      displayName: `Trail ${index}`,
    }));
    await prisma.user.createMany({ data: others });
    const aliceParticipantId = "40000000-0000-4000-8000-000000000000";
    await prisma.raceParticipant.createMany({
      data: [
        {
          id: aliceParticipantId,
          raceId: race.id,
          userId: alice.userId,
          status: "ACCEPTED",
          totalSteps: 5,
          joinedAt: startedAt,
        },
        ...others.map((user, index) => ({
          id: `40000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          raceId: race.id,
          userId: user.id,
          status: "ACCEPTED",
          totalSteps: 5,
          joinedAt: new Date(startedAt.getTime() + index + 1),
        })),
      ],
    });
    const periodStart = new Date(startedAt.getTime() + 60_000);
    const periodEnd = new Date(startedAt.getTime() + 120_000);
    await prisma.stepSample.createMany({
      data: [
        {
          userId: alice.userId,
          periodStart,
          periodEnd,
          steps: 10000,
        },
        ...others.map((user, index) => ({
          userId: user.id,
          periodStart,
          periodEnd,
          steps: 1000 + (index % 500),
        })),
      ],
    });
    const mine = await giveHeldPowerup(race.id, alice.userId, "TRAIL_MINE", 99901);
    const response = await usePowerup(alice.token, race.id, mine.id);
    assert.equal(response.status, 200);
    assert.equal((await getMine(race.id)).metadata.positionSteps, 10000);
    assert.equal(
      await prisma.raceParticipant.count({
        where: { raceId: race.id, totalSteps: { not: 5 } },
      }),
      0,
      "the canonical scoring pass captures rather than persists all 300 participant writes"
    );
  });

  it("a stale owner sync never detonates the mine on a runner far behind the owner", async () => {
    const alice = await createUser("AliceMineGGG");
    const bob = await createUser("BobMineGGGGG");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);

    // Stored: Alice 2,000, Bob 1,000. Real (unsynced): Alice 10,000, Bob 5,000.
    await recordSamples(alice.token, [sample(6, 5.5, 2000)]);
    await recordSamples(bob.token, [sample(6, 5.5, 1000)]);
    await insertSamplesDirect(alice.userId, [sample(5, 4, 8000)]);
    await insertSamplesDirect(bob.userId, [sample(5, 4, 4000)]);

    const mine = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MINE", 99901);
    await usePowerup(alice.token, raceId, mine.id);

    // The pre-plant COMPUTATION puts the mine at Alice's real 10,000, and Bob's
    // real position is 5,000 — still behind the mine. (Before the fix the mine
    // landed at the stale 2,000 and hit Bob in the same request.) Draining the
    // queue proves it: even a full worker pass over the freshest possible state
    // finds nothing to detonate.
    assert.equal((await mineTriggerEvents(raceId)).length, 0, "no instant detonation");
    await runWorker();
    assert.equal(
      (await mineTriggerEvents(raceId)).length,
      0,
      "and the worker does not detonate it either — Bob is genuinely behind"
    );
    const planted = await getMine(raceId);
    assert.equal(planted.status, "ACTIVE");
    assert.equal(planted.metadata.positionSteps, 10000);

    const progress = await getProgress(alice.token, raceId);
    assert.equal(findUser(progress, alice.userId).totalSteps, 10000);
    assert.equal(findUser(progress, bob.userId).totalSteps, 5000, "Bob unharmed");

    // Bob later genuinely crossing the mine still triggers it normally
    await recordSamples(bob.token, [sample(3, 2, 6000)]); // 5,000 → 11,000
    await runWorker();
    const triggers = await mineTriggerEvents(raceId);
    assert.equal(triggers.length, 1);
    assert.equal(triggers[0].targetUserId, bob.userId);
    assert.equal(triggers[0].metadata.penalty, Math.round(11000 * 0.03));
  });
});
