const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildEditRace,
  RaceEditError,
} = require("../../src/commands/editRace");

const DEFAULT_RACE = {
  id: "race-1",
  creatorId: "user-1",
  name: "Existing Race",
  targetSteps: 50000,
  powerupsEnabled: false,
  powerupStepInterval: null,
  buyInAmount: 0,
  payoutPreset: "WINNER_TAKES_ALL",
  isPublic: false,
  maxParticipants: 10,
  status: "PENDING",
};

function makeDeps(overrides = {}) {
  const events = [];
  let updateCall = null;
  const raceState = { ...DEFAULT_RACE, ...(overrides.raceOverrides || {}) };

  const deps = {
    Race: {
      async findById(id) {
        return { ...raceState, id };
      },
      async update(id, fields) {
        updateCall = { id, fields };
        Object.assign(raceState, fields);
        return { ...raceState, id };
      },
      ...overrides.Race,
    },
    RaceParticipant: {
      async findChargedByRace() {
        return [];
      },
      async countAccepted() {
        return 1;
      },
      ...overrides.RaceParticipant,
    },
    eventBus: {
      emit(event, payload) {
        events.push({ event, payload });
      },
    },
  };

  return {
    deps,
    events,
    raceState,
    get updateCall() {
      return updateCall;
    },
  };
}

test("editRace rejects non-creator", async () => {
  const { deps } = makeDeps();
  const editRace = buildEditRace(deps);

  await assert.rejects(
    () =>
      editRace({
        userId: "other-user",
        raceId: "race-1",
        updates: { name: "New" },
      }),
    (err) => {
      assert.ok(err instanceof RaceEditError);
      assert.equal(err.statusCode, 403);
      return true;
    }
  );
});

test("editRace rejects when status is not PENDING", async () => {
  const { deps } = makeDeps({ raceOverrides: { status: "ACTIVE" } });
  const editRace = buildEditRace(deps);

  await assert.rejects(
    () =>
      editRace({
        userId: "user-1",
        raceId: "race-1",
        updates: { name: "New" },
      }),
    (err) => {
      assert.ok(err instanceof RaceEditError);
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
});

test("editRace returns 404 when race not found", async () => {
  const { deps } = makeDeps({
    Race: {
      async findById() {
        return null;
      },
    },
  });
  const editRace = buildEditRace(deps);

  await assert.rejects(
    () =>
      editRace({
        userId: "user-1",
        raceId: "missing",
        updates: { name: "New" },
      }),
    (err) => {
      assert.ok(err instanceof RaceEditError);
      assert.equal(err.statusCode, 404);
      return true;
    }
  );
});

test("editRace updates name and trims it", async () => {
  const ctx = makeDeps();
  const editRace = buildEditRace(ctx.deps);

  await editRace({
    userId: "user-1",
    raceId: "race-1",
    updates: { name: "  Renamed  " },
  });

  assert.equal(ctx.updateCall.fields.name, "Renamed");
  assert.equal(ctx.events[0].event, "RACE_EDITED");
  assert.deepEqual(ctx.events[0].payload.updatedFields, ["name"]);
});

test("editRace rejects empty name", async () => {
  const { deps } = makeDeps();
  const editRace = buildEditRace(deps);

  await assert.rejects(
    () =>
      editRace({
        userId: "user-1",
        raceId: "race-1",
        updates: { name: "   " },
      }),
    (err) => err instanceof RaceEditError && err.statusCode === 400
  );
});

test("editRace rejects name > 50 chars", async () => {
  const { deps } = makeDeps();
  const editRace = buildEditRace(deps);

  await assert.rejects(
    () =>
      editRace({
        userId: "user-1",
        raceId: "race-1",
        updates: { name: "a".repeat(51) },
      }),
    (err) => err instanceof RaceEditError && err.statusCode === 400
  );
});

test("editRace rejects targetSteps below 1000", async () => {
  const { deps } = makeDeps();
  const editRace = buildEditRace(deps);

  await assert.rejects(
    () =>
      editRace({
        userId: "user-1",
        raceId: "race-1",
        updates: { targetSteps: 500 },
      }),
    (err) => err instanceof RaceEditError && err.statusCode === 400
  );
});

test("editRace rejects targetSteps above 1,000,000", async () => {
  const { deps } = makeDeps();
  const editRace = buildEditRace(deps);

  await assert.rejects(
    () =>
      editRace({
        userId: "user-1",
        raceId: "race-1",
        updates: { targetSteps: 2000000 },
      }),
    (err) => err instanceof RaceEditError && err.statusCode === 400
  );
});

test("editRace allows targetSteps boundary values", async () => {
  const ctx = makeDeps();
  const editRace = buildEditRace(ctx.deps);

  await editRace({
    userId: "user-1",
    raceId: "race-1",
    updates: { targetSteps: 1000 },
  });
  assert.equal(ctx.updateCall.fields.targetSteps, 1000);

  await editRace({
    userId: "user-1",
    raceId: "race-1",
    updates: { targetSteps: 1000000 },
  });
  assert.equal(ctx.updateCall.fields.targetSteps, 1000000);
});

test("editRace enables powerups with valid interval", async () => {
  const ctx = makeDeps();
  const editRace = buildEditRace(ctx.deps);

  await editRace({
    userId: "user-1",
    raceId: "race-1",
    updates: { powerupsEnabled: true, powerupStepInterval: 3000 },
  });

  assert.equal(ctx.updateCall.fields.powerupsEnabled, true);
  assert.equal(ctx.updateCall.fields.powerupStepInterval, 3000);
});

test("editRace rejects powerup interval below 2000", async () => {
  const { deps } = makeDeps();
  const editRace = buildEditRace(deps);

  await assert.rejects(
    () =>
      editRace({
        userId: "user-1",
        raceId: "race-1",
        updates: { powerupsEnabled: true, powerupStepInterval: 1000 },
      }),
    (err) => err instanceof RaceEditError && err.statusCode === 400
  );
});

test("editRace rejects powerup interval above 50000", async () => {
  const { deps } = makeDeps();
  const editRace = buildEditRace(deps);

  await assert.rejects(
    () =>
      editRace({
        userId: "user-1",
        raceId: "race-1",
        updates: { powerupsEnabled: true, powerupStepInterval: 60000 },
      }),
    (err) => err instanceof RaceEditError && err.statusCode === 400
  );
});

test("editRace rejects enabling powerups without an interval", async () => {
  const { deps } = makeDeps();
  const editRace = buildEditRace(deps);

  await assert.rejects(
    () =>
      editRace({
        userId: "user-1",
        raceId: "race-1",
        updates: { powerupsEnabled: true },
      }),
    (err) => err instanceof RaceEditError && err.statusCode === 400
  );
});

test("editRace allows toggling powerupsEnabled off without clearing interval", async () => {
  const ctx = makeDeps({
    raceOverrides: { powerupsEnabled: true, powerupStepInterval: 3000 },
  });
  const editRace = buildEditRace(ctx.deps);

  await editRace({
    userId: "user-1",
    raceId: "race-1",
    updates: { powerupsEnabled: false },
  });

  assert.equal(ctx.updateCall.fields.powerupsEnabled, false);
  assert.ok(!("powerupStepInterval" in ctx.updateCall.fields));
});

test("editRace updates maxParticipants when above accepted count", async () => {
  const ctx = makeDeps({
    RaceParticipant: {
      async countAccepted() {
        return 3;
      },
      async findChargedByRace() {
        return [];
      },
    },
  });
  const editRace = buildEditRace(ctx.deps);

  await editRace({
    userId: "user-1",
    raceId: "race-1",
    updates: { maxParticipants: 5 },
  });

  assert.equal(ctx.updateCall.fields.maxParticipants, 5);
});

test("editRace rejects maxParticipants below accepted count", async () => {
  const ctx = makeDeps({
    RaceParticipant: {
      async countAccepted() {
        return 5;
      },
      async findChargedByRace() {
        return [];
      },
    },
  });
  const editRace = buildEditRace(ctx.deps);

  await assert.rejects(
    () =>
      editRace({
        userId: "user-1",
        raceId: "race-1",
        updates: { maxParticipants: 3 },
      }),
    (err) => err instanceof RaceEditError && err.statusCode === 400
  );
});

test("editRace rejects maxParticipants outside 2-100 range", async () => {
  const { deps } = makeDeps();
  const editRace = buildEditRace(deps);

  await assert.rejects(
    () =>
      editRace({
        userId: "user-1",
        raceId: "race-1",
        updates: { maxParticipants: 1 },
      }),
    (err) => err instanceof RaceEditError && err.statusCode === 400
  );

  await assert.rejects(
    () =>
      editRace({
        userId: "user-1",
        raceId: "race-1",
        updates: { maxParticipants: 200 },
      }),
    (err) => err instanceof RaceEditError && err.statusCode === 400
  );
});

test("editRace updates isPublic", async () => {
  const ctx = makeDeps();
  const editRace = buildEditRace(ctx.deps);

  await editRace({
    userId: "user-1",
    raceId: "race-1",
    updates: { isPublic: true },
  });

  assert.equal(ctx.updateCall.fields.isPublic, true);
});

test("editRace rejects buyInAmount change when participants have paid", async () => {
  const ctx = makeDeps({
    RaceParticipant: {
      async findChargedByRace() {
        return [
          { id: "p1", userId: "u2", buyInAmount: 50, buyInStatus: "HELD" },
        ];
      },
      async countAccepted() {
        return 2;
      },
    },
  });
  const editRace = buildEditRace(ctx.deps);

  await assert.rejects(
    () =>
      editRace({
        userId: "user-1",
        raceId: "race-1",
        updates: { buyInAmount: 100, payoutPreset: "WINNER_TAKES_ALL" },
      }),
    (err) => {
      assert.ok(err instanceof RaceEditError);
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /buy-in/i);
      return true;
    }
  );
});

test("editRace allows buyInAmount change when no participants have paid", async () => {
  const ctx = makeDeps();
  const editRace = buildEditRace(ctx.deps);

  await editRace({
    userId: "user-1",
    raceId: "race-1",
    updates: { buyInAmount: 50, payoutPreset: "WINNER_TAKES_ALL" },
  });

  assert.equal(ctx.updateCall.fields.buyInAmount, 50);
  assert.equal(ctx.updateCall.fields.payoutPreset, "WINNER_TAKES_ALL");
});

test("editRace allows buyInAmount=0 (no buy-in)", async () => {
  const ctx = makeDeps({ raceOverrides: { buyInAmount: 50 } });
  const editRace = buildEditRace(ctx.deps);

  await editRace({
    userId: "user-1",
    raceId: "race-1",
    updates: { buyInAmount: 0 },
  });

  assert.equal(ctx.updateCall.fields.buyInAmount, 0);
});

test("editRace rejects buyInAmount between 1 and 9", async () => {
  const { deps } = makeDeps();
  const editRace = buildEditRace(deps);

  await assert.rejects(
    () =>
      editRace({
        userId: "user-1",
        raceId: "race-1",
        updates: { buyInAmount: 5 },
      }),
    (err) => err instanceof RaceEditError && err.statusCode === 400
  );
});

test("editRace rejects buyInAmount above 200", async () => {
  const { deps } = makeDeps();
  const editRace = buildEditRace(deps);

  await assert.rejects(
    () =>
      editRace({
        userId: "user-1",
        raceId: "race-1",
        updates: { buyInAmount: 500 },
      }),
    (err) => err instanceof RaceEditError && err.statusCode === 400
  );
});

test("editRace rejects invalid payoutPreset", async () => {
  const { deps } = makeDeps();
  const editRace = buildEditRace(deps);

  await assert.rejects(
    () =>
      editRace({
        userId: "user-1",
        raceId: "race-1",
        updates: { payoutPreset: "NOT_A_PRESET" },
      }),
    (err) => err instanceof RaceEditError && err.statusCode === 400
  );
});

test("editRace allows payoutPreset change without buyInAmount change (no charged participants check needed)", async () => {
  const ctx = makeDeps({
    raceOverrides: { buyInAmount: 50, payoutPreset: "WINNER_TAKES_ALL" },
    RaceParticipant: {
      async findChargedByRace() {
        return [
          { id: "p1", userId: "u2", buyInAmount: 50, buyInStatus: "HELD" },
        ];
      },
      async countAccepted() {
        return 2;
      },
    },
  });
  const editRace = buildEditRace(ctx.deps);

  await editRace({
    userId: "user-1",
    raceId: "race-1",
    updates: { payoutPreset: "TOP3_70_20_10" },
  });

  assert.equal(ctx.updateCall.fields.payoutPreset, "TOP3_70_20_10");
  assert.ok(!("buyInAmount" in ctx.updateCall.fields));
});

test("editRace emits RACE_EDITED with updated field list", async () => {
  const ctx = makeDeps();
  const editRace = buildEditRace(ctx.deps);

  await editRace({
    userId: "user-1",
    raceId: "race-1",
    updates: { name: "New Name", targetSteps: 60000 },
  });

  assert.equal(ctx.events.length, 1);
  assert.equal(ctx.events[0].event, "RACE_EDITED");
  assert.equal(ctx.events[0].payload.raceId, "race-1");
  assert.equal(ctx.events[0].payload.creatorUserId, "user-1");
  assert.deepEqual(
    ctx.events[0].payload.updatedFields.sort(),
    ["name", "targetSteps"].sort()
  );
});

test("editRace returns the full updated race object", async () => {
  const ctx = makeDeps();
  const editRace = buildEditRace(ctx.deps);

  const result = await editRace({
    userId: "user-1",
    raceId: "race-1",
    updates: { name: "Updated" },
  });

  assert.equal(result.id, "race-1");
  assert.equal(result.name, "Updated");
});

test("editRace with empty updates does not call update or emit", async () => {
  const ctx = makeDeps();
  const editRace = buildEditRace(ctx.deps);

  await editRace({
    userId: "user-1",
    raceId: "race-1",
    updates: {},
  });

  assert.equal(ctx.updateCall, null);
  assert.equal(ctx.events.length, 0);
});
