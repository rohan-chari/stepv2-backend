const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildEditRace,
  RaceEditError,
} = require("../../src/modules/races/commands/editRace");

const DEFAULT_RACE = {
  id: "race-1",
  creatorId: "user-1",
  name: "Existing Race",
  maxDurationDays: 7,
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

test("editRace rejects a profane name", async () => {
  const ctx = makeDeps();
  const editRace = buildEditRace(ctx.deps);

  await assert.rejects(
    () =>
      editRace({
        userId: "user-1",
        raceId: "race-1",
        updates: { name: "total shit race" },
      }),
    (err) => {
      assert.ok(err instanceof RaceEditError);
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /inappropriate/i);
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

test("editRace updates maxDurationDays", async () => {
  const ctx = makeDeps();
  const editRace = buildEditRace(ctx.deps);

  await editRace({
    userId: "user-1",
    raceId: "race-1",
    updates: { maxDurationDays: 5 },
  });

  assert.equal(ctx.updateCall.fields.maxDurationDays, 5);
  assert.equal(ctx.events[0].event, "RACE_EDITED");
  assert.deepEqual(ctx.events[0].payload.updatedFields, ["maxDurationDays"]);
});

test("editRace rejects maxDurationDays below 1", async () => {
  const { deps } = makeDeps();
  const editRace = buildEditRace(deps);

  await assert.rejects(
    () =>
      editRace({
        userId: "user-1",
        raceId: "race-1",
        updates: { maxDurationDays: 0 },
      }),
    (err) => err instanceof RaceEditError && err.statusCode === 400
  );
});

test("editRace rejects maxDurationDays above 30", async () => {
  const { deps } = makeDeps();
  const editRace = buildEditRace(deps);

  await assert.rejects(
    () =>
      editRace({
        userId: "user-1",
        raceId: "race-1",
        updates: { maxDurationDays: 31 },
      }),
    (err) => err instanceof RaceEditError && err.statusCode === 400
  );
});

test("editRace rejects non-integer maxDurationDays", async () => {
  const { deps } = makeDeps();
  const editRace = buildEditRace(deps);

  await assert.rejects(
    () =>
      editRace({
        userId: "user-1",
        raceId: "race-1",
        updates: { maxDurationDays: 3.5 },
      }),
    (err) => err instanceof RaceEditError && err.statusCode === 400
  );
});

test("editRace allows maxDurationDays boundary values", async () => {
  const ctx = makeDeps();
  const editRace = buildEditRace(ctx.deps);

  await editRace({
    userId: "user-1",
    raceId: "race-1",
    updates: { maxDurationDays: 1 },
  });
  assert.equal(ctx.updateCall.fields.maxDurationDays, 1);

  await editRace({
    userId: "user-1",
    raceId: "race-1",
    updates: { maxDurationDays: 30 },
  });
  assert.equal(ctx.updateCall.fields.maxDurationDays, 30);
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

// Issue 4: with the buyInEditEnabled kill switch ON (default) a PENDING race
// with paid participants ALLOWS the buy-in change and reconciles every ACCEPTED
// participant's hold (charge the delta on a raise). With the kill switch OFF the
// old hard block (IMMUTABLE_FIELD) still applies.
test("editRace reconciles the buy-in when participants have paid; kill switch gates the old block", async () => {
  function buildCtx({ buyInEditEnabled }) {
    const awards = [];
    const participantUpdates = [];
    const parts = [
      {
        id: "p1",
        userId: "u2",
        status: "ACCEPTED",
        buyInAmount: 50,
        buyInStatus: "HELD",
        buyInVersion: 1,
        user: { displayName: "Bob" },
      },
    ];
    const ctx = makeDeps({
      raceOverrides: { buyInAmount: 50, potCoins: 50 },
      RaceParticipant: {
        async findChargedByRace() {
          return parts.filter((p) => p.buyInStatus === "HELD");
        },
        async countAccepted() {
          return parts.length;
        },
        async findAcceptedByRace() {
          return parts;
        },
        async update(id, fields) {
          participantUpdates.push({ id, fields });
          const p = parts.find((x) => x.id === id);
          if (p) Object.assign(p, fields);
          return p;
        },
      },
    });
    ctx.deps.User = {
      async findById(id) {
        return { id, coins: 500 };
      },
    };
    ctx.deps.awardCoins = async (payload) => {
      awards.push(payload);
      return { awarded: true, coins: 0 };
    };
    ctx.deps.appSettings = {
      async getFlag(key) {
        return key === "buyInEditEnabled" ? buyInEditEnabled : true;
      },
    };
    ctx.deps.withRaceLock = async (_raceId, cb) => cb();
    return { ctx, awards, participantUpdates };
  }

  // Default (enabled): raising 50 -> 100 is allowed and charges the +50 delta.
  const enabled = buildCtx({ buyInEditEnabled: true });
  const editRace = buildEditRace(enabled.ctx.deps);
  await editRace({
    userId: "user-1",
    raceId: "race-1",
    updates: { buyInAmount: 100, payoutPreset: "WINNER_TAKES_ALL" },
  });
  assert.equal(enabled.awards.length, 1);
  assert.equal(enabled.awards[0].amount, -50); // charged the +50 delta
  assert.equal(enabled.awards[0].reason, "race_buy_in_adjust");
  assert.equal(enabled.awards[0].refId, "race-1:u2:v2"); // versioned, not the join refId
  assert.equal(enabled.participantUpdates[0].fields.buyInAmount, 100);
  assert.equal(enabled.participantUpdates[0].fields.buyInStatus, "HELD");
  assert.equal(enabled.participantUpdates[0].fields.buyInVersion, 2);
  assert.equal(enabled.ctx.updateCall.fields.buyInAmount, 100);
  assert.equal(enabled.ctx.updateCall.fields.potCoins, 100); // 1 * 100

  // Kill switch OFF: the old hard block still rejects with IMMUTABLE_FIELD.
  const disabled = buildCtx({ buyInEditEnabled: false });
  const editRaceBlocked = buildEditRace(disabled.ctx.deps);
  await assert.rejects(
    () =>
      editRaceBlocked({
        userId: "user-1",
        raceId: "race-1",
        updates: { buyInAmount: 100, payoutPreset: "WINNER_TAKES_ALL" },
      }),
    (err) => {
      assert.ok(err instanceof RaceEditError);
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "IMMUTABLE_FIELD");
      assert.match(err.message, /buy-in/i);
      return true;
    }
  );
  assert.equal(disabled.awards.length, 0, "no coin movement when blocked");
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
    updates: { name: "New Name", maxDurationDays: 5 },
  });

  assert.equal(ctx.events.length, 1);
  assert.equal(ctx.events[0].event, "RACE_EDITED");
  assert.equal(ctx.events[0].payload.raceId, "race-1");
  assert.equal(ctx.events[0].payload.creatorUserId, "user-1");
  assert.deepEqual(
    ctx.events[0].payload.updatedFields.sort(),
    ["name", "maxDurationDays"].sort()
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
