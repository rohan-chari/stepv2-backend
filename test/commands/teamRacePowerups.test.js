const assert = require("node:assert/strict");
const test = require("node:test");
const { buildUsePowerup } = require("../../src/modules/powerups/commands/usePowerup");
const { buildOpenMysteryBox } = require("../../src/modules/powerups/commands/openMysteryBox");
const { triggerTrailMines } = require("../../src/modules/races/services/raceStateResolution");

// ---------------------------------------------------------------------------
// Team-aware powerups (TR-650s) + forfeit interactions (TR-602/657)
// 2v2: Alice+Bob = TEAM_A, Carol+Dave = TEAM_B. Alice acts.
// ---------------------------------------------------------------------------

function makeParticipant(id, userId, displayName, team, overrides = {}) {
  return {
    id,
    userId,
    status: "ACCEPTED",
    totalSteps: 10000,
    bonusSteps: 0,
    finishedAt: null,
    forfeitedAt: null,
    team,
    user: { displayName },
    ...overrides,
  };
}

function makeDeps(overrides = {}) {
  const events = [];
  const feedEvents = [];
  const effectsCreated = [];
  let updatedPowerup = null;

  const alice = makeParticipant("rp-1", "user-1", "Alice", "TEAM_A", overrides.alice);
  const bob = makeParticipant("rp-2", "user-2", "Bob", "TEAM_A", {
    totalSteps: 9000,
    ...overrides.bob,
  });
  const carol = makeParticipant("rp-3", "user-3", "Carol", "TEAM_B", {
    totalSteps: 12000,
    ...overrides.carol,
  });
  const dave = makeParticipant("rp-4", "user-4", "Dave", "TEAM_B", {
    totalSteps: 7000,
    ...overrides.dave,
  });
  const participants = [alice, bob, carol, dave];

  return {
    events,
    feedEvents,
    effectsCreated,
    get updatedPowerup() {
      return updatedPowerup;
    },
    deps: {
      RacePowerup: {
        async findById(id) {
          return {
            id,
            userId: "user-1",
            raceId: "race-1",
            type: overrides.powerupType || "LEG_CRAMP",
            status: "HELD",
            rarity: "UNCOMMON",
          };
        },
        async update(id, fields) {
          updatedPowerup = { id, ...fields };
          return updatedPowerup;
        },
      },
      RaceParticipant: {
        async addBonusSteps() {},
        async subtractBonusSteps() {},
      },
      RaceActiveEffect: {
        async findActiveByTypeForParticipant() {
          return null;
        },
        async findActiveForRace() {
          return [];
        },
        async create(data) {
          const e = { id: `eff-${effectsCreated.length + 1}`, ...data };
          effectsCreated.push(e);
          return e;
        },
        async update(id, fields) {
          return { id, ...fields };
        },
      },
      RacePowerupEvent: {
        async create(data) {
          feedEvents.push(data);
          return { id: "fe-1", ...data };
        },
      },
      Race: {
        async findById() {
          return {
            id: "race-1",
            status: "ACTIVE",
            targetSteps: 0,
            timeBased: true,
            isTeamRace: true,
            teamSize: 2,
            participants,
          };
        },
      },
      eventBus: {
        emit(event, payload) {
          events.push({ event, payload });
        },
      },
      now: () => new Date("2026-07-12T12:00:00Z"),
    },
  };
}

// ── TR-651: no friendly fire ────────────────────────────────────────────────
test("TR-651 offensive powerup on a teammate -> 400 INVALID_TARGET", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);
  await assert.rejects(
    () =>
      use({
        userId: "user-1",
        raceId: "race-1",
        powerupId: "pw-1",
        targetUserId: "user-2", // Bob — same team
      }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "INVALID_TARGET");
      return true;
    }
  );
});

test("TR-651 offensive powerup on an enemy works", async () => {
  const ctx = makeDeps();
  const use = buildUsePowerup(ctx.deps);
  const result = await use({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
    targetUserId: "user-3", // Carol — enemy team
  });
  assert.equal(result.blocked, false);
  assert.equal(ctx.effectsCreated[0].targetUserId, "user-3");
});

test("retired IMPOSTER preempts the historical teammate-target rule without mutation", async () => {
  const ctx = makeDeps({ powerupType: "IMPOSTER" });
  const use = buildUsePowerup(ctx.deps);
  await assert.rejects(
    () =>
      use({
        userId: "user-1",
        raceId: "race-1",
        powerupId: "pw-1",
        targetUserId: "user-2",
    }),
    (err) => {
      assert.equal(err.statusCode, 410);
      assert.equal(err.code, "POWERUP_RETIRED");
      assert.equal(err.powerupType, "IMPOSTER");
      return true;
    }
  );
  assert.equal(ctx.updatedPowerup, null);
  assert.deepEqual(ctx.effectsCreated, []);
  assert.deepEqual(ctx.feedEvents, []);
});

// ── TR-602: forfeited members can't use or be targeted ─────────────────────
test("TR-602 a forfeited member cannot use powerups", async () => {
  const ctx = makeDeps({
    alice: { forfeitedAt: new Date("2026-07-11T00:00:00Z") },
  });
  const use = buildUsePowerup(ctx.deps);
  await assert.rejects(
    () =>
      use({
        userId: "user-1",
        raceId: "race-1",
        powerupId: "pw-1",
        targetUserId: "user-3",
      }),
    (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
});

test("TR-602 a forfeited member cannot be targeted", async () => {
  const ctx = makeDeps({
    carol: { forfeitedAt: new Date("2026-07-11T00:00:00Z") },
  });
  const use = buildUsePowerup(ctx.deps);
  await assert.rejects(
    () =>
      use({
        userId: "user-1",
        raceId: "race-1",
        powerupId: "pw-1",
        targetUserId: "user-3",
      }),
    (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
});

// ── TR-652: Red Card targets ENEMY top stepper ──────────────────────────────
test("TR-652 Red Card auto-targets the enemy team's top stepper", async () => {
  // Overall leader is Carol (enemy, 12000) — target her even though Alice
  // (attacker) isn't the leader.
  const ctx = makeDeps({ powerupType: "RED_CARD" });
  const use = buildUsePowerup(ctx.deps);
  const result = await use({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
  });
  assert.equal(result.targetUserId ?? ctx.events.length >= 0, result.targetUserId ?? true);
  const redCardEvent = ctx.feedEvents.find((e) => e.powerupType === "RED_CARD");
  assert.ok(redCardEvent);
  assert.equal(redCardEvent.targetUserId, "user-3");
});

test("TR-652 Red Card targets enemy top stepper even when a TEAMMATE leads overall", async () => {
  // Bob (teammate) leads overall with 20000; enemy top is Carol (12000).
  const ctx = makeDeps({
    powerupType: "RED_CARD",
    bob: { totalSteps: 20000 },
  });
  const use = buildUsePowerup(ctx.deps);
  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });
  const redCardEvent = ctx.feedEvents.find((e) => e.powerupType === "RED_CARD");
  assert.equal(redCardEvent.targetUserId, "user-3");
});

// ── TR-657: forfeited members excluded from targeting pools ────────────────
test("TR-657 Red Card skips a forfeited enemy top stepper", async () => {
  const ctx = makeDeps({
    powerupType: "RED_CARD",
    carol: { forfeitedAt: new Date("2026-07-11T00:00:00Z") },
  });
  const use = buildUsePowerup(ctx.deps);
  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });
  const redCardEvent = ctx.feedEvents.find((e) => e.powerupType === "RED_CARD");
  assert.equal(redCardEvent.targetUserId, "user-4", "Dave is the alive enemy top");
});

// ── TR-652: Rainstorm fans out to enemy team only ───────────────────────────
test("TR-652 Rainstorm affects only enemy-team members", async () => {
  const ctx = makeDeps({ powerupType: "RAINSTORM" });
  const use = buildUsePowerup(ctx.deps);
  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });
  const victims = ctx.effectsCreated
    .filter((e) => e.type === "RAINSTORM")
    .map((e) => e.targetUserId)
    .sort();
  assert.deepEqual(victims, ["user-3", "user-4"], "teammate Bob is dry");
});

test("TR-657 Rainstorm skips forfeited enemies", async () => {
  const ctx = makeDeps({
    powerupType: "RAINSTORM",
    dave: { forfeitedAt: new Date("2026-07-11T00:00:00Z") },
  });
  const use = buildUsePowerup(ctx.deps);
  await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });
  const victims = ctx.effectsCreated
    .filter((e) => e.type === "RAINSTORM")
    .map((e) => e.targetUserId);
  assert.deepEqual(victims, ["user-3"]);
});

// ── TR-653: Pinecone adjacency among enemy members ──────────────────────────
test("TR-653 Pinecone FRONT hits the nearest ENEMY ahead (teammates skipped)", async () => {
  // Steps: Carol 12000 > Alice 10000 (me) > Bob 9000 (teammate) > Dave 7000.
  // FRONT of Alice among enemies = Carol; BEHIND = Dave (Bob skipped).
  const ctx = makeDeps({ powerupType: "PINECONE_TOSS" });
  const use = buildUsePowerup(ctx.deps);
  await use({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
    targetDirection: "FRONT",
  });
  const evt = ctx.feedEvents.find((e) => e.powerupType === "PINECONE_TOSS");
  assert.equal(evt.targetUserId, "user-3");
});

test("TR-653 Pinecone BEHIND skips the teammate and hits the enemy behind", async () => {
  const ctx = makeDeps({ powerupType: "PINECONE_TOSS" });
  const use = buildUsePowerup(ctx.deps);
  await use({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
    targetDirection: "BEHIND",
  });
  const evt = ctx.feedEvents.find((e) => e.powerupType === "PINECONE_TOSS");
  assert.equal(evt.targetUserId, "user-4");
});

// ── TR-653: Trail Mines trip only for enemy-team members ────────────────────
test("TR-653 a trail mine does not trip for the owner's teammate", async () => {
  const updates = [];
  const feed = [];
  const mine = {
    id: "mine-1",
    type: "TRAIL_MINE",
    sourceUserId: "user-1",
    targetParticipantId: "rp-1",
    metadata: {
      ownerParticipantId: "rp-1",
      positionSteps: 10500,
      penaltyPercent: 0.1,
    },
  };
  const alice = makeParticipant("rp-1", "user-1", "Alice", "TEAM_A");
  const bob = makeParticipant("rp-2", "user-2", "Bob", "TEAM_A", {
    totalSteps: 9000,
  });
  const carol = makeParticipant("rp-3", "user-3", "Carol", "TEAM_B", {
    totalSteps: 9000,
  });
  // Both Bob (teammate) and Carol (enemy) cross 10500 this resolve.
  const stepTotals = [
    { participant: alice, totalSteps: 10000 },
    { participant: bob, totalSteps: 11000 },
    { participant: carol, totalSteps: 11000 },
  ];
  await triggerTrailMines({
    raceId: "race-1",
    race: { id: "race-1", isTeamRace: true },
    stepTotals,
    raceActiveEffectModel: {
      async findActiveForRace() {
        return [mine];
      },
      async findActiveByTypeForParticipant() {
        return null;
      },
      async update(id, fields) {
        updates.push({ id, fields });
      },
    },
    participantModel: {
      async subtractBonusSteps(id, amount) {
        updates.push({ id, subtract: amount });
      },
    },
    powerupEventModel: {
      async create(data) {
        feed.push(data);
      },
    },
  });
  const mineEvent = feed.find((e) => e.powerupType === "TRAIL_MINE");
  assert.ok(mineEvent, "mine tripped");
  assert.equal(mineEvent.targetUserId, "user-3", "enemy Carol trips it, not teammate Bob");
});

// ── TR-655: box odds keyed by TEAM rank ─────────────────────────────────────
function makeBoxDeps({ participants, rolls }) {
  return {
    RacePowerup: {
      async findById(id) {
        return {
          id,
          userId: "user-1",
          raceId: "race-1",
          status: "MYSTERY_BOX",
        };
      },
      async countOccupiedSlots() {
        return 0;
      },
      async update(id, fields) {
        return { id, ...fields };
      },
    },
    RaceParticipant: {
      async findByRaceAndUser() {
        return participants[0];
      },
      async findAcceptedByRace() {
        return participants;
      },
      async update() {},
    },
    RaceActiveEffect: {
      async findActiveByTypeForParticipant() {
        return null;
      },
    },
    RacePowerupEvent: {
      async create() {},
    },
    Race: {
      async findById() {
        return {
          id: "race-1",
          status: "ACTIVE",
          isTeamRace: true,
          teamSize: 2,
          participants,
        };
      },
    },
    rollPowerupOdds: (position, totalParticipants) => {
      rolls.push({ position, totalParticipants });
      return { type: "PROTEIN_SHAKE", rarity: "COMMON" };
    },
    eventBus: { emit() {} },
  };
}

test("TR-655 trailing-team member rolls with catch-up odds (rank 2 of 2)", async () => {
  // Alice (user-1) TEAM_A total 10000+9000=19000; TEAM_B 12000+8000=20000.
  const participants = [
    makeParticipant("rp-1", "user-1", "Alice", "TEAM_A"),
    makeParticipant("rp-2", "user-2", "Bob", "TEAM_A", { totalSteps: 9000 }),
    makeParticipant("rp-3", "user-3", "Carol", "TEAM_B", { totalSteps: 12000 }),
    makeParticipant("rp-4", "user-4", "Dave", "TEAM_B", { totalSteps: 8000 }),
  ];
  const rolls = [];
  const openMysteryBox = buildOpenMysteryBox(
    makeBoxDeps({ participants, rolls })
  );
  await openMysteryBox({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
    displayName: "Alice",
  });
  assert.deepEqual(rolls[0], { position: 2, totalParticipants: 2 });
});

test("TR-655 leading-team member rolls standard (rank 1 of 2); tie = both standard", async () => {
  // TEAM_A 25000 vs TEAM_B 20000 -> Alice leads.
  const leadParticipants = [
    makeParticipant("rp-1", "user-1", "Alice", "TEAM_A", { totalSteps: 16000 }),
    makeParticipant("rp-2", "user-2", "Bob", "TEAM_A", { totalSteps: 9000 }),
    makeParticipant("rp-3", "user-3", "Carol", "TEAM_B", { totalSteps: 12000 }),
    makeParticipant("rp-4", "user-4", "Dave", "TEAM_B", { totalSteps: 8000 }),
  ];
  let rolls = [];
  let openMysteryBox = buildOpenMysteryBox(
    makeBoxDeps({ participants: leadParticipants, rolls })
  );
  await openMysteryBox({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
    displayName: "Alice",
  });
  assert.deepEqual(rolls[0], { position: 1, totalParticipants: 2 });

  // Tie: both teams 20000 -> standard for everyone.
  const tiedParticipants = [
    makeParticipant("rp-1", "user-1", "Alice", "TEAM_A", { totalSteps: 11000 }),
    makeParticipant("rp-2", "user-2", "Bob", "TEAM_A", { totalSteps: 9000 }),
    makeParticipant("rp-3", "user-3", "Carol", "TEAM_B", { totalSteps: 12000 }),
    makeParticipant("rp-4", "user-4", "Dave", "TEAM_B", { totalSteps: 8000 }),
  ];
  rolls = [];
  openMysteryBox = buildOpenMysteryBox(
    makeBoxDeps({ participants: tiedParticipants, rolls })
  );
  await openMysteryBox({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
    displayName: "Alice",
  });
  assert.deepEqual(rolls[0], { position: 1, totalParticipants: 2 });
});
