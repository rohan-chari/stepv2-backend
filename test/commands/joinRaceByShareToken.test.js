const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildJoinRaceByShareToken,
  RaceShareJoinError,
} = require("../../src/modules/races/commands/joinRaceByShareToken");
const { RaceJoinError } = require("../../src/modules/races/commands/joinRaceCore");

function makeRace(overrides = {}) {
  return {
    id: "race-1",
    creatorId: "creator-1",
    name: "Private Crew Race",
    status: "PENDING",
    // Deliberately NOT public: share-token join must work for private races.
    isPublic: false,
    maxParticipants: 10,
    buyInAmount: 0,
    payoutPreset: "WINNER_TAKES_ALL",
    shareToken: "tok-abc",
    participants: [{ userId: "creator-1", status: "ACCEPTED" }],
    ...overrides,
  };
}

function makeDeps({ race, raceByToken } = {}) {
  const events = [];
  const participants = [];
  const locks = [];
  let raceState = race;

  return {
    events,
    participants,
    locks,
    deps: {
      Race: {
        async findByShareToken(token) {
          if (raceByToken !== undefined) return raceByToken;
          return raceState && raceState.shareToken === token ? raceState : null;
        },
        async findById() {
          return raceState;
        },
      },
      RaceParticipant: {
        async findByRaceAndUser(_raceId, userId) {
          return raceState.participants.find((p) => p.userId === userId) || null;
        },
        async countAccepted() {
          return raceState.participants.filter((p) => p.status === "ACCEPTED")
            .length;
        },
        async create(payload) {
          const p = { id: `rp-${participants.length + 1}`, ...payload };
          participants.push(p);
          raceState.participants.push({ ...payload });
          return p;
        },
      },
      User: {
        async findById(id) {
          return { id, coins: 5000 };
        },
      },
      awardCoins: async () => ({ awarded: true }),
      eventBus: {
        emit(e, p) {
          events.push({ event: e, payload: p });
        },
      },
      withRaceJoinLock: async (lockedRaceId, callback) => {
        locks.push(lockedRaceId);
        return callback();
      },
    },
  };
}

test("joinRaceByShareToken joins a PRIVATE race (bypasses the isPublic gate)", async () => {
  const ctx = makeDeps({ race: makeRace({ isPublic: false }) });
  const join = buildJoinRaceByShareToken(ctx.deps);

  const participant = await join({ userId: "user-2", token: "tok-abc" });

  assert.equal(participant.userId, "user-2");
  assert.equal(participant.status, "ACCEPTED");
  assert.deepEqual(ctx.locks, ["race-1"]);
  assert.equal(ctx.participants.length, 1);
});

test("joinRaceByShareToken 404s when the token matches no race", async () => {
  const ctx = makeDeps({ raceByToken: null });
  const join = buildJoinRaceByShareToken(ctx.deps);

  await assert.rejects(
    () => join({ userId: "user-2", token: "nope" }),
    (err) => {
      assert.ok(err instanceof RaceShareJoinError);
      assert.equal(err.statusCode, 404);
      return true;
    }
  );
});

test("joinRaceByShareToken does not acquire a lock when the token is unknown", async () => {
  const ctx = makeDeps({ raceByToken: null });
  const join = buildJoinRaceByShareToken(ctx.deps);

  await assert.rejects(() => join({ userId: "user-2", token: "nope" }));
  assert.deepEqual(ctx.locks, []);
});

test("joinRaceByShareToken rejects joining a COMPLETED race", async () => {
  const ctx = makeDeps({ race: makeRace({ status: "COMPLETED" }) });
  const join = buildJoinRaceByShareToken(ctx.deps);

  await assert.rejects(
    () => join({ userId: "user-2", token: "tok-abc" }),
    (err) => {
      // Surfaced from the shared core.
      assert.ok(err instanceof RaceJoinError);
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
});

test("joinRaceByShareToken rejects when the user is already a participant", async () => {
  const ctx = makeDeps({
    race: makeRace({
      participants: [
        { userId: "creator-1", status: "ACCEPTED" },
        { userId: "user-2", status: "ACCEPTED" },
      ],
    }),
  });
  const join = buildJoinRaceByShareToken(ctx.deps);

  await assert.rejects(
    () => join({ userId: "user-2", token: "tok-abc" }),
    (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
});

test("joinRaceByShareToken emits the join event", async () => {
  const ctx = makeDeps({ race: makeRace() });
  const join = buildJoinRaceByShareToken(ctx.deps);

  await join({ userId: "user-2", token: "tok-abc" });

  assert.equal(ctx.events.length, 1);
  assert.equal(ctx.events[0].event, "RACE_PUBLIC_JOINED");
  assert.equal(ctx.events[0].payload.raceId, "race-1");
});
