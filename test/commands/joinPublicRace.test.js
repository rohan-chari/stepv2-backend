const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildJoinPublicRace,
  RaceJoinError,
} = require("../../src/commands/joinPublicRace");

function makeRace(overrides = {}) {
  return {
    id: "race-1",
    creatorId: "creator-1",
    name: "Open",
    status: "PENDING",
    isPublic: true,
    maxParticipants: 10,
    buyInAmount: 0,
    payoutPreset: "WINNER_TAKES_ALL",
    participants: [{ userId: "creator-1", status: "ACCEPTED" }],
    ...overrides,
  };
}

function makeDeps({
  race,
  userCoins = 5000,
  raceUpdate,
  acceptedCount,
  awardCoins,
} = {}) {
  const events = [];
  const awards = [];
  const participants = [];
  const locks = [];
  let raceState = race;

  return {
    events,
    awards,
    participants,
    get raceState() { return raceState; },
    deps: {
      Race: {
        async findById() { return raceState; },
        async update(_id, fields) {
          raceState = { ...raceState, ...fields };
          if (raceUpdate) raceUpdate(fields);
          return raceState;
        },
      },
      RaceParticipant: {
        async findByRaceAndUser(_raceId, userId) {
          return raceState.participants.find((p) => p.userId === userId) || null;
        },
        async countAccepted() {
          return acceptedCount ?? raceState.participants.filter((p) => p.status === "ACCEPTED").length;
        },
        async create(payload) {
          const p = { id: `rp-${participants.length + 1}`, ...payload };
          participants.push(p);
          raceState.participants.push({ ...payload });
          return p;
        },
      },
      User: {
        async findById(id) { return { id, coins: userCoins }; },
      },
      awardCoins: async (payload) => {
        if (awardCoins) return awardCoins(payload);
        awards.push(payload);
        return { awarded: true };
      },
      eventBus: { emit(e, p) { events.push({ event: e, payload: p }); } },
      withRaceJoinLock: async (lockedRaceId, callback) => {
        locks.push(lockedRaceId);
        return callback();
      },
    },
    locks,
  };
}

test("joinPublicRace adds user as ACCEPTED participant", async () => {
  const ctx = makeDeps({ race: makeRace() });
  const join = buildJoinPublicRace(ctx.deps);

  await join({ userId: "user-2", raceId: "race-1" });

  assert.deepEqual(ctx.locks, ["race-1"]);
  assert.equal(ctx.participants.length, 1);
  assert.equal(ctx.participants[0].userId, "user-2");
  assert.equal(ctx.participants[0].status, "ACCEPTED");
});

test("joinPublicRace rejects non-public races", async () => {
  const ctx = makeDeps({ race: makeRace({ isPublic: false }) });
  const join = buildJoinPublicRace(ctx.deps);

  await assert.rejects(
    () => join({ userId: "user-2", raceId: "race-1" }),
    (err) => {
      assert.ok(err instanceof RaceJoinError);
      assert.equal(err.statusCode, 403);
      return true;
    }
  );
});

test("joinPublicRace allows joining an ACTIVE race (time-based, join anytime)", async () => {
  const ctx = makeDeps({ race: makeRace({ status: "ACTIVE" }) });
  const join = buildJoinPublicRace(ctx.deps);

  const participant = await join({ userId: "user-2", raceId: "race-1" });
  assert.equal(participant.status, "ACCEPTED");
  assert.equal(ctx.participants.length, 1);
});

test("joinPublicRace rejects a COMPLETED race", async () => {
  const ctx = makeDeps({ race: makeRace({ status: "COMPLETED" }) });
  const join = buildJoinPublicRace(ctx.deps);

  await assert.rejects(
    () => join({ userId: "user-2", raceId: "race-1" }),
    (err) => {
      assert.ok(err instanceof RaceJoinError);
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
});

test("joinPublicRace rejects when full", async () => {
  const race = makeRace({
    maxParticipants: 2,
    participants: [
      { userId: "a", status: "ACCEPTED" },
      { userId: "b", status: "ACCEPTED" },
    ],
  });
  const ctx = makeDeps({ race });
  const join = buildJoinPublicRace(ctx.deps);

  await assert.rejects(
    () => join({ userId: "user-2", raceId: "race-1" }),
    (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
});

test("joinPublicRace re-checks accepted count before creating participant", async () => {
  const race = makeRace({
    maxParticipants: 2,
    participants: [{ userId: "creator-1", status: "ACCEPTED" }],
  });
  const ctx = makeDeps({ race, acceptedCount: 2 });
  const join = buildJoinPublicRace(ctx.deps);

  await assert.rejects(
    () => join({ userId: "user-2", raceId: "race-1" }),
    (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    }
  );

  assert.equal(ctx.participants.length, 0);
});

test("joinPublicRace rejects when already a participant", async () => {
  const race = makeRace({
    participants: [
      { userId: "creator-1", status: "ACCEPTED" },
      { userId: "user-2", status: "ACCEPTED" },
    ],
  });
  const ctx = makeDeps({ race });
  const join = buildJoinPublicRace(ctx.deps);

  await assert.rejects(
    () => join({ userId: "user-2", raceId: "race-1" }),
    (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
});

test("joinPublicRace reserves buy-in when race has one", async () => {
  const ctx = makeDeps({
    race: makeRace({ buyInAmount: 100 }),
  });
  const join = buildJoinPublicRace(ctx.deps);

  await join({ userId: "user-2", raceId: "race-1" });

  assert.equal(ctx.participants[0].buyInAmount, 100);
  assert.equal(ctx.participants[0].buyInStatus, "HELD");
  assert.deepEqual(ctx.awards[0], {
    userId: "user-2",
    amount: -100,
    reason: "race_buy_in_hold",
    refId: "race-1:user-2",
  });
});

test("joinPublicRace does not create participant when buy-in reservation fails", async () => {
  const ctx = makeDeps({
    race: makeRace({ buyInAmount: 100 }),
    awardCoins: async () => {
      throw new Error("wallet unavailable");
    },
  });
  const join = buildJoinPublicRace(ctx.deps);

  await assert.rejects(
    () => join({ userId: "user-2", raceId: "race-1" }),
    /wallet unavailable/
  );

  assert.equal(ctx.participants.length, 0);
  assert.equal(ctx.events.length, 0);
});

test("joinPublicRace rejects when user cannot afford buy-in", async () => {
  const ctx = makeDeps({
    race: makeRace({ buyInAmount: 100 }),
    userCoins: 25,
  });
  const join = buildJoinPublicRace(ctx.deps);

  await assert.rejects(
    () => join({ userId: "user-2", raceId: "race-1" }),
    (err) => {
      assert.ok(err instanceof RaceJoinError);
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
});

test("joinPublicRace 404s when race not found", async () => {
  const ctx = makeDeps({ race: null });
  const join = buildJoinPublicRace(ctx.deps);

  await assert.rejects(
    () => join({ userId: "user-2", raceId: "missing" }),
    (err) => {
      assert.equal(err.statusCode, 404);
      return true;
    }
  );
});
