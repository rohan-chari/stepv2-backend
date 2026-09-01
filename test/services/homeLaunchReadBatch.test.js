const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createHomeLaunchReadBatch,
} = require("../../src/modules/home/services/homeLaunchReadBatch");

test("active home memberships for a launch wave use one bounded database read", async () => {
  const calls = [];
  const prisma = { raceParticipant: { async findMany(args) {
    calls.push(args);
    return args.where.userId.in.map((userId, index) => ({
      userId,
      id: `participant-${index}`,
      race: { id: "race-1", startedAt: new Date("2026-08-31T12:00:00Z") },
    }));
  } } };
  const batch = createHomeLaunchReadBatch();
  const users = Array.from({ length: 100 }, (_, index) => `user-${index}`);

  const rows = await Promise.all(users.map((userId) => batch.loadActiveRows({
    prisma,
    userId,
    supportsTeamRaces: false,
    select: { id: true, race: { select: { id: true, startedAt: true } } },
    maxRows: 5,
  })));

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].where.userId.in, users);
  assert.equal(rows.length, 100);
  assert.ok(rows.every((entry) => entry.length === 1));
  assert.ok(rows.every((entry, index) => entry[0].userId === users[index]));
});

test("presentation reads deduplicate shared leaders across simultaneous home cards", async () => {
  const calls = [];
  const prisma = { user: { async findMany(args) {
    calls.push(args);
    return args.where.id.in.map((id) => ({ id, displayName: id }));
  } } };
  const batch = createHomeLaunchReadBatch();

  const results = await Promise.all(Array.from({ length: 50 }, (_, index) =>
    batch.loadUsers({
      prisma,
      userIds: [`viewer-${index}`, "shared-leader"],
      select: { id: true, displayName: true },
    })));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].where.id.in.length, 51);
  assert.ok(results.every((rows) => rows.some((row) => row.id === "shared-leader")));
});

test("production home presentations reuse the shared generation-safe cache", async () => {
  const prisma = { user: { async findMany() { throw new Error("direct user read"); } } };
  const cacheCalls = [];
  const batch = createHomeLaunchReadBatch({
    defaultPrismaClient: prisma,
    presentationCache: {
      async getMany(ids, enabled) {
        cacheCalls.push({ ids, enabled });
        return new Map(ids.map((id) => [id, { id, displayName: id }]));
      },
    },
  });

  const rows = await batch.loadUsers({
    prisma,
    userIds: ["viewer", "shared-leader"],
    select: { id: true, displayName: true },
  });

  assert.deepEqual(cacheCalls, [{ ids: ["viewer", "shared-leader"], enabled: true }]);
  assert.deepEqual(rows.map((row) => row.id), ["viewer", "shared-leader"]);
});

test("frozen-client home cards hydrate a shared active roster once", async () => {
  const calls = [];
  const roster = Array.from({ length: 10000 }, (_, index) => ({
    id: `participant-${index}`,
    raceId: "race-1",
    userId: `user-${index}`,
    totalSteps: 10000 - index,
  }));
  const prisma = { raceParticipant: { async findMany(args) {
    calls.push(args);
    return roster;
  } } };
  const batch = createHomeLaunchReadBatch();

  const results = await Promise.all(Array.from({ length: 64 }, () =>
    batch.loadAcceptedRoster({
      prisma,
      raceId: "race-1",
      participantSelect: { id: true, userId: true, totalSteps: true },
    })));

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].where.raceId.in, ["race-1"]);
  assert.deepEqual(calls[0].select, {
    id: true,
    userId: true,
    totalSteps: true,
    raceId: true,
  });
  assert.equal(calls[0].include, undefined);
  assert.equal(results.length, 64);
  assert.ok(results.every((rows) => rows === results[0]));
  assert.equal(results[0].length, 10000);
});

test("frozen-client active membership lookup batches viewers without a roster join", async () => {
  const calls = [];
  const prisma = { raceParticipant: { async findMany(args) {
    calls.push(args);
    return args.where.userId.in.map((userId) => ({
      id: `participant-${userId}`,
      userId,
      race: { id: "race-1", startedAt: new Date("2026-08-31T12:00:00Z") },
    }));
  } } };
  const batch = createHomeLaunchReadBatch();

  const results = await Promise.all(Array.from({ length: 64 }, (_, index) =>
    batch.loadLegacyActiveRow({
      prisma,
      userId: `user-${index}`,
      supportsTeamRaces: false,
    })));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].where.userId.in.length, 64);
  assert.deepEqual(calls[0].include, { race: true });
  assert.ok(results.every(Boolean));
});

test("simple frozen-client races share a bounded top-three read", async () => {
  const calls = [];
  const prisma = { raceParticipant: { async findMany(args) {
    calls.push(args);
    return [0, 1, 2].map((index) => ({
      id: `participant-${index}`,
      raceId: args.where.raceId,
      userId: `leader-${index}`,
      totalSteps: 10000 - index,
      status: "ACCEPTED",
    }));
  } } };
  const batch = createHomeLaunchReadBatch();

  const results = await Promise.all(Array.from({ length: 64 }, () =>
    batch.loadTopAcceptedRoster({
      prisma,
      raceId: "race-1",
      participantSelect: { id: true, userId: true, totalSteps: true, status: true },
    })));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].take, 3);
  assert.equal(results[0].length, 3);
  assert.ok(results.every((rows) => rows === results[0]));
});

test("simple frozen-client viewer ranks and top-three rows share one SQL ranking", async () => {
  let calls = 0;
  const prisma = { async $queryRaw() {
    calls += 1;
    return Array.from({ length: 50 }, (_, index) => ({
      viewerUserId: `viewer-${index}`,
      userId: `viewer-${index}`,
      computedPlacement: index + 100,
      raceId: "race-1",
    }));
  } };
  const batch = createHomeLaunchReadBatch();
  const results = await Promise.all(Array.from({ length: 50 }, (_, index) =>
    batch.loadBoundedLegacyRoster({
      prisma,
      raceId: "race-1",
      userId: `viewer-${index}`,
    })));

  assert.equal(calls, 1);
  assert.ok(results.every((rows, index) =>
    rows.length === 1 && rows[0].viewerUserId === `viewer-${index}`));
});

test("pending invite batches preserve each request's expiration boundary", async () => {
  const expiresAt = new Date("2026-08-31T12:00:01Z");
  const prisma = { raceParticipant: { async findMany(args) {
    return args.where.userId.in.flatMap((userId) => [
      { userId, inviteExpiresAt: expiresAt, joinedAt: new Date(0), race: { id: "race-1" } },
    ]);
  } } };
  const batch = createHomeLaunchReadBatch();

  const [before, after] = await Promise.all([
    batch.loadPendingInvites({ prisma, userId: "before", now: new Date("2026-08-31T12:00:00Z"), select: { inviteExpiresAt: true, joinedAt: true, race: { select: { id: true } } } }),
    batch.loadPendingInvites({ prisma, userId: "after", now: new Date("2026-08-31T12:00:02Z"), select: { inviteExpiresAt: true, joinedAt: true, race: { select: { id: true } } } }),
  ]);

  assert.equal(before.length, 1);
  assert.equal(after.length, 0);
});
