// Phase 2a — the dependency-closure planner against REAL Postgres.
//
// The planner has no HTTP surface yet (Phase 2b wires it into the worker's
// shadow log; Phase 3 gives it a write path), so what this file proves is the
// half that unit fakes cannot: the planner's three model reads and the SHIPPED
// schema-2 fingerprint see the same real rows — in particular that the
// fingerprint's new SQL really does select EXPIRED LEECH/HITCHHIKE rows out of
// Postgres, with the enum's lowercase labels, and that an ACTIVE -> EXPIRED
// transition of a scoring row therefore moves the digest.
//
// Real prisma models, real enum labels, real fingerprint. No stubs.
const assert = require("node:assert/strict");
const { beforeEach, describe, it } = require("node:test");

const { cleanDatabase, createTestUser, prisma } = require("./setup");
const { Race } = require("../../src/modules/races/models/race");
const {
  RaceParticipant,
} = require("../../src/modules/races/models/raceParticipant");
const {
  RaceActiveEffect,
} = require("../../src/modules/powerups/models/raceActiveEffect");
const {
  buildRaceScoringDependencyClosure,
  CLOSURE_FALLBACK_REASONS,
  MAX_CLOSURE_VALIDITY_MS,
} = require("../../src/modules/races/services/raceScoringDependencyClosure");
const {
  buildRaceResolutionInputFingerprint,
} = require("../../src/modules/races/services/raceResolutionInputFingerprint");

const NOW = new Date("2026-08-14T12:00:00.000Z");
const CLAIM_STARTED_AT = new Date("2026-08-14T12:00:05.000Z");

let seedCounter = 0;

async function seedRace({ isTeamRace = false } = {}) {
  const users = [];
  // display_name is UNIQUE, so a second seeded race in the same test needs
  // distinct names. A counter, not randomness: a seeded test must not be able
  // to collide on a bad day.
  const suffix = ++seedCounter;
  for (const name of ["One", "Two", "Three"]) {
    users.push(
      (await createTestUser({ displayName: `Closure ${name} ${suffix}` })).user
    );
  }
  const race = await prisma.race.create({
    data: {
      creatorId: users[0].id,
      name: "Closure Race",
      targetSteps: 100000,
      status: "ACTIVE",
      powerupsEnabled: true,
      isTeamRace,
      startedAt: new Date("2026-08-14T00:00:00.000Z"),
      endsAt: new Date("2026-08-14T23:59:00.000Z"),
    },
  });
  const participants = [];
  for (const [index, user] of users.entries()) {
    participants.push(
      await prisma.raceParticipant.create({
        data: {
          raceId: race.id,
          userId: user.id,
          status: "ACCEPTED",
          rawSteps: 1000 * (index + 1),
          totalSteps: 1000 * (index + 1),
          joinedAt: new Date(`2026-08-14T00:0${index}:00.000Z`),
          totalsUpdatedAt: new Date("2026-08-14T12:00:04.000Z"),
        },
      })
    );
  }
  return { race, users, participants };
}

async function addEffect({
  race,
  participant,
  sourceUser,
  type,
  status = "ACTIVE",
  metadata = {},
  expiresAt = new Date("2026-08-14T13:00:00.000Z"),
}) {
  const powerup = await prisma.racePowerup.create({
    data: {
      raceId: race.id,
      participantId: participant.id,
      userId: sourceUser.id,
      type,
      status: "USED",
    },
  });
  return prisma.raceActiveEffect.create({
    data: {
      raceId: race.id,
      targetParticipantId: participant.id,
      targetUserId: participant.userId,
      sourceUserId: sourceUser.id,
      powerupId: powerup.id,
      type,
      status,
      startsAt: new Date("2026-08-14T11:00:00.000Z"),
      expiresAt,
      metadata,
    },
  });
}

function jobFor(participants, reasons = ["STEP_SYNC"]) {
  return {
    raceId: participants[0].raceId,
    startedAt: CLAIM_STARTED_AT,
    processingDirtyReasons: reasons,
    processingDirtyParticipantIds: [participants[0].id],
    processingTriggeredByUserIds: [participants[0].userId],
  };
}

function planInput(race, participants, reasons) {
  return {
    raceId: race.id,
    dirtyParticipantIds: [participants[0].id],
    job: jobFor(participants, reasons),
    now: NOW,
    Race,
    RaceActiveEffect,
    RaceParticipant,
  };
}

describe("race scoring dependency closure planner (real DB)", () => {
  beforeEach(async () => {
    await cleanDatabase();
    // global_step_events is not race-scoped and survives cleanDatabase, so a
    // row seeded by one case would veto every later one.
    await prisma.globalStepEvent.deleteMany({});
  });

  it("traverses real Leech/Hitchhike rows, ignores SELF and inert rows, and pins the shipped fingerprint", async () => {
    const { race, users, participants } = await seedRace();
    const [p1, p2, p3] = participants;
    // p2 leeches from the uploader p1 (ACTIVE).
    await addEffect({
      race, participant: p1, sourceUser: users[1], type: "LEECH",
      metadata: { ratio: 2 },
    });
    // p3 hitchhiked off p2 and the link has already EXPIRED — still canonical
    // scoring history, so p3 belongs to the component.
    await addEffect({
      race, participant: p2, sourceUser: users[2], type: "HITCHHIKE",
      status: "EXPIRED", metadata: { scoringVersion: 2 },
      expiresAt: new Date("2026-08-14T11:30:00.000Z"),
    });
    // Unrelated SELF buff and an inert row: neither an edge nor a veto. Under
    // the shipped guard either one alone forced a full-field recompute.
    await addEffect({
      race, participant: p3, sourceUser: users[2], type: "RUNNERS_HIGH",
      metadata: { multiplier: 2 },
    });
    await addEffect({
      race, participant: p3, sourceUser: users[0], type: "POWER_OUTAGE",
    });

    const plan = await buildRaceScoringDependencyClosure(
      planInput(race, participants)
    );
    assert.equal(plan.fallbackReason, null);
    assert.equal(plan.plan, "DEPENDENCY_CLOSURE");
    assert.deepEqual(plan.participantIds, [p1.id, p2.id, p3.id].sort());
    assert.deepEqual(plan.sourceParticipantIds, [p1.id]);
    assert.equal(plan.minesActive, false);

    // graphFingerprint IS buildRaceResolutionInputFingerprint's digest — a
    // second fingerprint implementation is prohibited (spec rule 7).
    const fingerprint = await buildRaceResolutionInputFingerprint({
      raceId: race.id,
      now: NOW,
    });
    assert.equal(plan.graphFingerprint, fingerprint.digest);
    // The exclusive validity deadline never runs past the race.
    assert.ok(plan.validUntil.getTime() > NOW.getTime());
    assert.ok(plan.validUntil.getTime() <= race.endsAt.getTime());
    // Persisted totals for the trail-mine projection came from that same read.
    assert.equal(Object.keys(plan.participantTotals).length, 3);
    assert.equal(plan.participantTotals[p2.id].totalSteps, 2000);
  });

  it("an ACTIVE -> EXPIRED leech transition moves the schema-2 digest without changing the closure", async () => {
    const { race, users, participants } = await seedRace();
    const [p1] = participants;
    const effect = await addEffect({
      race, participant: p1, sourceUser: users[1], type: "LEECH",
      metadata: { ratio: 2 },
    });

    const before = await buildRaceScoringDependencyClosure(
      planInput(race, participants)
    );
    await prisma.raceActiveEffect.update({
      where: { id: effect.id },
      data: { status: "EXPIRED", expiresAt: new Date("2026-08-14T11:59:00.000Z") },
    });
    const after = await buildRaceScoringDependencyClosure(
      planInput(race, participants)
    );

    assert.equal(before.plan, "DEPENDENCY_CLOSURE");
    assert.equal(after.plan, "DEPENDENCY_CLOSURE");
    // Under schema 1 the row simply left the query and the digest was blind to
    // the transition.
    assert.notEqual(before.graphFingerprint, after.graphFingerprint);
    // The victim/leecher pair is still one component: the scorer reads the
    // EXPIRED row too.
    assert.deepEqual(after.participantIds, before.participantIds);
    assert.equal(after.participantIds.length, 2);
  });

  it("falls forward to the next future sample boundary after a stored boundary expires", async () => {
    const { race, users } = await seedRace();
    const firstBoundary = new Date("2026-08-14T12:02:00.000Z");
    const secondBoundary = new Date("2026-08-14T12:04:00.000Z");
    await prisma.stepSample.createMany({
      data: [firstBoundary, secondBoundary].map((periodEnd, index) => ({
        userId: users[0].id,
        periodStart: new Date(periodEnd.getTime() - 60_000),
        periodEnd,
        steps: 100 + index,
      })),
    });
    await prisma.userScoringInputVersion.create({
      data: {
        userId: users[0].id,
        generation: 7n,
        sourceQueueSemanticsGeneration: 7n,
        scoringWatermark: "a".repeat(64),
        nextSampleBoundaryAt: firstBoundary,
      },
    });

    const fingerprint = await buildRaceResolutionInputFingerprint({
      raceId: race.id,
      now: new Date("2026-08-14T12:03:00.000Z"),
    });

    assert.equal(
      fingerprint.nextSampleBoundary.toISOString(),
      secondBoundary.toISOString(),
    );
  });

  it("does not trust a maintained boundary from an old writer generation", async () => {
    const { race, users } = await seedRace();
    const actualBoundary = new Date("2026-08-14T12:04:00.000Z");
    await prisma.stepSample.create({
      data: {
        userId: users[0].id,
        periodStart: new Date("2026-08-14T12:03:00.000Z"),
        periodEnd: actualBoundary,
        steps: 100,
      },
    });
    await prisma.userScoringInputVersion.create({
      data: {
        userId: users[0].id,
        generation: 8n,
        // Simulates a mixed-version writer that advanced generation without
        // refreshing the new source-queue ownership stamp or boundary.
        sourceQueueSemanticsGeneration: 7n,
        scoringWatermark: "b".repeat(64),
        nextSampleBoundaryAt: new Date("2026-08-14T12:10:00.000Z"),
      },
    });

    const fingerprint = await buildRaceResolutionInputFingerprint({
      raceId: race.id,
      now: NOW,
    });

    assert.equal(
      fingerprint.nextSampleBoundary.toISOString(),
      actualBoundary.toISOString(),
    );
  });

  it("a real RACE_WIDE row, a team race, and a non-STEP_SYNC envelope all select FULL", async () => {
    const { race, users, participants } = await seedRace();
    await addEffect({
      race, participant: participants[1], sourceUser: users[1],
      type: "RALLY_FLAG",
    });
    const raceWide = await buildRaceScoringDependencyClosure(
      planInput(race, participants)
    );
    assert.equal(raceWide.plan, "FULL");
    assert.equal(
      raceWide.fallbackReason,
      CLOSURE_FALLBACK_REASONS.RACE_WIDE_EFFECT_ACTIVE
    );

    const wrongReason = await buildRaceScoringDependencyClosure(
      planInput(race, participants, ["STEP_SYNC", "BOX_OPEN"])
    );
    assert.equal(
      wrongReason.fallbackReason,
      CLOSURE_FALLBACK_REASONS.NOT_STEP_SYNC_REASON_SET
    );

    const team = await seedRace({ isTeamRace: true });
    const teamPlan = await buildRaceScoringDependencyClosure(
      planInput(team.race, team.participants)
    );
    assert.equal(teamPlan.fallbackReason, CLOSURE_FALLBACK_REASONS.TEAM_RACE);
  });

  it("upcoming and live global events bound a participant-local closure", async () => {
    const { race, participants } = await seedRace();
    // Five minutes out. Under the old `now + 5s` global-event horizon this row
    // was not selected at all, so no deadline could ever see it and a closure
    // could be declared valid straight across the event's start.
    const upcoming = await prisma.globalStepEvent.create({
      data: {
        startsAt: new Date("2026-08-14T12:05:00.000Z"),
        endsAt: new Date("2026-08-14T12:35:00.000Z"),
        multiplier: 2,
        label: "Closure Lookahead",
      },
    });
    const plan = await buildRaceScoringDependencyClosure(
      planInput(race, participants)
    );
    assert.equal(plan.plan, "DEPENDENCY_CLOSURE");
    assert.equal(plan.validUntil.getTime(), upcoming.startsAt.getTime());
    // …and the cap is the ceiling on anything the read cannot see.
    assert.ok(
      plan.validUntil.getTime() <= NOW.getTime() + MAX_CLOSURE_VALIDITY_MS
    );

    // Once live, the multiplier remains participant-local. The closure stays
    // bounded and its exclusive deadline moves to the event end.
    await prisma.globalStepEvent.update({
      where: { id: upcoming.id },
      data: { startsAt: new Date("2026-08-14T11:50:00.000Z") },
    });
    const live = await buildRaceScoringDependencyClosure(
      planInput(race, participants)
    );
    assert.equal(live.plan, "DEPENDENCY_CLOSURE");
    assert.equal(live.fallbackReason, null);
    assert.ok(live.closureFingerprint);
    assert.equal(live.validUntil.getTime(), NOW.getTime() + MAX_CLOSURE_VALIDITY_MS);
  });

  it("a Leech source that is no longer accepted forces FULL", async () => {
    const { race, users, participants } = await seedRace();
    const [p1, , p3] = participants;
    await addEffect({
      race, participant: p1, sourceUser: users[2], type: "LEECH",
      metadata: { ratio: 2 },
    });
    await prisma.raceParticipant.update({
      where: { id: p3.id },
      data: { status: "DECLINED" },
    });
    // p3 still drains p1 (computeLeechEarnedTransfer reads samples by
    // sourceUserId), but the fingerprint's accepted-only members CTE never
    // digests p3's scoring-input generation.
    const plan = await buildRaceScoringDependencyClosure(
      planInput(race, participants)
    );
    assert.equal(plan.plan, "FULL");
    assert.equal(
      plan.fallbackReason,
      CLOSURE_FALLBACK_REASONS.RETAINED_SOURCE_UNRESOLVED
    );
  });

  it("admits a coalesced STEP_SYNC + DISPLAY_REFRESH envelope", async () => {
    const { race, users, participants } = await seedRace();
    await addEffect({
      race, participant: participants[2], sourceUser: users[2],
      type: "RUNNERS_HIGH", metadata: { multiplier: 2 },
    });
    const plan = await buildRaceScoringDependencyClosure(
      planInput(race, participants, ["DISPLAY_REFRESH", "STEP_SYNC"])
    );
    assert.equal(plan.plan, "DEPENDENCY_CLOSURE");
    assert.deepEqual(plan.participantIds, [participants[0].id]);
  });
});
