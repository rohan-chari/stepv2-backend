const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildCreateRaceShareLink,
  RaceShareLinkError,
} = require("../../src/commands/createRaceShareLink");

function makeRace(overrides = {}) {
  return {
    id: "race-1",
    creatorId: "creator-1",
    name: "Crew Race",
    status: "PENDING",
    shareToken: null,
    participants: [{ userId: "creator-1", status: "ACCEPTED" }],
    ...overrides,
  };
}

function makeDeps({ race, generateShareToken } = {}) {
  const updates = [];
  let raceState = race;
  let tokenSeq = 0;

  return {
    updates,
    get raceState() {
      return raceState;
    },
    deps: {
      Race: {
        async findById() {
          return raceState;
        },
        async update(_id, fields) {
          updates.push(fields);
          raceState = { ...raceState, ...fields };
          return raceState;
        },
      },
      generateShareToken:
        generateShareToken || (() => `tok-${++tokenSeq}`),
    },
  };
}

test("createRaceShareLink mints and persists a token for a member", async () => {
  const ctx = makeDeps({ race: makeRace() });
  const create = buildCreateRaceShareLink(ctx.deps);

  const result = await create({ userId: "creator-1", raceId: "race-1" });

  assert.equal(result.shareToken, "tok-1");
  assert.equal(ctx.updates.length, 1);
  assert.equal(ctx.updates[0].shareToken, "tok-1");
});

test("createRaceShareLink is idempotent — returns the existing token, no re-write", async () => {
  const ctx = makeDeps({ race: makeRace({ shareToken: "existing-tok" }) });
  const create = buildCreateRaceShareLink(ctx.deps);

  const result = await create({ userId: "creator-1", raceId: "race-1" });

  assert.equal(result.shareToken, "existing-tok");
  assert.equal(ctx.updates.length, 0);
});

test("createRaceShareLink lets any ACCEPTED participant share (not just the creator)", async () => {
  const ctx = makeDeps({
    race: makeRace({
      participants: [
        { userId: "creator-1", status: "ACCEPTED" },
        { userId: "member-2", status: "ACCEPTED" },
      ],
    }),
  });
  const create = buildCreateRaceShareLink(ctx.deps);

  const result = await create({ userId: "member-2", raceId: "race-1" });
  assert.match(result.shareToken, /^tok-/);
});

test("createRaceShareLink 403s for a non-participant", async () => {
  const ctx = makeDeps({ race: makeRace() });
  const create = buildCreateRaceShareLink(ctx.deps);

  await assert.rejects(
    () => create({ userId: "stranger", raceId: "race-1" }),
    (err) => {
      assert.ok(err instanceof RaceShareLinkError);
      assert.equal(err.statusCode, 403);
      return true;
    }
  );
});

test("createRaceShareLink 403s for an INVITED-but-not-accepted user", async () => {
  const ctx = makeDeps({
    race: makeRace({
      participants: [
        { userId: "creator-1", status: "ACCEPTED" },
        { userId: "pending-2", status: "INVITED" },
      ],
    }),
  });
  const create = buildCreateRaceShareLink(ctx.deps);

  await assert.rejects(
    () => create({ userId: "pending-2", raceId: "race-1" }),
    (err) => {
      assert.equal(err.statusCode, 403);
      return true;
    }
  );
});

test("createRaceShareLink 404s when the race does not exist", async () => {
  const ctx = makeDeps({ race: null });
  const create = buildCreateRaceShareLink(ctx.deps);

  await assert.rejects(
    () => create({ userId: "creator-1", raceId: "missing" }),
    (err) => {
      assert.equal(err.statusCode, 404);
      return true;
    }
  );
});
