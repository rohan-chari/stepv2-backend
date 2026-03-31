const assert = require("node:assert/strict");
const test = require("node:test");
const { buildCompleteRace } = require("../../src/commands/completeRace");

// ---------------------------------------------------------------------------
// expireAllForRace — on race completion, all HELD, MYSTERY_BOX, and QUEUED
// powerups should be expired. USED and DISCARDED should be left alone.
// ---------------------------------------------------------------------------

function makeDeps(powerups = []) {
  const events = [];
  const expiredPowerups = [];
  const expiredEffects = [];

  return {
    events,
    expiredPowerups,
    expiredEffects,
    deps: {
      Race: {
        async updateIfActive(raceId, fields) {
          return { count: 1 };
        },
        async findById(raceId) {
          return { id: raceId, status: "COMPLETED" };
        },
      },
      RacePowerup: {
        async expireAllForRace(raceId) {
          // Simulate the real method: expire HELD, MYSTERY_BOX, QUEUED
          for (const p of powerups) {
            if (["HELD", "MYSTERY_BOX", "QUEUED"].includes(p.status)) {
              expiredPowerups.push({ id: p.id, oldStatus: p.status });
              p.status = "EXPIRED";
            }
          }
        },
      },
      RaceActiveEffect: {
        async expireAllForRace(raceId) {
          expiredEffects.push(raceId);
        },
      },
      eventBus: {
        emit(event, payload) {
          events.push({ event, payload });
        },
      },
    },
  };
}

test("completeRace calls expireAllForRace on powerups", async () => {
  const powerups = [
    { id: "pw-1", status: "HELD" },
    { id: "pw-2", status: "MYSTERY_BOX" },
  ];
  const ctx = makeDeps(powerups);
  const complete = buildCompleteRace(ctx.deps);

  await complete({ raceId: "race-1", winnerUserId: "user-1", participantUserIds: ["user-1"] });

  assert.equal(ctx.expiredPowerups.length, 2);
  assert.equal(powerups[0].status, "EXPIRED");
  assert.equal(powerups[1].status, "EXPIRED");
});

test("QUEUED powerups are expired on race completion", async () => {
  const powerups = [
    { id: "pw-1", status: "QUEUED" },
    { id: "pw-2", status: "QUEUED" },
    { id: "pw-3", status: "MYSTERY_BOX" },
  ];
  const ctx = makeDeps(powerups);
  const complete = buildCompleteRace(ctx.deps);

  await complete({ raceId: "race-1", winnerUserId: "user-1", participantUserIds: ["user-1"] });

  assert.equal(ctx.expiredPowerups.length, 3);
  for (const p of powerups) {
    assert.equal(p.status, "EXPIRED");
  }
});

test("USED and DISCARDED powerups are NOT expired on race completion", async () => {
  const powerups = [
    { id: "pw-1", status: "USED" },
    { id: "pw-2", status: "DISCARDED" },
    { id: "pw-3", status: "HELD" },
  ];
  const ctx = makeDeps(powerups);
  const complete = buildCompleteRace(ctx.deps);

  await complete({ raceId: "race-1", winnerUserId: "user-1", participantUserIds: ["user-1"] });

  // Only the HELD one should be expired
  assert.equal(ctx.expiredPowerups.length, 1);
  assert.equal(ctx.expiredPowerups[0].id, "pw-3");
  assert.equal(powerups[0].status, "USED");
  assert.equal(powerups[1].status, "DISCARDED");
  assert.equal(powerups[2].status, "EXPIRED");
});

test("mix of all statuses — only HELD, MYSTERY_BOX, QUEUED are expired", async () => {
  const powerups = [
    { id: "pw-1", status: "HELD" },
    { id: "pw-2", status: "MYSTERY_BOX" },
    { id: "pw-3", status: "QUEUED" },
    { id: "pw-4", status: "USED" },
    { id: "pw-5", status: "DISCARDED" },
    { id: "pw-6", status: "EXPIRED" },
  ];
  const ctx = makeDeps(powerups);
  const complete = buildCompleteRace(ctx.deps);

  await complete({ raceId: "race-1", winnerUserId: "user-1", participantUserIds: ["user-1"] });

  assert.equal(ctx.expiredPowerups.length, 3);
  const expiredIds = ctx.expiredPowerups.map((p) => p.id);
  assert.ok(expiredIds.includes("pw-1"));
  assert.ok(expiredIds.includes("pw-2"));
  assert.ok(expiredIds.includes("pw-3"));

  assert.equal(powerups[3].status, "USED");
  assert.equal(powerups[4].status, "DISCARDED");
  assert.equal(powerups[5].status, "EXPIRED");
});

test("no powerups to expire — completeRace still succeeds", async () => {
  const powerups = [];
  const ctx = makeDeps(powerups);
  const complete = buildCompleteRace(ctx.deps);

  const result = await complete({ raceId: "race-1", winnerUserId: "user-1", participantUserIds: ["user-1"] });

  assert.equal(ctx.expiredPowerups.length, 0);
  assert.ok(result);
});

test("race completion emits RACE_COMPLETED event after expiring powerups", async () => {
  const powerups = [
    { id: "pw-1", status: "QUEUED" },
  ];
  const ctx = makeDeps(powerups);
  const complete = buildCompleteRace(ctx.deps);

  await complete({ raceId: "race-1", winnerUserId: "user-1", participantUserIds: ["user-1", "user-2"] });

  // Powerup expired before event
  assert.equal(ctx.expiredPowerups.length, 1);
  assert.equal(ctx.events.length, 1);
  assert.equal(ctx.events[0].event, "RACE_COMPLETED");
  assert.deepEqual(ctx.events[0].payload.participantUserIds, ["user-1", "user-2"]);
});

test("already EXPIRED powerups are not double-expired", async () => {
  const powerups = [
    { id: "pw-1", status: "EXPIRED" },
    { id: "pw-2", status: "EXPIRED" },
  ];
  const ctx = makeDeps(powerups);
  const complete = buildCompleteRace(ctx.deps);

  await complete({ raceId: "race-1", winnerUserId: "user-1", participantUserIds: ["user-1"] });

  assert.equal(ctx.expiredPowerups.length, 0);
});
