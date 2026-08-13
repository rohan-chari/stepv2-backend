const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const { createApp } = require("../../src/app");

// Mirrors the dependency-injection / stubbed-auth pattern used by the other
// HTTP route tests (see test/http/onboarding-first-race-seen.test.js). We mock
// the Race / RacePowerup / RaceActiveEffect models so no DB is needed.

async function startServer(dependencies = {}) {
  const app = createApp(dependencies);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    },
  };
}

const ME = "user-me";

function depsWithStubAuth(overrides = {}) {
  return {
    requireAuth(req, _res, next) {
      req.user = { id: ME, appleId: "apple-sub-me" };
      next();
    },
    ...overrides,
  };
}

// Build a race with participants. Each spec: { userId, displayName, status,
// finishedAt }. We always include "me" as an ACCEPTED participant.
function buildRace(participantSpecs) {
  const participants = [
    {
      id: "p-me",
      userId: ME,
      status: "ACCEPTED",
      finishedAt: null,
      user: { id: ME, displayName: "Me" },
    },
    ...participantSpecs.map((s) => ({
      id: s.id,
      userId: s.userId,
      status: s.status || "ACCEPTED",
      finishedAt: s.finishedAt || null,
      user: { id: s.userId, displayName: s.displayName },
    })),
  ];
  return {
    id: "race-1",
    status: "ACTIVE",
    participants,
  };
}

// powerupsByParticipant: { [participantId]: [{ type, status }] }
// stealthedParticipantIds: Set of participant ids that have an active STEALTH_MODE
function makeDeps({ race, powerupsByParticipant, stealthedParticipantIds = new Set() }) {
  return depsWithStubAuth({
    Race: {
      async findById(id) {
        return id === race.id ? race : null;
      },
    },
    RacePowerup: {
      async findHeldByParticipant(participantId) {
        const held = powerupsByParticipant[participantId] || [];
        // model returns only HELD rows; mimic that contract
        return held
          .filter((p) => p.status === "HELD")
          .map((p, i) => ({
            id: `${participantId}-pw-${i}`,
            type: p.type,
            status: "HELD",
          }));
      },
    },
    RaceActiveEffect: {
      async findActiveByTypeForParticipant(participantId, type) {
        if (type === "STEALTH_MODE" && stealthedParticipantIds.has(participantId)) {
          return { id: `${participantId}-stealth`, type: "STEALTH_MODE", status: "ACTIVE" };
        }
        return null;
      },
    },
  });
}

async function getTargets(baseUrl, raceId) {
  const res = await fetch(
    `${baseUrl}/races/${raceId}/powerups/sneaky-swap-targets`,
    {
      method: "GET",
      headers: { authorization: "Bearer x" },
    }
  );
  const body = await res.json();
  return { status: res.status, body };
}

test("targets EXCLUDES a participant who holds only a SNEAKY_SWAP and/or MYSTERY_BOX", async () => {
  const race = buildRace([
    { id: "p-bob", userId: "user-bob", displayName: "Bob" },
  ]);
  const deps = makeDeps({
    race,
    powerupsByParticipant: {
      "p-bob": [
        { type: "SNEAKY_SWAP", status: "HELD" },
        { type: "MYSTERY_BOX", status: "HELD" },
      ],
    },
  });
  const server = await startServer(deps);
  try {
    const { status, body } = await getTargets(server.baseUrl, race.id);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.targets));
    const ids = body.targets.map((t) => t.userId);
    assert.ok(!ids.includes("user-bob"), "Bob (only sneaky/box) must be excluded");
    assert.equal(body.targets.length, 0);
  } finally {
    await server.close();
  }
});

test("targets is member-only and rejects a retained non-accepted participant", async () => {
  const race = buildRace([{ id: "p-bob", userId: "user-bob", displayName: "Bob" }]);
  race.participants[0].status = "DECLINED";
  const server = await startServer(makeDeps({
    race,
    powerupsByParticipant: { "p-bob": [{ type: "LEG_CRAMP", status: "HELD" }] },
  }));
  try {
    const { status } = await getTargets(server.baseUrl, race.id);
    assert.equal(status, 403);
  } finally {
    await server.close();
  }
});

test("targets INCLUDES a participant who holds a stealable powerup alongside a sneaky swap", async () => {
  const race = buildRace([
    { id: "p-bob", userId: "user-bob", displayName: "Bob" },
    { id: "p-cara", userId: "user-cara", displayName: "Cara" },
  ]);
  const deps = makeDeps({
    race,
    powerupsByParticipant: {
      // Bob holds a stealable LEG_CRAMP next to a sneaky swap -> included
      "p-bob": [
        { type: "SNEAKY_SWAP", status: "HELD" },
        { type: "LEG_CRAMP", status: "HELD" },
      ],
      // Cara holds a stealable PROTEIN_SHAKE -> included
      "p-cara": [{ type: "PROTEIN_SHAKE", status: "HELD" }],
    },
  });
  const server = await startServer(deps);
  try {
    const { status, body } = await getTargets(server.baseUrl, race.id);
    assert.equal(status, 200);
    const ids = body.targets.map((t) => t.userId).sort();
    assert.deepEqual(ids, ["user-bob", "user-cara"]);
    const bob = body.targets.find((t) => t.userId === "user-bob");
    assert.equal(bob.displayName, "Bob");
  } finally {
    await server.close();
  }
});

test("targets EXCLUDES the requesting user, stealthed participants, and finished participants", async () => {
  const race = buildRace([
    // Stealthed Bob holds a stealable powerup but is stealthed -> excluded
    { id: "p-bob", userId: "user-bob", displayName: "Bob" },
    // Finished Cara holds a stealable powerup but is finished -> excluded
    { id: "p-cara", userId: "user-cara", displayName: "Cara", finishedAt: new Date().toISOString() },
    // Dan qualifies -> included
    { id: "p-dan", userId: "user-dan", displayName: "Dan" },
  ]);
  const deps = makeDeps({
    race,
    powerupsByParticipant: {
      "p-me": [{ type: "LEG_CRAMP", status: "HELD" }], // requester holds stealable but is self
      "p-bob": [{ type: "PROTEIN_SHAKE", status: "HELD" }],
      "p-cara": [{ type: "LEG_CRAMP", status: "HELD" }],
      "p-dan": [{ type: "RUNNERS_HIGH", status: "HELD" }],
    },
    stealthedParticipantIds: new Set(["p-bob"]),
  });
  const server = await startServer(deps);
  try {
    const { status, body } = await getTargets(server.baseUrl, race.id);
    assert.equal(status, 200);
    const ids = body.targets.map((t) => t.userId);
    assert.ok(!ids.includes(ME), "requester excluded");
    assert.ok(!ids.includes("user-bob"), "stealthed excluded");
    assert.ok(!ids.includes("user-cara"), "finished excluded");
    assert.deepEqual(ids, ["user-dan"]);
  } finally {
    await server.close();
  }
});

test("options endpoint: targetPowerups no longer includes SNEAKY_SWAP / MYSTERY_BOX", async () => {
  const race = buildRace([
    { id: "p-bob", userId: "user-bob", displayName: "Bob" },
  ]);
  const deps = depsWithStubAuth({
    Race: {
      async findById(id) {
        return id === race.id ? race : null;
      },
    },
    RaceActiveEffect: {
      async findActiveByTypeForParticipant() {
        return null; // not stealthed
      },
    },
    RacePowerup: {
      async findHeldByParticipant(participantId) {
        if (participantId === "p-me") {
          // requester must hold a SNEAKY_SWAP to pass the gate
          return [
            { id: "me-1", type: "SNEAKY_SWAP", status: "HELD" },
            { id: "me-2", type: "TRAIL_MAGNET", status: "HELD" },
          ];
        }
        // target Bob holds a stealable + a sneaky swap + a mystery box
        return [
          { id: "bob-1", type: "LEG_CRAMP", status: "HELD" },
          { id: "bob-2", type: "SNEAKY_SWAP", status: "HELD" },
          { id: "bob-3", type: "MYSTERY_BOX", status: "HELD" },
        ];
      },
    },
  });
  const server = await startServer(deps);
  try {
    const res = await fetch(
      `${server.baseUrl}/races/${race.id}/powerups/sneaky-swap-options/user-bob`,
      { method: "GET", headers: { authorization: "Bearer x" } }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    // shape preserved
    assert.ok(Array.isArray(body.ownPowerups));
    assert.ok(Array.isArray(body.targetPowerups));
    const targetTypes = body.targetPowerups.map((p) => p.type);
    assert.ok(targetTypes.includes("LEG_CRAMP"), "stealable kept");
    assert.ok(!targetTypes.includes("SNEAKY_SWAP"), "sneaky swap filtered out of targetPowerups");
    assert.ok(!targetTypes.includes("MYSTERY_BOX"), "mystery box filtered out of targetPowerups");
  } finally {
    await server.close();
  }
});
