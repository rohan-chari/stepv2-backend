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
  const prisma = makePrisma({
    invites: [
      {
        id: "rp-1",
        userId: ME_ID,
        status: "INVITED",
        createdAt: new Date("2026-05-21T16:00:00Z"),
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
