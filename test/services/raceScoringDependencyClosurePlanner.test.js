// Phase 2a — dependency-closure PLANNER (shadow mode, no worker wiring).
//
// Unit-level because the planner is a pure read-and-decide service: its inputs
// are three injected model reads plus the shipped fingerprint, and there is no
// HTTP surface for it until Phase 2b wires it into the worker's shadow log. The
// DB-backed proof that the same planner reads REAL prisma rows and a REAL
// schema-2 fingerprint lives in
// test/integration/race-dependency-closure-planner.test.js.
//
// Closure membership is asserted against a BRUTE-FORCE ORACLE built here from
// the raw effect list — never against the planner's own traversal.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const {
  buildRaceScoringDependencyClosure,
  wouldTrailMineEscalate,
  CLOSURE_FALLBACK_REASONS,
  MAX_DEPENDENCY_CLOSURE_PARTICIPANTS,
  MAX_CLOSURE_VALIDITY_MS,
  TRAIL_MINE_ESCALATION_UNKNOWN,
} = require("../../src/modules/races/services/raceScoringDependencyClosure");

const NOW = new Date("2026-08-14T12:00:00.000Z");
const CLAIM_STARTED_AT = new Date("2026-08-14T12:00:05.000Z");
const RACE_ENDS_AT = new Date("2026-08-14T23:00:00.000Z");

function participant(id, overrides = {}) {
  return {
    id,
    userId: `u-${id}`,
    status: "ACCEPTED",
    rawSteps: 1000,
    totalSteps: 1000,
    bonusSteps: 0,
    maxBonusSteps: 0,
    joinedAt: new Date("2026-08-14T00:00:00.000Z"),
    totalsUpdatedAt: new Date("2026-08-14T12:00:04.000Z"),
    finishedAt: null,
    forfeitedAt: null,
    ...overrides,
  };
}

// LEECH row: sourceUser leeches FROM the target participant.
function leech(id, targetParticipantId, sourceUserId, overrides = {}) {
  return {
    id,
    type: "LEECH",
    status: "ACTIVE",
    targetParticipantId,
    targetUserId: `u-${targetParticipantId}`,
    sourceUserId,
    startsAt: new Date("2026-08-14T11:00:00.000Z"),
    expiresAt: new Date("2026-08-14T13:00:00.000Z"),
    metadata: { ratio: 2 },
    ...overrides,
  };
}

// HITCHHIKE row: sourceUser copies FROM the target participant.
function hitchhike(id, targetParticipantId, sourceUserId, scoringVersion, overrides = {}) {
  return {
    id,
    type: "HITCHHIKE",
    status: "ACTIVE",
    targetParticipantId,
    targetUserId: `u-${targetParticipantId}`,
    sourceUserId,
    startsAt: new Date("2026-08-14T11:30:00.000Z"),
    expiresAt: new Date("2026-08-14T12:30:00.000Z"),
    metadata: scoringVersion == null ? {} : { scoringVersion },
    ...overrides,
  };
}

function effect(id, type, targetParticipantId, overrides = {}) {
  return {
    id,
    type,
    status: "ACTIVE",
    targetParticipantId,
    targetUserId: `u-${targetParticipantId}`,
    sourceUserId: `u-${targetParticipantId}`,
    startsAt: new Date("2026-08-14T11:00:00.000Z"),
    expiresAt: new Date("2026-08-14T14:00:00.000Z"),
    metadata: {},
    ...overrides,
  };
}

// A stand-in for the shipped fingerprint that is nonetheless a REAL function of
// its inputs, so "same inputs => same digest" and "changed row => changed
// digest" are meaningful assertions here. The real builder is exercised against
// Postgres in the integration file.
function fakeFingerprint({ participants, effects, events, nextSampleBoundary }) {
  return async () => ({
    digest: crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          participants,
          // Includes EXPIRED rows: schema 2's whole point.
          effects: [...effects].sort((a, b) => a.id.localeCompare(b.id)),
          events,
        })
      )
      .digest("hex"),
    participantCount: participants.length,
    nextSampleBoundary: nextSampleBoundary || null,
    activeEffects: effects.filter((row) => row.status !== "EXPIRED"),
    expiredScoringEffects: effects.filter((row) => row.status === "EXPIRED"),
    globalEvents: events,
    participants,
  });
}

function world({
  participants = [participant("p1")],
  effects = [],
  events = [],
  nextSampleBoundary = null,
  race = {},
  reasons = ["STEP_SYNC"],
  dirty = ["p1"],
  triggeredBy = null,
  now = NOW,
  claimStartedAt = CLAIM_STARTED_AT,
} = {}) {
  const dirtyRows = participants.filter((row) => dirty.includes(row.id));
  return {
    raceId: "r1",
    dirtyParticipantIds: dirty,
    now,
    job: {
      raceId: "r1",
      startedAt: claimStartedAt,
      processingDirtyReasons: reasons,
      processingDirtyParticipantIds: dirty,
      processingTriggeredByUserIds:
        triggeredBy || dirtyRows.map((row) => row.userId),
    },
    Race: {
      async findById() {
        return {
          id: "r1",
          status: "ACTIVE",
          isTeamRace: false,
          endsAt: RACE_ENDS_AT,
          timezone: "UTC",
          participants,
          ...race,
        };
      },
    },
    RaceActiveEffect: {
      async findActiveForRace() {
        return effects.filter((row) => row.status !== "EXPIRED");
      },
      async findRaceEffectsByType(_raceId, type) {
        return effects.filter((row) => row.type === type);
      },
    },
    RaceParticipant: {
      async findAcceptedByRace() {
        return participants.filter((row) => row.status === "ACCEPTED");
      },
    },
    buildInputFingerprint: fakeFingerprint({
      participants,
      effects,
      events,
      nextSampleBoundary,
    }),
  };
}

// ---------------------------------------------------------------------------
// Brute-force oracle: the connected component of the seeds over the UNDIRECTED
// LEECH/HITCHHIKE graph, intersected with accepted participants. Built naively
// from the raw rows with no reference to the planner's traversal.
// ---------------------------------------------------------------------------
function oracleClosure({ participants, effects, seeds }) {
  const accepted = participants.filter((row) => row.status === "ACCEPTED");
  const acceptedIds = new Set(accepted.map((row) => row.id));
  const participantIdByUserId = new Map();
  for (const row of accepted) {
    if (!participantIdByUserId.has(row.userId)) {
      participantIdByUserId.set(row.userId, row.id);
    }
  }
  const pairs = [];
  for (const row of effects) {
    if (row.type !== "LEECH" && row.type !== "HITCHHIKE") continue;
    const target = acceptedIds.has(row.targetParticipantId)
      ? row.targetParticipantId
      : participantIdByUserId.get(row.targetUserId);
    const source = participantIdByUserId.get(row.sourceUserId);
    if (!target || !source || target === source) continue;
    pairs.push([target, source]);
  }
  const component = new Set(seeds.filter((id) => acceptedIds.has(id)));
  let grew = true;
  while (grew) {
    grew = false;
    for (const [left, right] of pairs) {
      if (component.has(left) && !component.has(right)) {
        component.add(right);
        grew = true;
      }
      if (component.has(right) && !component.has(left)) {
        component.add(left);
        grew = true;
      }
    }
  }
  return [...component].sort();
}

async function planFor(options) {
  const input = world(options);
  const plan = await buildRaceScoringDependencyClosure(input);
  return { plan, input };
}

async function assertMatchesOracle(options) {
  const { plan } = await planFor(options);
  const participants = options.participants || [participant("p1")];
  assert.equal(plan.fallbackReason, null);
  assert.equal(plan.plan, "DEPENDENCY_CLOSURE");
  assert.deepEqual(
    plan.participantIds,
    oracleClosure({
      participants,
      effects: options.effects || [],
      seeds: options.dirty || ["p1"],
    })
  );
  return plan;
}

// ---------------------------------------------------------------------------
// Closure membership vs the oracle
// ---------------------------------------------------------------------------

test("an unrelated SELF effect leaves the closure at the uploader alone", async () => {
  const participants = [participant("p1"), participant("p2"), participant("p9")];
  const plan = await assertMatchesOracle({
    participants,
    // A RUNNERS_HIGH on a stranger is SELF: no edge, no veto. This is exactly
    // the case the shipped `activeEffects.length > 0 => FULL` guard got wrong.
    effects: [effect("e-self", "RUNNERS_HIGH", "p9")],
  });
  assert.deepEqual(plan.participantIds, ["p1"]);
  assert.deepEqual(plan.sourceParticipantIds, ["p1"]);
});

test("a scoring-inert effect neither edges nor vetoes", async () => {
  const participants = [participant("p1"), participant("p2")];
  const plan = await assertMatchesOracle({
    participants,
    // POWER_OUTAGE covered the Weekly Challenge ~24/7 in prod forensics.
    effects: [effect("e-po", "POWER_OUTAGE", "p2")],
  });
  assert.deepEqual(plan.participantIds, ["p1"]);
});

test("multiple leechers and transitive leech chains match the oracle component", async () => {
  const participants = ["p1", "p2", "p3", "p4", "p5"].map((id) => participant(id));
  // Two leechers on the uploader, then a chain out of one of them.
  const effects = [
    leech("l1", "p1", "u-p2"),
    leech("l2", "p1", "u-p3"),
    leech("l3", "p3", "u-p4"),
    // p5 is entirely unrelated.
    effect("e-self", "LEG_CRAMP", "p5"),
  ];
  const plan = await assertMatchesOracle({ participants, effects });
  assert.deepEqual(plan.participantIds, ["p1", "p2", "p3", "p4"]);
});

test("closure walks an edge in the OUTGOING direction too (uploader is the leecher)", async () => {
  const participants = ["p1", "p2"].map((id) => participant(id));
  // The uploader p1 leeches FROM p2: the edge leaves p1, and p2's score still
  // has to be recomputed because it is drained.
  const plan = await assertMatchesOracle({
    participants,
    effects: [leech("l1", "p2", "u-p1")],
  });
  assert.deepEqual(plan.participantIds, ["p1", "p2"]);
});

test("both supported Hitchhike scoring versions produce edges", async () => {
  for (const version of [1, 2, null]) {
    const participants = ["p1", "p2", "p3"].map((id) => participant(id));
    const plan = await assertMatchesOracle({
      participants,
      effects: [hitchhike("h1", "p1", "u-p2", version)],
    });
    assert.deepEqual(plan.participantIds, ["p1", "p2"]);
    // An absent stored version is the LEGACY top-of-hour copy.
    assert.equal(plan.hasLegacyHitchhike, version === 2 ? false : true);
  }
});

test("a mixed Leech + Hitchhike graph is traversed as one component", async () => {
  const participants = ["p1", "p2", "p3", "p4"].map((id) => participant(id));
  const effects = [
    leech("l1", "p1", "u-p2"),
    hitchhike("h1", "p2", "u-p3", 2),
    // p4 is in the race but touched by nothing.
    effect("e-self", "CAMPFIRE_REST", "p4", {
      metadata: { multiplier: 0.5, freezeMs: 30 * 60 * 1000 },
    }),
  ];
  const plan = await assertMatchesOracle({ participants, effects });
  assert.deepEqual(plan.participantIds, ["p1", "p2", "p3"]);
});

test("EXPIRED Leech/Hitchhike history still creates edges", async () => {
  const participants = ["p1", "p2", "p3"].map((id) => participant(id));
  const effects = [
    leech("l1", "p1", "u-p2", {
      status: "EXPIRED",
      expiresAt: new Date("2026-08-14T11:30:00.000Z"),
    }),
    hitchhike("h1", "p1", "u-p3", 2, {
      status: "EXPIRED",
      expiresAt: new Date("2026-08-14T11:45:00.000Z"),
    }),
  ];
  // "Currently active" is not a sufficient graph (spec rule 2).
  const plan = await assertMatchesOracle({ participants, effects });
  assert.deepEqual(plan.participantIds, ["p1", "p2", "p3"]);
});

test("a frozen/absent Leech source forces FULL rather than a digest that cannot see it", async () => {
  const participants = [
    participant("p1"),
    participant("p2"),
    // No longer accepted, but the full scorer STILL drains p1 for this leech:
    // computeLeechEarnedTransfer reads the source's samples by sourceUserId
    // with no participation check. The fingerprint's `members` CTE is
    // accepted-only, so this source's scoring-input generation is NOT digested
    // — its re-upload would change p1's correct total while the digest stayed
    // identical and the fence waved a stale write through.
    participant("p3", { status: "DECLINED" }),
  ];
  const effects = [leech("l1", "p1", "u-p3"), leech("l2", "p1", "u-p2")];
  const plan = await assertFullBecause(
    CLOSURE_FALLBACK_REASONS.RETAINED_SOURCE_UNRESOLVED,
    { participants, effects }
  );
  // The offending row is still reported, for the shadow log's rate measurement.
  assert.deepEqual(
    plan.retainedUnresolvedSources.map((row) => row.effectId),
    ["l1"]
  );
});

test("a Hitchhike row whose target left the race also forces FULL", async () => {
  await assertFullBecause(CLOSURE_FALLBACK_REASONS.RETAINED_SOURCE_UNRESOLVED, {
    participants: [participant("p1"), participant("p2")],
    // Target p9 is not a participant of this race at all.
    effects: [hitchhike("h1", "p9", "u-p2", 2)],
  });
});

test("outputs are sorted and identical inputs yield an identical fingerprint", async () => {
  const participants = ["p3", "p1", "p2"].map((id) => participant(id));
  const effects = [leech("l2", "p1", "u-p3"), leech("l1", "p1", "u-p2")];
  const left = await planFor({ participants, effects });
  const right = await planFor({ participants, effects });
  assert.deepEqual(left.plan.participantIds, ["p1", "p2", "p3"]);
  assert.deepEqual(
    [...left.plan.participantIds].sort(),
    left.plan.participantIds
  );
  assert.equal(left.plan.graphFingerprint, right.plan.graphFingerprint);
  assert.equal(left.plan.validUntil.getTime(), right.plan.validUntil.getTime());
});

// ---------------------------------------------------------------------------
// Vetoes
// ---------------------------------------------------------------------------

async function assertFullBecause(reason, options) {
  const { plan } = await planFor(options);
  assert.equal(plan.plan, "FULL");
  assert.equal(plan.fallbackReason, reason);
  assert.deepEqual(plan.participantIds, []);
  assert.equal(plan.graphFingerprint, null);
  return plan;
}

test("an active RACE_WIDE effect anywhere in the race forces FULL", async () => {
  await assertFullBecause(CLOSURE_FALLBACK_REASONS.RACE_WIDE_EFFECT_ACTIVE, {
    participants: [participant("p1"), participant("p2")],
    effects: [effect("e-rally", "RALLY_FLAG", "p2")],
  });
  await assertFullBecause(CLOSURE_FALLBACK_REASONS.RACE_WIDE_EFFECT_ACTIVE, {
    participants: [participant("p1")],
    effects: [effect("e-up", "UPRISING", "p1")],
  });
});

test("an unknown powerup type forces FULL rather than defaulting", async () => {
  await assertFullBecause(CLOSURE_FALLBACK_REASONS.UNKNOWN_POWERUP_TYPE, {
    participants: [participant("p1")],
    effects: [effect("e-new", "TIME_MACHINE", "p1")],
  });
});

test("a team race forces FULL as an explicit condition", async () => {
  await assertFullBecause(CLOSURE_FALLBACK_REASONS.TEAM_RACE, {
    participants: [participant("p1")],
    race: { isTeamRace: true },
  });
});

test("a global event overlapping the as-of instant forces FULL", async () => {
  await assertFullBecause(CLOSURE_FALLBACK_REASONS.GLOBAL_EVENT_ACTIVE, {
    participants: [participant("p1")],
    events: [
      {
        id: "g1",
        startsAt: new Date("2026-08-14T11:45:00.000Z"),
        endsAt: new Date("2026-08-14T12:15:00.000Z"),
        multiplier: 2,
      },
    ],
  });
});

test("a global event that has not started only shortens the deadline", async () => {
  const { plan } = await planFor({
    participants: [participant("p1")],
    events: [
      {
        id: "g1",
        startsAt: new Date("2026-08-14T12:04:00.000Z"),
        endsAt: new Date("2026-08-14T12:34:00.000Z"),
        multiplier: 2,
      },
    ],
  });
  assert.equal(plan.plan, "DEPENDENCY_CLOSURE");
  assert.equal(plan.validUntil.toISOString(), "2026-08-14T12:04:00.000Z");
});

test("a linked component above the 64 cap forces FULL", async () => {
  const size = MAX_DEPENDENCY_CLOSURE_PARTICIPANTS + 1;
  const participants = Array.from({ length: size }, (_, index) =>
    participant(`p${String(index).padStart(3, "0")}`)
  );
  // One chain through every participant.
  const effects = participants.slice(1).map((row, index) =>
    leech(`l${index}`, participants[index].id, row.userId)
  );
  assert.equal(
    oracleClosure({ participants, effects, seeds: [participants[0].id] }).length,
    size
  );
  await assertFullBecause(CLOSURE_FALLBACK_REASONS.CLOSURE_CAP_EXCEEDED, {
    participants,
    effects,
    dirty: [participants[0].id],
  });
});

test("a component exactly at the cap is still admitted", async () => {
  const size = MAX_DEPENDENCY_CLOSURE_PARTICIPANTS;
  const participants = Array.from({ length: size }, (_, index) =>
    participant(`p${String(index).padStart(3, "0")}`)
  );
  const effects = participants.slice(1).map((row, index) =>
    leech(`l${index}`, participants[index].id, row.userId)
  );
  const { plan } = await planFor({
    participants,
    effects,
    dirty: [participants[0].id],
  });
  assert.equal(plan.plan, "DEPENDENCY_CLOSURE");
  assert.equal(plan.participantIds.length, size);
});

test("a due snapshot-at-expiry effect OUTSIDE the closure forces FULL, inside does not", async () => {
  const participants = [participant("p1"), participant("p2")];
  const due = { expiresAt: new Date("2026-08-14T11:59:00.000Z") };
  await assertFullBecause(CLOSURE_FALLBACK_REASONS.DUE_EXPIRY_OUTSIDE_CLOSURE, {
    participants,
    effects: [effect("e-due", "RUNNERS_HIGH", "p2", due)],
  });
  await assertFullBecause(CLOSURE_FALLBACK_REASONS.DUE_EXPIRY_OUTSIDE_CLOSURE, {
    participants,
    // DRILL_SERGEANT is not in SNAPSHOT_AT_EXPIRY_TYPES but its dare judgement
    // reads the same participantSteps map and skips a missing key silently.
    effects: [effect("e-dare", "DRILL_SERGEANT", "p2", due)],
  });
  const { plan } = await planFor({
    participants,
    effects: [effect("e-due", "RUNNERS_HIGH", "p1", due)],
  });
  assert.equal(plan.plan, "DEPENDENCY_CLOSURE");
});

test("an unknown stored Hitchhike scoring version forces FULL", async () => {
  await assertFullBecause(CLOSURE_FALLBACK_REASONS.UNSUPPORTED_HITCHHIKE_VERSION, {
    participants: [participant("p1"), participant("p2")],
    effects: [hitchhike("h1", "p1", "u-p2", 3)],
  });
  await assertFullBecause(CLOSURE_FALLBACK_REASONS.UNSUPPORTED_HITCHHIKE_VERSION, {
    participants: [participant("p1"), participant("p2")],
    effects: [hitchhike("h1", "p1", "u-p2", "banana")],
  });
});

test("only the {STEP_SYNC} and {STEP_SYNC, DISPLAY_REFRESH} reason sets are admitted", async () => {
  for (const reasons of [
    ["STEP_SYNC", "DISPLAY_REFRESH"],
    ["DISPLAY_REFRESH", "STEP_SYNC"],
  ]) {
    const { plan } = await planFor({ reasons });
    assert.equal(plan.plan, "DEPENDENCY_CLOSURE", reasons.join("+"));
  }
  for (const reasons of [
    ["STEP_SYNC", "BOX_OPEN"],
    ["DISPLAY_REFRESH"],
    ["RECOVERY"],
    ["STEP_SYNC", "DISPLAY_REFRESH", "POWERUP_MUTATION"],
    [],
    null,
  ]) {
    await assertFullBecause(CLOSURE_FALLBACK_REASONS.NOT_STEP_SYNC_REASON_SET, {
      reasons,
    });
  }
});

test("an incoherent committed uploader snapshot forces FULL", async () => {
  // Token newer than the claim: the uploader's row moved after the job started.
  await assertFullBecause(CLOSURE_FALLBACK_REASONS.UPLOADER_SNAPSHOT_INCOHERENT, {
    participants: [
      participant("p1", { totalsUpdatedAt: new Date("2026-08-14T12:00:06.000Z") }),
    ],
  });
  await assertFullBecause(CLOSURE_FALLBACK_REASONS.UPLOADER_SNAPSHOT_INCOHERENT, {
    participants: [participant("p1", { totalsUpdatedAt: null })],
  });
  await assertFullBecause(CLOSURE_FALLBACK_REASONS.UPLOADER_SNAPSHOT_INCOHERENT, {
    participants: [participant("p1", { status: "DECLINED" })],
  });
  await assertFullBecause(CLOSURE_FALLBACK_REASONS.UPLOADER_SNAPSHOT_INCOHERENT, {
    participants: [participant("p1", { rawSteps: null })],
  });
  // Dirty row whose user never triggered the job.
  await assertFullBecause(CLOSURE_FALLBACK_REASONS.UPLOADER_SNAPSHOT_INCOHERENT, {
    participants: [participant("p1")],
    triggeredBy: ["someone-else"],
  });
});

test("a non-ACTIVE race, an ended race, and a failed read all fail closed", async () => {
  await assertFullBecause(CLOSURE_FALLBACK_REASONS.RACE_NOT_ACTIVE, {
    race: { status: "COMPLETED" },
  });
  await assertFullBecause(CLOSURE_FALLBACK_REASONS.RACE_WINDOW_CLOSED, {
    race: { endsAt: new Date("2026-08-14T11:00:00.000Z") },
  });
  const input = world({});
  input.RaceActiveEffect = {
    async findActiveForRace() {
      throw new Error("boom");
    },
    async findRaceEffectsByType() {
      return [];
    },
  };
  const plan = await buildRaceScoringDependencyClosure(input);
  assert.equal(plan.fallbackReason, CLOSURE_FALLBACK_REASONS.GRAPH_READ_FAILED);
  const noFingerprint = world({});
  noFingerprint.buildInputFingerprint = async () => null;
  assert.equal(
    (await buildRaceScoringDependencyClosure(noFingerprint)).fallbackReason,
    CLOSURE_FALLBACK_REASONS.FINGERPRINT_UNAVAILABLE
  );
});

test("a malformed dependency row forces FULL instead of a silent half-edge", async () => {
  await assertFullBecause(CLOSURE_FALLBACK_REASONS.EFFECT_ROW_MALFORMED, {
    participants: [participant("p1"), participant("p2")],
    effects: [leech("l1", "p1", "u-p2", { sourceUserId: null })],
  });
});

// ---------------------------------------------------------------------------
// Fingerprint / deadline pinning (spec rule 7)
// ---------------------------------------------------------------------------

test("the exclusive deadline is the minimum over the whole boundary set", async () => {
  const participants = [participant("p1"), participant("p2")];
  // A GHOST_PEPPER on the uploader whose boost->freeze transition (an
  // INTRA-effect multiplierBoundaries instant) precedes every startsAt /
  // expiresAt boundary. computeArtifactReuseDeadline's startsAt/expiresAt-only
  // enumeration would have missed it and reused a stale closure across a
  // multiplier change.
  const pepper = effect("e-pepper", "GHOST_PEPPER", "p1", {
    startsAt: new Date("2026-08-14T11:50:00.000Z"),
    expiresAt: new Date("2026-08-14T12:50:00.000Z"),
    metadata: { boostMs: 15 * 60 * 1000, multiplier: 3 },
  });
  const { plan } = await planFor({
    participants,
    effects: [pepper],
    nextSampleBoundary: new Date("2026-08-14T12:10:00.000Z"),
  });
  assert.equal(plan.plan, "DEPENDENCY_CLOSURE");
  // 11:50 + 15m = 12:05, earlier than the 12:10 sample boundary, the 12:50
  // expiry and the 23:00 race end.
  assert.equal(plan.validUntil.toISOString(), "2026-08-14T12:05:00.000Z");
});

test("the next closed-sample boundary participates in the deadline", async () => {
  const early = await planFor({
    participants: [participant("p1")],
    nextSampleBoundary: new Date("2026-08-14T12:03:20.000Z"),
  });
  assert.equal(early.plan.validUntil.toISOString(), "2026-08-14T12:03:20.000Z");
});

test("validUntil is capped even when no visible boundary is near", async () => {
  // Race ends 11 hours out and there is nothing else to see. Without the cap
  // the closure would claim validity for the rest of the race, which is a
  // promise a candidate-time read cannot make: a global event created after the
  // read, or a sample bucket for a user we did not select, is invisible here.
  const { plan } = await planFor({ participants: [participant("p1")] });
  assert.equal(
    plan.validUntil.getTime(),
    NOW.getTime() + MAX_CLOSURE_VALIDITY_MS
  );
  assert.ok(plan.validUntil.getTime() < RACE_ENDS_AT.getTime());
});

test("a legacy Hitchhike row pins the deadline to the next top of hour", async () => {
  const participants = [participant("p1"), participant("p2")];
  // Inside the validity cap, so the top-of-hour boundary is the binding one.
  const now = new Date("2026-08-14T12:55:00.000Z");
  const { plan } = await planFor({
    participants,
    now,
    claimStartedAt: new Date("2026-08-14T12:55:05.000Z"),
    effects: [
      hitchhike("h1", "p1", "u-p2", 1, {
        startsAt: new Date("2026-08-14T11:00:00.000Z"),
        expiresAt: new Date("2026-08-14T14:00:00.000Z"),
      }),
    ],
  });
  assert.equal(plan.validUntil.toISOString(), "2026-08-14T13:00:00.000Z");
});

test("a graph row transition changes the fingerprint", async () => {
  const participants = [participant("p1"), participant("p2")];
  const active = leech("l1", "p1", "u-p2");
  const expired = { ...active, status: "EXPIRED" };
  const before = await planFor({ participants, effects: [active] });
  const after = await planFor({ participants, effects: [expired] });
  assert.notEqual(before.plan.graphFingerprint, after.plan.graphFingerprint);
  // …and the closure itself is unchanged: the EXPIRED row is still an input.
  assert.deepEqual(before.plan.participantIds, after.plan.participantIds);
});

// ---------------------------------------------------------------------------
// TRAIL_MINE: closure-eligible with escalation (never a veto)
// ---------------------------------------------------------------------------

test("an active TRAIL_MINE does not veto and is surfaced for the shadow log", async () => {
  const participants = [participant("p1"), participant("p2")];
  const mine = effect("e-mine", "TRAIL_MINE", "p2", {
    metadata: {
      positionSteps: 5000,
      penaltyPercent: 0.1,
      ownerParticipantId: "p2",
      aheadParticipantIds: ["p2"],
    },
  });
  const { plan } = await planFor({ participants, effects: [mine] });
  assert.equal(plan.plan, "DEPENDENCY_CLOSURE");
  assert.equal(plan.minesActive, true);
  assert.equal(plan.mines.length, 1);
  assert.deepEqual(Object.keys(plan.participantTotals).sort(), ["p1", "p2"]);
});

test("wouldTrailMineEscalate fires only for a NON-closure candidate", async () => {
  const mines = [
    {
      id: "m1",
      targetParticipantId: "p9",
      metadata: {
        positionSteps: 5000,
        penaltyPercent: 0.1,
        ownerParticipantId: "p9",
        aheadParticipantIds: ["p9"],
      },
    },
  ];
  const totals = {
    p1: { totalSteps: 6000, previousTotalSteps: 4000, forfeitedAt: null },
    p2: { totalSteps: 6000, previousTotalSteps: 4000, forfeitedAt: null },
    p9: { totalSteps: 9000, previousTotalSteps: 9000, forfeitedAt: null },
  };
  // p2 crossed and is outside the closure -> the generation must escalate.
  assert.equal(
    wouldTrailMineEscalate({ mines, closureIds: ["p1"], participantTotals: totals }),
    true
  );
  // Every crosser inside the closure -> the detonation can stay scoped.
  assert.equal(
    wouldTrailMineEscalate({
      mines,
      closureIds: ["p1", "p2"],
      participantTotals: totals,
    }),
    false
  );
  // The owner never trips their own mine, and a forfeited row is frozen.
  assert.equal(
    wouldTrailMineEscalate({
      mines,
      closureIds: ["p1", "p2"],
      participantTotals: {
        ...totals,
        p3: { totalSteps: 7000, previousTotalSteps: 1000, forfeitedAt: new Date() },
      },
    }),
    false
  );
  // A mine with a non-numeric threshold is skipped, exactly as triggerTrailMines does.
  assert.equal(
    wouldTrailMineEscalate({
      mines: [{ id: "m2", metadata: { positionSteps: "5000", penaltyPercent: 0.1 } }],
      closureIds: ["p1"],
      participantTotals: totals,
    }),
    false
  );
});

test("a legacy mine without a previous total reports UNKNOWN, never a definite no", async () => {
  const mines = [
    {
      id: "m1",
      targetParticipantId: "p9",
      // No aheadParticipantIds: planted by a pre-2026-08-07 binary. Rows like
      // this carry a null expiresAt and are STILL ACTIVE in prod.
      metadata: { positionSteps: 5000, penaltyPercent: 0.1 },
    },
  ];
  // A provable crossing is still a definite escalate.
  assert.equal(
    wouldTrailMineEscalate({
      mines,
      closureIds: ["p1"],
      participantTotals: { p2: { totalSteps: 6000, previousTotalSteps: 4000 } },
    }),
    true
  );
  // With ONLY the persisted total there is no way to answer "were they already
  // ahead when it was planted?". Reporting false here would be a definite
  // negative for an unanswered question, and the cost is the wrong player
  // taking the mine. Callers escalate on UNKNOWN.
  assert.equal(
    wouldTrailMineEscalate({
      mines,
      closureIds: ["p1"],
      participantTotals: { p2: { totalSteps: 6000 } },
    }),
    TRAIL_MINE_ESCALATION_UNKNOWN
  );
  assert.notEqual(TRAIL_MINE_ESCALATION_UNKNOWN, false);
  // Nobody at or past the threshold is a genuine, answerable no.
  assert.equal(
    wouldTrailMineEscalate({
      mines,
      closureIds: ["p1"],
      participantTotals: { p2: { totalSteps: 100 } },
    }),
    false
  );
  // A definite candidate anywhere outranks an UNKNOWN elsewhere.
  assert.equal(
    wouldTrailMineEscalate({
      mines,
      closureIds: ["p1"],
      participantTotals: {
        p2: { totalSteps: 6000 },
        p3: { totalSteps: 7000, previousTotalSteps: 100 },
      },
    }),
    true
  );
});

test("the planner's own participantTotals never fabricate a previous total", async () => {
  const participants = [participant("p1"), participant("p2")];
  const { plan } = await planFor({ participants });
  // participantTotalsFrom must leave previousTotalSteps undefined; aliasing it
  // to the persisted total is exactly what turned the legacy branch into a
  // silent "no".
  assert.equal(plan.participantTotals.p2.previousTotalSteps, undefined);
  assert.equal(
    wouldTrailMineEscalate({
      mines: [
        {
          id: "m1",
          targetParticipantId: "p9",
          metadata: { positionSteps: 500, penaltyPercent: 0.1 },
        },
      ],
      closureIds: plan.participantIds,
      participantTotals: plan.participantTotals,
    }),
    TRAIL_MINE_ESCALATION_UNKNOWN
  );
});
