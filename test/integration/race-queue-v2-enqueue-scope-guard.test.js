// Scope-validation guard on the batched resolution enqueue.
//
// WHY THIS EXISTS. The `ON CONFLICT DO UPDATE` in enqueueMany decides, from the
// STORED row plus the incoming scope, whether the merged dirty scope is still
// trustworthy — and if it is not, degrades to `["FULL"]` (resolve everything)
// rather than resolving a scope it cannot vouch for. That guard was written out
// once per column it sets; change 3.2 (docs/resolution-enqueue-cost-requirements.md)
// hoists it into a single sub-SELECT so Postgres evaluates it once instead of
// three times.
//
// That refactor is only safe if `FULL` is still forced in exactly the same
// cases, and the enqueue path had no coverage of ANY of them — the one existing
// over-cap test drives `discardSuperseded`, which is a different statement with
// its own copy of the guard. These cases pin the predicate at every branch, so
// the next person to touch it finds out immediately.
//
// Note the deliberate asymmetry in cases 7 and 8: an over-cap union degrades the
// column it overflowed and escalates `dirty_reasons` to FULL, but it does NOT
// clear the *other* scope column. That is pre-existing behaviour, and it is
// exactly the kind of detail a "simplifying" rewrite silently flattens.
const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");

const { cleanDatabase, prisma } = require("./setup");
const {
  RaceResolutionJobV2,
} = require("../../src/modules/races/models/raceResolutionJobV2");

async function createQueuedRace(name) {
  const race = await prisma.race.create({
    data: {
      creatorId: null,
      name,
      targetSteps: 0,
      isPublic: true,
      timeBased: true,
      timezone: "America/New_York",
      maxParticipants: 500,
      maxDurationDays: 1,
      status: "PENDING",
    },
    select: { id: true },
  });
  await RaceResolutionJobV2.enqueueMany({ raceIds: [race.id], now: new Date() });
  return race.id;
}

// Seeds the STORED side of the merge with raw SQL rather than Prisma, because
// several cases need values Prisma's Json type would not let through — a jsonb
// object where an array belongs, a reason label outside the allow-list, an empty
// string among the participant ids. Those are precisely the corruption shapes
// the guard exists to catch.
function seedStoredScope(raceId, { reasons, participantIds, powerupTypes, state = "queued" }) {
  return prisma.$queryRawUnsafe(
    `UPDATE race_resolution_jobs_v2
        SET dirty_reasons = $2::jsonb,
            dirty_participant_ids = $3::jsonb,
            dirty_powerup_types = $4::jsonb,
            state = $5::"RaceResolutionJobState"
      WHERE race_id = $1
      RETURNING race_id`,
    raceId,
    JSON.stringify(reasons),
    JSON.stringify(participantIds),
    JSON.stringify(powerupTypes),
    state
  );
}

function enqueueWith(raceId, { reason, participantIds = [], powerupTypes = [] }) {
  return RaceResolutionJobV2.enqueueMany({
    raceIds: [raceId],
    now: new Date(),
    dirtyEnvelopeByRaceId: new Map([
      [
        raceId,
        {
          reason,
          priority: "IMMEDIATE",
          dirtyUserIds: [],
          dirtyParticipantIds: participantIds,
          powerupTypes,
        },
      ],
    ]),
  });
}

function readScope(raceId) {
  return prisma.raceResolutionJobV2.findUniqueOrThrow({
    where: { raceId },
    select: { dirtyReasons: true, dirtyParticipantIds: true, dirtyPowerupTypes: true },
  });
}

describe("batched enqueue: dirty-scope validation guard", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("merges a trustworthy scope, deduped and in first-occurrence order", async () => {
    const raceId = await createQueuedRace("Guard Happy Path");
    await seedStoredScope(raceId, {
      reasons: ["STEP_SYNC"],
      participantIds: ["p1", "p2"],
      powerupTypes: ["LEECH"],
    });

    await enqueueWith(raceId, {
      reason: "BOX_OPEN",
      participantIds: ["p2", "p3"],
      powerupTypes: ["LEECH", "RAINSTORM"],
    });

    const scope = await readScope(raceId);
    assert.deepEqual(scope.dirtyReasons, ["STEP_SYNC", "BOX_OPEN"]);
    assert.deepEqual(scope.dirtyParticipantIds, ["p1", "p2", "p3"], "stored ids keep their position and the duplicate collapses");
    assert.deepEqual(scope.dirtyPowerupTypes, ["LEECH", "RAINSTORM"]);
  });

  // Each of these is one condition in the guard. All degrade every scope column,
  // because a stored row this untrustworthy tells us nothing about either scope.
  const degradingSeeds = [
    {
      name: "a stored reason outside the allow-list",
      seed: { reasons: ["STEP_SYNC", "NOT_A_REAL_REASON"], participantIds: ["p1"], powerupTypes: [] },
    },
    {
      name: "stored reasons that are not an array at all",
      seed: { reasons: { corrupted: true }, participantIds: ["p1"], powerupTypes: [] },
    },
    {
      name: "an empty string among the stored participant ids",
      seed: { reasons: ["STEP_SYNC"], participantIds: ["p1", ""], powerupTypes: [] },
    },
    {
      name: "a non-string among the stored participant ids",
      seed: { reasons: ["STEP_SYNC"], participantIds: ["p1", 42], powerupTypes: [] },
    },
    {
      name: "stored powerup types that are not an array",
      seed: { reasons: ["STEP_SYNC"], participantIds: ["p1"], powerupTypes: "LEECH" },
    },
    {
      name: "an empty stored scope on a row that has not succeeded",
      seed: { reasons: [], participantIds: [], powerupTypes: [], state: "queued" },
    },
    {
      name: "a stored scope already escalated to FULL",
      seed: { reasons: ["FULL"], participantIds: ["p1"], powerupTypes: [] },
    },
  ];

  for (const { name, seed } of degradingSeeds) {
    it(`degrades the whole scope to FULL: ${name}`, async () => {
      const raceId = await createQueuedRace(`Guard ${name}`);
      await seedStoredScope(raceId, seed);

      await enqueueWith(raceId, { reason: "STEP_SYNC", participantIds: ["p-new"], powerupTypes: ["LEECH"] });

      const scope = await readScope(raceId);
      assert.deepEqual(scope.dirtyReasons, ["FULL"]);
      assert.deepEqual(scope.dirtyParticipantIds, []);
      assert.deepEqual(scope.dirtyPowerupTypes, []);
    });
  }

  it("degrades to FULL when the INCOMING scope is already FULL", async () => {
    const raceId = await createQueuedRace("Guard Incoming Full");
    await seedStoredScope(raceId, {
      reasons: ["STEP_SYNC"],
      participantIds: ["p1"],
      powerupTypes: ["LEECH"],
    });

    // An envelope the registry cannot normalize collapses to the FULL envelope,
    // which is how a caller's own uncertainty reaches this statement.
    await RaceResolutionJobV2.enqueueMany({
      raceIds: [raceId],
      now: new Date(),
      dirtyEnvelopeByRaceId: new Map([[raceId, { reason: "NOT_A_REAL_REASON", priority: "IMMEDIATE" }]]),
    });

    const scope = await readScope(raceId);
    assert.deepEqual(scope.dirtyReasons, ["FULL"]);
    assert.deepEqual(scope.dirtyParticipantIds, []);
    assert.deepEqual(scope.dirtyPowerupTypes, []);
  });

  it("an over-cap participant union clears the participants but LEAVES the powerup scope", async () => {
    const raceId = await createQueuedRace("Guard Participant Cap");
    await seedStoredScope(raceId, {
      reasons: ["STEP_SYNC"],
      participantIds: Array.from({ length: 1000 }, (_, i) => `p-${i}`),
      powerupTypes: ["LEECH"],
    });

    // 1000 stored + 1 genuinely new = 1001 distinct, one past the cap.
    await enqueueWith(raceId, {
      reason: "STEP_SYNC",
      participantIds: ["p-overflow"],
      powerupTypes: ["RAINSTORM"],
    });

    const scope = await readScope(raceId);
    assert.deepEqual(scope.dirtyReasons, ["FULL"]);
    assert.deepEqual(scope.dirtyParticipantIds, []);
    assert.deepEqual(
      scope.dirtyPowerupTypes,
      ["LEECH", "RAINSTORM"],
      "the powerup cap was not exceeded, so its scope must survive untouched"
    );
  });

  it("an over-cap powerup union clears the powerup types but LEAVES the participant scope", async () => {
    const raceId = await createQueuedRace("Guard Powerup Cap");
    await seedStoredScope(raceId, {
      reasons: ["STEP_SYNC"],
      participantIds: ["p1"],
      powerupTypes: Array.from({ length: 64 }, (_, i) => `t-${i}`),
    });

    // 64 stored + 1 genuinely new = 65 distinct, one past the cap.
    await enqueueWith(raceId, {
      reason: "STEP_SYNC",
      participantIds: ["p2"],
      powerupTypes: ["t-overflow"],
    });

    const scope = await readScope(raceId);
    assert.deepEqual(scope.dirtyReasons, ["FULL"]);
    assert.deepEqual(scope.dirtyPowerupTypes, []);
    assert.deepEqual(
      scope.dirtyParticipantIds,
      ["p1", "p2"],
      "the participant cap was not exceeded, so its scope must survive untouched"
    );
  });

  // The cap counts DISTINCT values, not array entries, and the distinction is
  // load-bearing rather than incidental. Both sides of the merge are already
  // deduplicated on their own -- the stored side by the merge's GROUP BY, the
  // incoming side by stableStrings() in the reason registry -- but they OVERLAP,
  // and re-reporting an id you already reported is the single most common thing
  // a step sync does. A cheaper cap that measured the concatenated LENGTH
  // instead would count those duplicates, so a full race would degrade to FULL
  // on essentially every sync. Guard the semantics, not just the boundary.
  it("an incoming id already in the stored scope does not push it over the cap", async () => {
    const raceId = await createQueuedRace("Guard Duplicate At Cap");
    await seedStoredScope(raceId, {
      reasons: ["STEP_SYNC"],
      participantIds: Array.from({ length: 1000 }, (_, i) => `p-${i}`),
      powerupTypes: ["LEECH"],
    });

    // Sitting exactly on the cap, re-reporting an id that is already stored.
    // Distinct union is still 1000; concatenated length would be 1001.
    await enqueueWith(raceId, {
      reason: "STEP_SYNC",
      participantIds: ["p-0"],
      powerupTypes: ["LEECH"],
    });

    const scope = await readScope(raceId);
    assert.deepEqual(scope.dirtyReasons, ["STEP_SYNC"], "a duplicate id must not force FULL");
    assert.equal(scope.dirtyParticipantIds.length, 1000);
    assert.deepEqual(scope.dirtyPowerupTypes, ["LEECH"]);
  });

  it("stays exactly at the caps without degrading", async () => {
    const raceId = await createQueuedRace("Guard At Cap");
    await seedStoredScope(raceId, {
      reasons: ["STEP_SYNC"],
      participantIds: Array.from({ length: 999 }, (_, i) => `p-${i}`),
      powerupTypes: Array.from({ length: 63 }, (_, i) => `t-${i}`),
    });

    // Lands on 1000 and 64 exactly — the guard fires above the cap, not at it.
    await enqueueWith(raceId, {
      reason: "STEP_SYNC",
      participantIds: ["p-999"],
      powerupTypes: ["t-63"],
    });

    const scope = await readScope(raceId);
    assert.deepEqual(scope.dirtyReasons, ["STEP_SYNC"]);
    assert.equal(scope.dirtyParticipantIds.length, 1000);
    assert.equal(scope.dirtyPowerupTypes.length, 64);
  });

  // The hoist rewrote three independent column expressions into one
  // multi-column assignment. Positional mix-ups are the failure mode that costs
  // the most to debug later, so assert the columns did not swap.
  it("assigns each merged value to its own column", async () => {
    const raceId = await createQueuedRace("Guard Column Mapping");
    await seedStoredScope(raceId, {
      reasons: ["STEP_SYNC"],
      participantIds: ["participant-only"],
      powerupTypes: ["POWERUP_ONLY"],
    });

    await enqueueWith(raceId, { reason: "BOX_OPEN" });

    const scope = await readScope(raceId);
    assert.deepEqual(scope.dirtyReasons, ["STEP_SYNC", "BOX_OPEN"]);
    assert.deepEqual(scope.dirtyParticipantIds, ["participant-only"]);
    assert.deepEqual(scope.dirtyPowerupTypes, ["POWERUP_ONLY"]);
  });
});
