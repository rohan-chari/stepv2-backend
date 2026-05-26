const assert = require("node:assert/strict");
const test = require("node:test");

const { buildGetHomeRaceCard } = require("../../src/queries/getHomeRaceCard");

const ME_ID = "user-me";
const FIXED_NOW = new Date("2026-05-21T18:00:00Z");

function user(id, name) {
  return {
    id,
    displayName: name,
    profilePhotoUrl: null,
    equippedAccessories: [],
  };
}

function makePrisma({
  invites = [],
  myActiveParticipation = null,
  friendships = [],
  friendRaceParticipations = [],
  friendFinishers = [],
  publicRaces = [],
} = {}) {
  return {
    raceParticipant: {
      async findMany({ where, include }) {
        // Invite lookup
        if (where.status === "INVITED") return invites;
        // friend racing lookup
        if (where.placement) return friendFinishers;
        if (Array.isArray(where.userId?.in)) return friendRaceParticipations;
        return [];
      },
      async findFirst({ where }) {
        if (where.userId === ME_ID && where.status === "ACCEPTED") {
          return myActiveParticipation;
        }
        return null;
      },
    },
    friendship: {
      async findMany() {
        return friendships;
      },
    },
    race: {
      async findMany() {
        return publicRaces;
      },
    },
  };
}

test("returns EMPTY when nothing matches any state", async () => {
  const prisma = makePrisma({});
  const get = buildGetHomeRaceCard({ prisma, now: () => FIXED_NOW });
  const res = await get({ userId: ME_ID });
  assert.equal(res.state, "EMPTY");
});

test("returns PENDING_INVITE when user has a pending invite", async () => {
  const expiresAt = new Date("2026-05-21T20:00:00Z");
  const prisma = makePrisma({
    invites: [
      {
        id: "rp-1",
        userId: ME_ID,
        status: "INVITED",
        joinedAt: new Date("2026-05-21T16:00:00Z"),
        inviteExpiresAt: expiresAt,
        race: {
          id: "race-pending",
          name: "Friend invite",
          status: "PENDING",
          targetSteps: 25000,
          maxDurationDays: 3,
          creator: user("u-inviter", "Rohit"),
          participants: [{ id: "rp-a", status: "INVITED" }, { id: "rp-b", status: "ACCEPTED" }],
        },
      },
    ],
  });
  const get = buildGetHomeRaceCard({ prisma, now: () => FIXED_NOW });
  const res = await get({ userId: ME_ID });
  assert.equal(res.state, "PENDING_INVITE");
  assert.equal(res.pendingInviteCount, 1);
  assert.equal(res.data.raceId, "race-pending");
  assert.equal(res.data.inviter.displayName, "Rohit");
  assert.equal(res.data.durationHours, 72);
  assert.equal(res.data.participantCount, 2);
  assert.equal(res.data.expiresAt.toISOString(), expiresAt.toISOString());
});

test("returns ACTIVE_RACE when user is in an active race", async () => {
  const me = user(ME_ID, "Sugaroro");
  const rival = user("u-2", "Maya");
  const prisma = makePrisma({
    myActiveParticipation: {
      id: "rp-mine",
      userId: ME_ID,
      status: "ACCEPTED",
      race: {
        id: "race-active",
        name: "Sprint",
        status: "ACTIVE",
        endsAt: new Date("2026-05-22T18:00:00Z"),
        participants: [
          { userId: "u-2", totalSteps: 6000, user: rival },
          { userId: ME_ID, totalSteps: 5660, user: me },
        ],
      },
    },
  });
  const get = buildGetHomeRaceCard({ prisma, now: () => FIXED_NOW });
  const res = await get({ userId: ME_ID });
  assert.equal(res.state, "ACTIVE_RACE");
  assert.equal(res.data.raceId, "race-active");
  assert.equal(res.data.leader.userId, "u-2");
  assert.equal(res.data.me.userId, ME_ID);
  assert.match(res.data.me.displayName, /Sugaroro/);
  assert.match(res.data.leader.displayName, /Maya/);
});

test("returns PUBLIC_RACE preferring DAILY_10K seed over WEEKLY_50K", async () => {
  const prisma = makePrisma({
    publicRaces: [
      {
        id: "race-weekly",
        name: "Weekly 50K Challenge",
        targetSteps: 50000,
        maxParticipants: 100,
        endsAt: new Date("2026-05-28T00:00:00Z"),
        seed: { kind: "WEEKLY_50K" },
        _count: { participants: 5 },
      },
      {
        id: "race-daily",
        name: "Daily 10K Sprint",
        targetSteps: 10000,
        maxParticipants: 100,
        endsAt: new Date("2026-05-22T00:00:00Z"),
        seed: { kind: "DAILY_10K" },
        _count: { participants: 8 },
      },
    ],
  });
  const get = buildGetHomeRaceCard({ prisma, now: () => FIXED_NOW });
  const res = await get({ userId: ME_ID });
  assert.equal(res.state, "PUBLIC_RACE");
  assert.equal(res.data.seedKind, "DAILY_10K");
  assert.equal(res.data.participantCount, 8);
});

test("returns PUBLIC_RACE skipping full races", async () => {
  const prisma = makePrisma({
    publicRaces: [
      {
        id: "race-full",
        name: "Daily 10K Sprint",
        targetSteps: 10000,
        maxParticipants: 10,
        endsAt: new Date("2026-05-22T00:00:00Z"),
        seed: { kind: "DAILY_10K" },
        _count: { participants: 10 },
      },
      {
        id: "race-ok",
        name: "Weekly 50K Challenge",
        targetSteps: 50000,
        maxParticipants: 100,
        endsAt: new Date("2026-05-28T00:00:00Z"),
        seed: { kind: "WEEKLY_50K" },
        _count: { participants: 5 },
      },
    ],
  });
  const get = buildGetHomeRaceCard({ prisma, now: () => FIXED_NOW });
  const res = await get({ userId: ME_ID });
  assert.equal(res.state, "PUBLIC_RACE");
  assert.equal(res.data.raceId, "race-ok");
});

// ---------------------------------------------------------------------------
// Opt-in ACTIVE_RACES state (new app builds only). The legacy tests above must
// keep passing untouched: they never pass homeActiveRaces, so they use the
// existing single-state path.
// ---------------------------------------------------------------------------

const STEALTH_NOW = FIXED_NOW;

// Prisma mock for the opt-in active-races path. activeParticipations is the
// list returned by raceParticipant.findMany for status ACCEPTED + ACTIVE race.
function makeActivePrisma({ activeParticipations = [], activeEffects = {} } = {}) {
  return {
    raceParticipant: {
      async findMany({ where }) {
        if (where.status === "INVITED") return [];
        if (where.placement) return [];
        if (
          where.userId === ME_ID &&
          where.status === "ACCEPTED" &&
          where.race &&
          where.race.status === "ACTIVE"
        ) {
          return activeParticipations;
        }
        if (Array.isArray(where.userId?.in)) return [];
        return [];
      },
      async findFirst() {
        return null;
      },
    },
    friendship: {
      async findMany() {
        return [];
      },
    },
    race: {
      async findMany() {
        return [];
      },
    },
    // Used indirectly via RaceActiveEffect model -> prisma.raceActiveEffect.
    raceActiveEffect: {
      async findMany({ where }) {
        return activeEffects[where.raceId] || [];
      },
    },
  };
}

// Patch the shared RaceActiveEffect model to read from our mock prisma. The
// model imports its own prisma, so we stub findActiveForRace per-test instead.
const raceActiveEffectModule = require("../../src/models/raceActiveEffect");

function withStealthedRace(raceId, stealthedUserIds) {
  const original = raceActiveEffectModule.RaceActiveEffect.findActiveForRace;
  raceActiveEffectModule.RaceActiveEffect.findActiveForRace = async (id) => {
    if (id === raceId) {
      return stealthedUserIds.map((uid) => ({
        type: "STEALTH_MODE",
        targetUserId: uid,
        status: "ACTIVE",
      }));
    }
    return [];
  };
  return () => {
    raceActiveEffectModule.RaceActiveEffect.findActiveForRace = original;
  };
}

test("opt-in: returns ACTIVE_RACES with top-3 and userPlacement", async () => {
  const me = user(ME_ID, "Sugaroro");
  const a = user("u-a", "Alice");
  const b = user("u-b", "Bob");
  const c = user("u-c", "Cara");
  const prisma = makeActivePrisma({
    activeParticipations: [
      {
        id: "rp-mine",
        userId: ME_ID,
        status: "ACCEPTED",
        race: {
          id: "race-1",
          name: "Morning Walk",
          status: "ACTIVE",
          powerupsEnabled: false,
          endsAt: new Date("2026-05-22T18:00:00Z"),
          participants: [
            { userId: "u-a", totalSteps: 12000, user: a },
            { userId: "u-b", totalSteps: 9000, user: b },
            { userId: "u-c", totalSteps: 7000, user: c },
            { userId: ME_ID, totalSteps: 5000, user: me },
          ],
        },
      },
    ],
  });
  const get = buildGetHomeRaceCard({ prisma, now: () => STEALTH_NOW });
  const res = await get({ userId: ME_ID, homeActiveRaces: true });
  assert.equal(res.state, "ACTIVE_RACES");
  assert.equal(res.data.races.length, 1);
  const race = res.data.races[0];
  assert.equal(race.raceId, "race-1");
  assert.equal(race.name, "Morning Walk");
  assert.equal(race.top3.length, 3);
  assert.deepEqual(
    race.top3.map((t) => t.rank),
    [1, 2, 3]
  );
  assert.equal(race.top3[0].displayName, "Alice");
  assert.equal(race.top3[0].totalSteps, 12000);
  assert.ok(Array.isArray(race.top3[0].equippedAccessories));
  assert.equal(race.userPlacement, 4);
});

test("opt-in: stealthed top-3 racer is redacted (??? / no cosmetics / null steps)", async () => {
  const me = user(ME_ID, "Sugaroro");
  const a = user("u-a", "Alice");
  const b = user("u-b", "Bob");
  const prisma = makeActivePrisma({
    activeParticipations: [
      {
        id: "rp-mine",
        userId: ME_ID,
        status: "ACCEPTED",
        race: {
          id: "race-stealth",
          name: "Stealth Race",
          status: "ACTIVE",
          powerupsEnabled: true,
          endsAt: new Date("2026-05-22T18:00:00Z"),
          participants: [
            { userId: "u-a", totalSteps: 12000, user: a },
            { userId: ME_ID, totalSteps: 8000, user: me },
            { userId: "u-b", totalSteps: 7000, user: b },
          ],
        },
      },
    ],
  });
  const restore = withStealthedRace("race-stealth", ["u-a", ME_ID]);
  try {
    const get = buildGetHomeRaceCard({ prisma, now: () => STEALTH_NOW });
    const res = await get({ userId: ME_ID, homeActiveRaces: true });
    const race = res.data.races[0];
    // u-a is stealthed -> redacted
    const alice = race.top3.find((t) => t.rank === 1);
    assert.equal(alice.displayName, "???");
    assert.equal(alice.totalSteps, null);
    assert.deepEqual(alice.equippedAccessories, []);
    assert.equal(alice.isStealthed, true);
    // self is never stealthed even if targeted
    const self = race.top3.find((t) => t.userId === ME_ID);
    assert.equal(self.displayName, "Sugaroro");
    assert.equal(self.isStealthed, false);
    assert.equal(self.totalSteps, 8000);
  } finally {
    restore();
  }
});

test("opt-in: handles fewer than 3 participants", async () => {
  const me = user(ME_ID, "Sugaroro");
  const a = user("u-a", "Alice");
  const prisma = makeActivePrisma({
    activeParticipations: [
      {
        id: "rp-mine",
        userId: ME_ID,
        status: "ACCEPTED",
        race: {
          id: "race-small",
          name: "Duo",
          status: "ACTIVE",
          powerupsEnabled: false,
          endsAt: new Date("2026-05-22T18:00:00Z"),
          participants: [
            { userId: "u-a", totalSteps: 4000, user: a },
            { userId: ME_ID, totalSteps: 3000, user: me },
          ],
        },
      },
    ],
  });
  const get = buildGetHomeRaceCard({ prisma, now: () => STEALTH_NOW });
  const res = await get({ userId: ME_ID, homeActiveRaces: true });
  const race = res.data.races[0];
  assert.equal(race.top3.length, 2);
  assert.equal(race.userPlacement, 2);
});

test("opt-in with NO active races falls through to legacy single-state logic", async () => {
  const prisma = makeActivePrisma({
    activeParticipations: [],
  });
  // Make public race available so fallthrough has something to return.
  prisma.race.findMany = async () => [
    {
      id: "race-daily",
      name: "Daily 10K Sprint",
      targetSteps: 10000,
      maxParticipants: 100,
      endsAt: new Date("2026-05-22T00:00:00Z"),
      seed: { kind: "DAILY_10K" },
      _count: { participants: 8 },
    },
  ];
  const get = buildGetHomeRaceCard({ prisma, now: () => STEALTH_NOW });
  const res = await get({ userId: ME_ID, homeActiveRaces: true });
  // Falls through; not ACTIVE_RACES.
  assert.equal(res.state, "PUBLIC_RACE");
  assert.equal(res.data.seedKind, "DAILY_10K");
});
