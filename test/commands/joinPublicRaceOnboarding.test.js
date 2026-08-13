const assert = require("node:assert/strict");
const test = require("node:test");

const { buildJoinPublicRace } = require("../../src/modules/races/commands/joinPublicRace");

// ---------------------------------------------------------------------------
// Lightweight in-memory mock of the slice of Prisma the onboarding grant uses:
// $transaction, onboardingBoxGrant.create (PK = appleSubHash, enforces a
// P2002-style unique violation on dupes), racePowerup.create, racePowerupEvent
// .create, and user.update. Mirrors the structure exercised by joinPublicRace's
// maybeGrantOnboardingBoxes helper. Optionally shares the grant ledger across
// instances so we can simulate delete-account + recreate (same Apple sub).
// ---------------------------------------------------------------------------
function makePrismaMock({ ledger = new Map() } = {}) {
  const racePowerups = [];
  const powerupEvents = [];
  const userUpdates = [];

  const tx = {
    onboardingBoxGrant: {
      async create({ data }) {
        if (ledger.has(data.appleSubHash)) {
          const err = new Error("Unique constraint failed");
          err.code = "P2002";
          throw err;
        }
        ledger.set(data.appleSubHash, { ...data, grantedAt: new Date() });
        return ledger.get(data.appleSubHash);
      },
    },
    racePowerup: {
      async create({ data }) {
        const row = { id: `pwr-${racePowerups.length + 1}`, ...data };
        racePowerups.push(row);
        return row;
      },
    },
    racePowerupEvent: {
      async create({ data }) {
        const row = { id: `evt-${powerupEvents.length + 1}`, ...data };
        powerupEvents.push(row);
        return row;
      },
    },
    user: {
      async update({ where, data }) {
        userUpdates.push({ where, data });
        return { id: where.id, ...data };
      },
    },
  };

  return {
    ledger,
    racePowerups,
    powerupEvents,
    userUpdates,
    db: {
      async $transaction(fn) {
        // No real atomicity in the mock, but the ledger.create throws on dupe
        // BEFORE any boxes are created, so a rejected tx leaves nothing behind.
        return fn(tx);
      },
    },
  };
}

function makeRace(overrides = {}) {
  return {
    id: "race-1",
    creatorId: "creator-1",
    name: "Open",
    status: "ACTIVE",
    isPublic: true,
    maxParticipants: 10,
    buyInAmount: 0,
    powerupsEnabled: true,
    participants: [{ userId: "creator-1", status: "ACCEPTED" }],
    ...overrides,
  };
}

function makeDeps({ race, prismaMock, appleId = "000731.apple.sub", powerupSlots } = {}) {
  const events = [];
  const participants = [];
  let raceState = race;

  return {
    events,
    participants,
    deps: {
      Race: {
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
          const p = {
            id: `rp-${participants.length + 1}`,
            powerupSlots: powerupSlots ?? 3,
            ...payload,
          };
          participants.push(p);
          raceState.participants.push({ ...payload });
          return p;
        },
      },
      User: {
        async findById(id) {
          return { id, coins: 5000, appleId };
        },
      },
      awardCoins: async () => ({ awarded: true }),
      eventBus: {
        emit(e, p) {
          events.push({ event: e, payload: p });
        },
      },
      withRaceJoinLock: async (_id, cb) => cb(),
      prisma: prismaMock.db,
    },
  };
}

test("eligible onboarding join grants 3 mystery boxes + ledger row + flag", async () => {
  const prismaMock = makePrismaMock();
  const ctx = makeDeps({ race: makeRace(), prismaMock });
  const join = buildJoinPublicRace(ctx.deps);

  await join({ userId: "user-2", raceId: "race-1", onboarding: true });

  // 3 MYSTERY_BOX powerups for the new participant.
  assert.equal(prismaMock.racePowerups.length, 3);
  for (const pwr of prismaMock.racePowerups) {
    assert.equal(pwr.status, "MYSTERY_BOX");
    assert.equal(pwr.type, null);
    assert.equal(pwr.rarity, null);
    assert.equal(pwr.userId, "user-2");
  }
  // Distinct earnedAtSteps to satisfy the unique constraint.
  const steps = prismaMock.racePowerups.map((p) => p.earnedAtSteps);
  assert.equal(new Set(steps).size, 3);

  // Welcome gifts are not race-feed activity.
  assert.equal(prismaMock.powerupEvents.length, 0);

  // Ledger row inserted, keyed on the hash of the Apple sub.
  assert.equal(prismaMock.ledger.size, 1);

  // User flagged as having seen the onboarding step.
  assert.equal(prismaMock.userUpdates.length, 1);
  assert.equal(prismaMock.userUpdates[0].data.firstRaceOnboardingSeen, true);

  // Deferred POWERUP_EARNED bus events emitted after the grant.
  const emitted = ctx.events.filter((e) => e.event === "POWERUP_EARNED");
  assert.equal(emitted.length, 3);
});

test("second join with the SAME appleSubHash (recreated account) grants no boxes", async () => {
  const sharedLedger = new Map();
  const appleId = "000731.same.sub";

  // First grant for original user.
  const prismaA = makePrismaMock({ ledger: sharedLedger });
  const ctxA = makeDeps({ race: makeRace(), prismaMock: prismaA, appleId });
  await buildJoinPublicRace(ctxA.deps)({
    userId: "user-original",
    raceId: "race-1",
    onboarding: true,
  });
  assert.equal(prismaA.racePowerups.length, 3);

  // Delete + recreate => brand-new userId, SAME Apple sub => SAME hash.
  const prismaB = makePrismaMock({ ledger: sharedLedger });
  const ctxB = makeDeps({ race: makeRace(), prismaMock: prismaB, appleId });
  const participant = await buildJoinPublicRace(ctxB.deps)({
    userId: "user-recreated",
    raceId: "race-1",
    onboarding: true,
  });

  // Join still succeeds...
  assert.equal(participant.status, "ACCEPTED");
  // ...but NO bonus boxes, no extra ledger row, no flag set.
  assert.equal(prismaB.racePowerups.length, 0);
  assert.equal(prismaB.powerupEvents.length, 0);
  assert.equal(prismaB.userUpdates.length, 0);
  assert.equal(sharedLedger.size, 1);
  assert.equal(
    ctxB.events.filter((e) => e.event === "POWERUP_EARNED").length,
    0
  );
});

test("non-powerup race grants no onboarding boxes", async () => {
  const prismaMock = makePrismaMock();
  const ctx = makeDeps({
    race: makeRace({ powerupsEnabled: false }),
    prismaMock,
  });
  const join = buildJoinPublicRace(ctx.deps);

  await join({ userId: "user-2", raceId: "race-1", onboarding: true });

  assert.equal(prismaMock.racePowerups.length, 0);
  assert.equal(prismaMock.ledger.size, 0);
  assert.equal(prismaMock.userUpdates.length, 0);
});

test("falsy onboarding flag grants no boxes (old-client behavior preserved)", async () => {
  const prismaMock = makePrismaMock();
  const ctx = makeDeps({ race: makeRace(), prismaMock });
  const join = buildJoinPublicRace(ctx.deps);

  // Omit onboarding entirely (what an old client does).
  const participant = await join({ userId: "user-2", raceId: "race-1" });

  assert.equal(participant.status, "ACCEPTED");
  assert.equal(prismaMock.racePowerups.length, 0);
  assert.equal(prismaMock.ledger.size, 0);
  assert.equal(prismaMock.userUpdates.length, 0);
});

test("powerupSlots cap is respected (slots=2 => only 2 boxes)", async () => {
  const prismaMock = makePrismaMock();
  const ctx = makeDeps({ race: makeRace(), prismaMock, powerupSlots: 2 });
  const join = buildJoinPublicRace(ctx.deps);

  await join({ userId: "user-2", raceId: "race-1", onboarding: true });

  assert.equal(prismaMock.racePowerups.length, 2);
  assert.equal(prismaMock.powerupEvents.length, 0);
  // Grant still recorded + flag still set.
  assert.equal(prismaMock.ledger.size, 1);
  assert.equal(prismaMock.userUpdates[0].data.firstRaceOnboardingSeen, true);
});
