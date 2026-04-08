const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildRespondToRaceInvite,
  RaceInviteResponseError,
} = require("../../src/commands/respondToRaceInvite");

function makeDeps(overrides = {}) {
  const updates = [];
  const events = [];
  const awards = [];
  const raceUpdates = [];

  return {
    updates,
    events,
    awards,
    raceUpdates,
    deps: {
      Race: {
        async findById(id) {
          return {
            id,
            creatorId: "creator-1",
            status: "PENDING",
            name: "Test Race",
            buyInAmount: 0,
            payoutPreset: "WINNER_TAKES_ALL",
            participants: [],
          };
        },
        async update(id, fields) {
          raceUpdates.push({ id, fields });
          return { id, ...fields };
        },
        ...overrides.Race,
      },
      RaceParticipant: {
        async findByRaceAndUser() {
          return { id: "rp-1", userId: "friend-1", status: "INVITED" };
        },
        async update(id, fields) {
          updates.push({ id, fields });
          return { id, ...fields };
        },
        ...overrides.RaceParticipant,
      },
      User: {
        async findById(id) {
          return { id, coins: 500 };
        },
        ...overrides.User,
      },
      awardCoins: async (payload) => {
        awards.push(payload);
        return { awarded: true, coins: 0 };
      },
      Steps: {
        async findByUserIdAndDate() {
          return { steps: 4200 };
        },
        ...overrides.Steps,
      },
      eventBus: {
        emit(event, payload) {
          events.push({ event, payload });
        },
      },
    },
  };
}

test("accepting a PENDING race does not set baseline steps", async () => {
  const { deps, updates } = makeDeps();
  const respond = buildRespondToRaceInvite(deps);

  await respond({ userId: "friend-1", raceId: "race-1", accept: true });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].fields.status, "ACCEPTED");
  assert.equal(updates[0].fields.baselineSteps, undefined);
});

test("accepting an ACTIVE race sets baseline steps to current steps today", async () => {
  const { deps, updates } = makeDeps({
    Race: {
      async findById(id) {
        return { id, creatorId: "creator-1", status: "ACTIVE", name: "Test Race" };
      },
    },
  });
  const respond = buildRespondToRaceInvite(deps);

  await respond({ userId: "friend-1", raceId: "race-1", accept: true });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].fields.status, "ACCEPTED");
  assert.equal(updates[0].fields.baselineSteps, 4200);
  assert.ok(updates[0].fields.joinedAt instanceof Date);
});

test("accepting an ACTIVE race with no steps today sets baseline to 0", async () => {
  const { deps, updates } = makeDeps({
    Race: {
      async findById(id) {
        return { id, creatorId: "creator-1", status: "ACTIVE", name: "Test Race" };
      },
    },
    Steps: {
      async findByUserIdAndDate() {
        return null;
      },
    },
  });
  const respond = buildRespondToRaceInvite(deps);

  await respond({ userId: "friend-1", raceId: "race-1", accept: true });

  assert.equal(updates[0].fields.baselineSteps, 0);
});

test("declining does not set baseline steps regardless of race status", async () => {
  const { deps, updates } = makeDeps({
    Race: {
      async findById(id) {
        return { id, creatorId: "creator-1", status: "ACTIVE", name: "Test Race" };
      },
    },
  });
  const respond = buildRespondToRaceInvite(deps);

  await respond({ userId: "friend-1", raceId: "race-1", accept: false });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].fields.status, "DECLINED");
  assert.equal(updates[0].fields.baselineSteps, undefined);
});

test("accepting a paid PENDING race reserves the buy-in as held coins", async () => {
  const { deps, updates, awards } = makeDeps({
    Race: {
      async findById(id) {
        return {
          id,
          creatorId: "creator-1",
          status: "PENDING",
          name: "Paid Race",
          buyInAmount: 100,
          payoutPreset: "WINNER_TAKES_ALL",
          participants: [],
        };
      },
    },
  });
  const respond = buildRespondToRaceInvite(deps);

  await respond({ userId: "friend-1", raceId: "race-1", accept: true });

  assert.equal(updates[0].fields.buyInAmount, 100);
  assert.equal(updates[0].fields.buyInStatus, "HELD");
  assert.deepEqual(awards[0], {
    userId: "friend-1",
    amount: -100,
    reason: "race_buy_in_hold",
    refId: "race-1:friend-1",
  });
});

test("accepting a paid race rejects users who cannot afford the buy-in", async () => {
  const { deps } = makeDeps({
    Race: {
      async findById(id) {
        return {
          id,
          creatorId: "creator-1",
          status: "PENDING",
          name: "Paid Race",
          buyInAmount: 100,
          payoutPreset: "WINNER_TAKES_ALL",
          participants: [],
        };
      },
    },
    User: {
      async findById(id) {
        return { id, coins: 40 };
      },
    },
  });
  const respond = buildRespondToRaceInvite(deps);

  await assert.rejects(
    () => respond({ userId: "friend-1", raceId: "race-1", accept: true }),
    (err) => {
      assert.ok(err instanceof RaceInviteResponseError);
      assert.equal(err.statusCode, 400);
      assert.equal(err.message, "You do not have enough coins for this buy-in");
      return true;
    }
  );
});

test("late join to a paid active race is rejected after someone has finished", async () => {
  const { deps } = makeDeps({
    Race: {
      async findById(id) {
        return {
          id,
          creatorId: "creator-1",
          status: "ACTIVE",
          name: "Paid Race",
          buyInAmount: 100,
          payoutPreset: "WINNER_TAKES_ALL",
          participants: [{ userId: "creator-1", finishedAt: new Date("2026-04-07T10:00:00.000Z") }],
        };
      },
    },
  });
  const respond = buildRespondToRaceInvite(deps);

  await assert.rejects(
    () => respond({ userId: "friend-1", raceId: "race-1", accept: true }),
    (err) => {
      assert.ok(err instanceof RaceInviteResponseError);
      assert.equal(err.statusCode, 400);
      assert.equal(err.message, "You cannot join a paid race after someone has finished");
      return true;
    }
  );
});

test("emits RACE_INVITE_ACCEPTED on accept", async () => {
  const { deps, events } = makeDeps();
  const respond = buildRespondToRaceInvite(deps);

  await respond({ userId: "friend-1", raceId: "race-1", accept: true });

  assert.equal(events.length, 1);
  assert.equal(events[0].event, "RACE_INVITE_ACCEPTED");
  assert.equal(events[0].payload.userId, "friend-1");
});

test("emits RACE_INVITE_DECLINED on decline", async () => {
  const { deps, events } = makeDeps();
  const respond = buildRespondToRaceInvite(deps);

  await respond({ userId: "friend-1", raceId: "race-1", accept: false });

  assert.equal(events.length, 1);
  assert.equal(events[0].event, "RACE_INVITE_DECLINED");
});

test("rejects when race is COMPLETED", async () => {
  const { deps } = makeDeps({
    Race: {
      async findById(id) {
        return { id, creatorId: "creator-1", status: "COMPLETED", name: "Test Race" };
      },
    },
  });
  const respond = buildRespondToRaceInvite(deps);

  await assert.rejects(
    () => respond({ userId: "friend-1", raceId: "race-1", accept: true }),
    (err) => {
      assert.ok(err instanceof RaceInviteResponseError);
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
});

test("rejects when participant already responded", async () => {
  const { deps } = makeDeps({
    RaceParticipant: {
      async findByRaceAndUser() {
        return { id: "rp-1", userId: "friend-1", status: "ACCEPTED" };
      },
      async update() {},
    },
  });
  const respond = buildRespondToRaceInvite(deps);

  await assert.rejects(
    () => respond({ userId: "friend-1", raceId: "race-1", accept: true }),
    (err) => {
      assert.ok(err instanceof RaceInviteResponseError);
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
});

test("rejects when user is not invited", async () => {
  const { deps } = makeDeps({
    RaceParticipant: {
      async findByRaceAndUser() {
        return null;
      },
      async update() {},
    },
  });
  const respond = buildRespondToRaceInvite(deps);

  await assert.rejects(
    () => respond({ userId: "stranger", raceId: "race-1", accept: true }),
    (err) => {
      assert.ok(err instanceof RaceInviteResponseError);
      assert.equal(err.statusCode, 403);
      return true;
    }
  );
});
