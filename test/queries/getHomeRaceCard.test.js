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

// The ACTIVE_RACES path now computes each participant's live race-relative
// total via calculateBaseAdjusted + calculateCurrentTotal (same math as the
// race-detail screen) instead of reading the cached total_steps column. Those
// helpers read step samples / daily steps / active effects through injectable
// models. These mocks let tests drive the live totals deterministically.
//
// stepsByUser maps userId -> live base step total. calculateBaseAdjusted sums
// step_samples across (up to) two windows per participant; we make
// sumStepsInWindow return the user's whole total on the FIRST window it sees for
// that user and 0 afterwards, so the computed baseAdjusted equals the configured
// value regardless of timezone windowing. Steps (daily) is never needed because
// samples are non-zero.
function makeFixedStepModels(stepsByUser = {}) {
  const seen = new Set();
  return {
    StepSample: {
      async sumStepsInWindow(userId) {
        if (seen.has(userId)) return 0;
        seen.add(userId);
        return stepsByUser[userId] || 0;
      },
    },
    Steps: {
      async findByUserIdAndDateRange() {
        return [];
      },
      // No daily-aggregate row for the start day; step samples win via Math.max
      // in raceStateResolution's local-midnight branch.
      async findByUserIdAndDate() {
        return null;
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
  const startedAt = new Date("2026-05-21T00:00:00Z");
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
          startedAt,
          endsAt: new Date("2026-05-22T18:00:00Z"),
          participants: [
            { id: "rp-a", userId: "u-a", joinedAt: startedAt, totalSteps: 12000, user: a },
            { id: "rp-b", userId: "u-b", joinedAt: startedAt, totalSteps: 9000, user: b },
            { id: "rp-c", userId: "u-c", joinedAt: startedAt, totalSteps: 7000, user: c },
            { id: "rp-me", userId: ME_ID, joinedAt: startedAt, totalSteps: 5000, user: me },
          ],
        },
      },
    ],
  });
  // Live totals match the cached column here; ranking/order unchanged.
  const { Steps, StepSample } = makeFixedStepModels({
    "u-a": 12000,
    "u-b": 9000,
    "u-c": 7000,
    [ME_ID]: 5000,
  });
  const get = buildGetHomeRaceCard({ prisma, now: () => STEALTH_NOW, Steps, StepSample });
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
  const startedAt = new Date("2026-05-21T00:00:00Z");
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
          startedAt,
          endsAt: new Date("2026-05-22T18:00:00Z"),
          participants: [
            { id: "rp-a", userId: "u-a", joinedAt: startedAt, totalSteps: 12000, user: a },
            { id: "rp-me", userId: ME_ID, joinedAt: startedAt, totalSteps: 8000, user: me },
            { id: "rp-b", userId: "u-b", joinedAt: startedAt, totalSteps: 7000, user: b },
          ],
        },
      },
    ],
  });
  const { Steps, StepSample } = makeFixedStepModels({
    "u-a": 12000,
    [ME_ID]: 8000,
    "u-b": 7000,
  });
  // Powerups enabled: inject a RaceActiveEffect mock that exposes the STEALTH
  // effects (via findActiveForRace) and no per-participant modifier effects
  // (via findEffectsForRaceByType), so live totals equal the base steps.
  const stealthed = new Set(["u-a", ME_ID]);
  const RaceActiveEffect = {
    async findActiveForRace(id) {
      if (id !== "race-stealth") return [];
      return [...stealthed].map((uid) => ({
        type: "STEALTH_MODE",
        targetUserId: uid,
        status: "ACTIVE",
      }));
    },
    async findEffectsForRaceByType() {
      return [];
    },
  };
  const get = buildGetHomeRaceCard({
    prisma,
    now: () => STEALTH_NOW,
    Steps,
    StepSample,
    RaceActiveEffect,
  });
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
});

test("opt-in: handles fewer than 3 participants", async () => {
  const me = user(ME_ID, "Sugaroro");
  const a = user("u-a", "Alice");
  const startedAt = new Date("2026-05-21T00:00:00Z");
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
          startedAt,
          endsAt: new Date("2026-05-22T18:00:00Z"),
          participants: [
            { id: "rp-a", userId: "u-a", joinedAt: startedAt, totalSteps: 4000, user: a },
            { id: "rp-me", userId: ME_ID, joinedAt: startedAt, totalSteps: 3000, user: me },
          ],
        },
      },
    ],
  });
  const { Steps, StepSample } = makeFixedStepModels({ "u-a": 4000, [ME_ID]: 3000 });
  const get = buildGetHomeRaceCard({ prisma, now: () => STEALTH_NOW, Steps, StepSample });
  const res = await get({ userId: ME_ID, homeActiveRaces: true });
  const race = res.data.races[0];
  assert.equal(race.top3.length, 2);
  assert.equal(race.userPlacement, 2);
});

// ---------------------------------------------------------------------------
// Live step computation for ACTIVE_RACES (the cache-staleness fix). These
// assert that home reads the SAME live race-relative totals as the race-detail
// screen (computed via calculateBaseAdjusted + calculateCurrentTotal) rather
// than the cached total_steps column.
// ---------------------------------------------------------------------------

const SEED_STARTED_AT = new Date("2026-05-21T00:00:00Z");

function seededRacePrisma({ raceId, powerupsEnabled = false, participants }) {
  return makeActivePrisma({
    activeParticipations: [
      {
        id: "rp-mine",
        userId: ME_ID,
        status: "ACCEPTED",
        race: {
          id: raceId,
          name: "Seeded 10K",
          status: "ACTIVE",
          powerupsEnabled,
          startedAt: SEED_STARTED_AT,
          endsAt: new Date("2026-05-22T18:00:00Z"),
          participants,
        },
      },
    ],
  });
}

test("opt-in: top-3 steps reflect LIVE computation, not stale cache", async () => {
  const me = user(ME_ID, "Sugaroro");
  const a = user("u-a", "Alice");
  // Cached column is stale/low; live samples are much higher.
  const prisma = seededRacePrisma({
    raceId: "race-seeded",
    participants: [
      { id: "rp-a", userId: "u-a", joinedAt: SEED_STARTED_AT, totalSteps: 1000, finishedAt: null, user: a },
      { id: "rp-me", userId: ME_ID, joinedAt: SEED_STARTED_AT, totalSteps: 500, finishedAt: null, user: me },
    ],
  });
  const { Steps, StepSample } = makeFixedStepModels({ "u-a": 5000, [ME_ID]: 3000 });
  const get = buildGetHomeRaceCard({ prisma, now: () => STEALTH_NOW, Steps, StepSample });
  const res = await get({ userId: ME_ID, homeActiveRaces: true });
  const race = res.data.races[0];
  const alice = race.top3.find((t) => t.userId === "u-a");
  const self = race.top3.find((t) => t.userId === ME_ID);
  assert.equal(alice.totalSteps, 5000); // live, not cached 1000
  assert.equal(self.totalSteps, 3000); // live, not cached 500
});

test("opt-in: placement derived from LIVE totals, not stale cache", async () => {
  // Cache says I'm rank 1 (highest total_steps); live says I'm last.
  const me = user(ME_ID, "Sugaroro");
  const a = user("u-a", "Alice");
  const b = user("u-b", "Bob");
  const prisma = seededRacePrisma({
    raceId: "race-flip",
    participants: [
      { id: "rp-me", userId: ME_ID, joinedAt: SEED_STARTED_AT, totalSteps: 9999, finishedAt: null, user: me },
      { id: "rp-a", userId: "u-a", joinedAt: SEED_STARTED_AT, totalSteps: 10, finishedAt: null, user: a },
      { id: "rp-b", userId: "u-b", joinedAt: SEED_STARTED_AT, totalSteps: 20, finishedAt: null, user: b },
    ],
  });
  // Live order: Alice 8000 > Bob 6000 > me 100.
  const { Steps, StepSample } = makeFixedStepModels({
    "u-a": 8000,
    "u-b": 6000,
    [ME_ID]: 100,
  });
  const get = buildGetHomeRaceCard({ prisma, now: () => STEALTH_NOW, Steps, StepSample });
  const res = await get({ userId: ME_ID, homeActiveRaces: true });
  const race = res.data.races[0];
  assert.deepEqual(
    race.top3.map((t) => t.userId),
    ["u-a", "u-b", ME_ID]
  );
  assert.equal(race.top3[0].totalSteps, 8000);
  assert.equal(race.userPlacement, 3); // live last, despite cache rank 1
});

test("opt-in: powerup modifiers reflected in live top-3 (RUNNERS_HIGH doubles)", async () => {
  const me = user(ME_ID, "Sugaroro");
  const a = user("u-a", "Alice");
  const prisma = seededRacePrisma({
    raceId: "race-buff",
    powerupsEnabled: true,
    participants: [
      { id: "rp-a", userId: "u-a", joinedAt: SEED_STARTED_AT, totalSteps: 4000, finishedAt: null, bonusSteps: 0, user: a },
      { id: "rp-me", userId: ME_ID, joinedAt: SEED_STARTED_AT, totalSteps: 0, finishedAt: null, bonusSteps: 0, user: me },
    ],
  });
  // Alice has a RUNNERS_HIGH effect covering the whole race window, so her base
  // 4000 steps are doubled (+4000 buffed) -> 8000. Me has 1000 base, no buff.
  const { Steps } = makeFixedStepModels({});
  const RaceActiveEffect = {
    async findActiveForRace() {
      return [];
    },
    async findEffectsForRaceByType(raceId, participantId, type) {
      if (participantId === "rp-a" && type === "RUNNERS_HIGH") {
        return [
          {
            type: "RUNNERS_HIGH",
            startsAt: SEED_STARTED_AT,
            expiresAt: new Date("2026-05-22T18:00:00Z"),
            metadata: {},
          },
        ];
      }
      return [];
    },
  };
  // sumStepsInWindow is called by calculateBaseAdjusted (start-day window, then
  // subsequent window) AND by computeEffectModifiers (effect window). Model it
  // as: Alice always has 4000 steps in the queried windows (so base = 4000 from
  // the start-day window, and the RUNNERS_HIGH window also sums 4000 -> doubled
  // total 8000); me has 1000 base and no effect window query.
  const StepSampleBuff = {
    async sumStepsInWindow(userId) {
      // Alice: 4000 in every queried window (start-day base AND the RUNNERS_HIGH
      // effect window). Me: 1000 (start-day base; no effect window queried).
      if (userId === "u-a") return 4000;
      if (userId === ME_ID) return 1000;
      return 0;
    },
  };
  const get = buildGetHomeRaceCard({
    prisma,
    now: () => STEALTH_NOW,
    Steps,
    StepSample: StepSampleBuff,
    RaceActiveEffect,
  });
  const res = await get({ userId: ME_ID, homeActiveRaces: true });
  const race = res.data.races[0];
  const alice = race.top3.find((t) => t.userId === "u-a");
  // base 4000 + buffed 4000 = 8000 (RUNNERS_HIGH doubles). Not the cached 4000.
  assert.equal(alice.totalSteps, 8000);
  assert.equal(race.top3[0].userId, "u-a");
});

test("opt-in: finished racer uses finishTotalSteps (not recomputed)", async () => {
  const me = user(ME_ID, "Sugaroro");
  const a = user("u-a", "Alice");
  const prisma = seededRacePrisma({
    raceId: "race-finish",
    participants: [
      {
        id: "rp-a",
        userId: "u-a",
        joinedAt: SEED_STARTED_AT,
        totalSteps: 7777,
        finishedAt: new Date("2026-05-21T10:00:00Z"),
        finishTotalSteps: 10000,
        placement: 1,
        user: a,
      },
      { id: "rp-me", userId: ME_ID, joinedAt: SEED_STARTED_AT, totalSteps: 0, finishedAt: null, user: me },
    ],
  });
  // Live base for the finisher would be 200 if recomputed, but finishers must
  // use their frozen finishTotalSteps (10000). Me has 3000 live.
  const { Steps, StepSample } = makeFixedStepModels({ "u-a": 200, [ME_ID]: 3000 });
  const get = buildGetHomeRaceCard({ prisma, now: () => STEALTH_NOW, Steps, StepSample });
  const res = await get({ userId: ME_ID, homeActiveRaces: true });
  const race = res.data.races[0];
  // Finisher sorts first and shows finishTotalSteps, not the live recompute.
  assert.equal(race.top3[0].userId, "u-a");
  assert.equal(race.top3[0].totalSteps, 10000);
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
