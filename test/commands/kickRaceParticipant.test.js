const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildKickRaceParticipant,
  RaceKickError,
} = require("../../src/modules/races/commands/kickRaceParticipant");

function makeRace(overrides = {}) {
  return {
    id: "race-1",
    creatorId: "creator-1",
    name: "Open",
    status: "PENDING",
    isPublic: true,
    buyInAmount: 0,
    participants: [
      { id: "rp-c", userId: "creator-1", status: "ACCEPTED" },
      { id: "rp-2", userId: "user-2", status: "ACCEPTED", buyInAmount: 0, buyInStatus: "NONE" },
    ],
    ...overrides,
  };
}

function makeDeps({ race } = {}) {
  const awards = [];
  const events = [];
  let deletedId = null;

  return {
    awards,
    events,
    get deletedId() { return deletedId; },
    deps: {
      Race: {
        async findById() { return race; },
      },
      RaceParticipant: {
        async findByRaceAndUser(_raceId, userId) {
          return race?.participants.find((p) => p.userId === userId) || null;
        },
        async delete(id) {
          deletedId = id;
          return { id };
        },
      },
      awardCoins: async (payload) => {
        awards.push(payload);
        return { awarded: true };
      },
      eventBus: { emit(e, p) { events.push({ event: e, payload: p }); } },
    },
  };
}

test("kickRaceParticipant removes target participant", async () => {
  const ctx = makeDeps({ race: makeRace() });
  const kick = buildKickRaceParticipant(ctx.deps);

  await kick({ userId: "creator-1", raceId: "race-1", targetUserId: "user-2" });

  assert.equal(ctx.deletedId, "rp-2");
});

test("kickRaceParticipant rejects non-creator", async () => {
  const ctx = makeDeps({ race: makeRace() });
  const kick = buildKickRaceParticipant(ctx.deps);

  await assert.rejects(
    () => kick({ userId: "user-2", raceId: "race-1", targetUserId: "creator-1" }),
    (err) => {
      assert.ok(err instanceof RaceKickError);
      assert.equal(err.statusCode, 403);
      return true;
    }
  );
});

test("kickRaceParticipant rejects creator kicking self", async () => {
  const ctx = makeDeps({ race: makeRace() });
  const kick = buildKickRaceParticipant(ctx.deps);

  await assert.rejects(
    () => kick({ userId: "creator-1", raceId: "race-1", targetUserId: "creator-1" }),
    (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
});

test("kickRaceParticipant refunds HELD buy-in", async () => {
  const race = makeRace({
    buyInAmount: 100,
    participants: [
      { id: "rp-c", userId: "creator-1", status: "ACCEPTED" },
      { id: "rp-2", userId: "user-2", status: "ACCEPTED", buyInAmount: 100, buyInStatus: "HELD" },
    ],
  });
  const ctx = makeDeps({ race });
  const kick = buildKickRaceParticipant(ctx.deps);

  await kick({ userId: "creator-1", raceId: "race-1", targetUserId: "user-2" });

  assert.equal(ctx.awards.length, 1);
  assert.equal(ctx.awards[0].userId, "user-2");
  assert.equal(ctx.awards[0].amount, 100);
  assert.equal(ctx.awards[0].reason, "race_buy_in_refund");
});

test("kickRaceParticipant 404s when target is not a participant", async () => {
  const ctx = makeDeps({ race: makeRace() });
  const kick = buildKickRaceParticipant(ctx.deps);

  await assert.rejects(
    () => kick({ userId: "creator-1", raceId: "race-1", targetUserId: "ghost" }),
    (err) => {
      assert.equal(err.statusCode, 404);
      return true;
    }
  );
});

test("kickRaceParticipant rejects when race is completed", async () => {
  const ctx = makeDeps({ race: makeRace({ status: "COMPLETED" }) });
  const kick = buildKickRaceParticipant(ctx.deps);

  await assert.rejects(
    () => kick({ userId: "creator-1", raceId: "race-1", targetUserId: "user-2" }),
    (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
});

test("production kick deletes through the same C0 transaction", async () => {
  const race = makeRace();
  const calls = [];
  const target = race.participants[1];
  const tx = {
    async $queryRaw() { calls.push("competition"); return [{ id: race.id }]; },
    race: { async findUnique() { return race; } },
    raceParticipant: {
      async findUnique() { return target; },
      async delete() { calls.push("delete"); },
    },
  };
  const kick = buildKickRaceParticipant({
    Race: { async findById() { return race; } },
    RaceParticipant: { async findByRaceAndUser() { return target; } },
    awardCoins: async () => null,
    eventBus: { emit() {} },
    prisma: { async $transaction(callback) { calls.push("tx"); return callback(tx); } },
    async acquireRaceWriteFence() { calls.push("c0"); },
  });

  await kick({ userId: race.creatorId, raceId: race.id, targetUserId: target.userId });
  assert.deepEqual(calls.slice(0, 4), ["tx", "c0", "competition", "delete"]);
});
