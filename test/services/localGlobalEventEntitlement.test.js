const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ensureEntitlementForUser,
  eventsForUser,
  ensureRaceGlobalEventEligibility,
  findDueEntitlementsForUpdate,
  materializeEntitlementsForActiveRacers,
} = require("../../src/modules/steps/services/globalStepEventEntitlement");
const {
  globalEventTimezoneMutation,
  canonicalIanaTimeZone,
} = require("../../src/modules/users/services/globalEventTimezone");
const {
  findEligibleByRace,
  findViewerActive,
} = require("../../src/modules/steps/models/globalStepEventEntitlement");

const EVENT = {
  id: "event-1",
  scheduleMode: "LOCAL_ENTITLEMENTS",
  eventDay: "2026-08-20",
  localStartMinute: 17 * 60 + 17,
  durationMinutes: 30,
  multiplier: 2,
};

test("entitlement snapshots stable timezone once and duplicate workers adopt it", async () => {
  let winner = null;
  const tx = {
    globalStepEventEntitlement: {
      async findUnique() { return winner; },
      async upsert({ create }) {
        if (!winner) winner = { id: "ent-1", ...create };
        return winner;
      },
    },
  };
  const user = {
    id: "user-1",
    timezone: "Europe/Madrid",
    globalEventTimezone: "America/New_York",
  };

  const first = await ensureEntitlementForUser(tx, {
    event: EVENT, user, now: new Date("2026-08-20T00:00:00Z"),
  });
  user.globalEventTimezone = "Europe/Madrid";
  const second = await ensureEntitlementForUser(tx, {
    event: EVENT, user, now: new Date("2026-08-20T00:00:01Z"),
  });

  assert.equal(first.id, second.id);
  assert.equal(second.timezone, "America/New_York");
  assert.equal(second.startsAt.toISOString(), "2026-08-20T21:17:00.000Z");
});

test("null or invalid stable timezone snapshots New York without changing the user", async () => {
  let created;
  const tx = {
    globalStepEventEntitlement: {
      async findUnique() { return null; },
      async upsert({ create }) { created = create; return { id: "ent-1", ...create }; },
    },
  };
  const user = { id: "user-1", timezone: null, globalEventTimezone: "Bad/Zone" };
  const result = await ensureEntitlementForUser(tx, {
    event: EVENT, user, now: new Date("2026-08-20T00:00:00Z"),
  });
  assert.equal(result.timezone, "America/New_York");
  assert.equal(created.timezone, "America/New_York");
  assert.equal(user.globalEventTimezone, "Bad/Zone");
});

test("after a local window ends no entitlement is created", async () => {
  let writes = 0;
  const result = await ensureEntitlementForUser({
    globalStepEventEntitlement: {
      async findUnique() { return null; },
      async upsert() { writes += 1; },
    },
  }, {
    event: EVENT,
    user: { id: "user-1", globalEventTimezone: "Europe/Madrid" },
    now: new Date("2026-08-20T16:00:00Z"),
    allowActive: true,
  });
  assert.equal(result, null);
  assert.equal(writes, 0);
});

test("eventsForUser is the only participant lookup seam", () => {
  const map = new Map([
    ["new-york", [{ id: "ny" }]],
    ["madrid", [{ id: "mad" }]],
  ]);
  assert.deepEqual(eventsForUser(map, "new-york"), [{ id: "ny" }]);
  assert.deepEqual(eventsForUser(map, "unknown"), []);
});

test("stable timezone candidate promotes only after 48 hours of matching observations", () => {
  const first = globalEventTimezoneMutation({
    user: { globalEventTimezone: "America/New_York" },
    observedTimezone: "Europe/Madrid",
    now: new Date("2026-08-18T10:00:00Z"),
  });
  assert.deepEqual(first, {
    globalEventTimezoneCandidate: "Europe/Madrid",
    globalEventTimezoneCandidateSince: new Date("2026-08-18T10:00:00Z"),
  });

  const tooSoon = globalEventTimezoneMutation({
    user: {
      globalEventTimezone: "America/New_York",
      globalEventTimezoneCandidate: "Europe/Madrid",
      globalEventTimezoneCandidateSince: new Date("2026-08-18T10:00:00Z"),
    },
    observedTimezone: "Europe/Madrid",
    now: new Date("2026-08-20T09:59:59Z"),
  });
  assert.equal(tooSoon, null);

  const promoted = globalEventTimezoneMutation({
    user: {
      globalEventTimezone: "America/New_York",
      globalEventTimezoneCandidate: "Europe/Madrid",
      globalEventTimezoneCandidateSince: new Date("2026-08-18T10:00:00Z"),
    },
    observedTimezone: "Europe/Madrid",
    now: new Date("2026-08-20T10:00:00Z"),
  });
  assert.deepEqual(promoted, {
    globalEventTimezone: "Europe/Madrid",
    globalEventTimezoneCandidate: null,
    globalEventTimezoneCandidateSince: null,
  });
});

test("legacy IANA aliases are canonicalized before becoming durable event timezones", () => {
  assert.equal(canonicalIanaTimeZone("US/Central"), "America/Chicago");
  assert.deepEqual(globalEventTimezoneMutation({
    user: { globalEventTimezone: "America/New_York" },
    observedTimezone: "US/Central",
    now: new Date("2026-08-18T10:00:00Z"),
  }), {
    globalEventTimezoneCandidate: "America/Chicago",
    globalEventTimezoneCandidateSince: new Date("2026-08-18T10:00:00Z"),
  });
});

test("settlement eligibility repair inserts a missing impact before loading the event map", async () => {
  const writes = [];
  let fenceClaims = 0;
  const lockOrder = [];
  const entitlement = {
    id: "ent-1",
    eventId: "event-1",
    userId: "user-1",
    startsAt: new Date("2026-08-20T14:00:00.000Z"),
    endsAt: new Date("2026-08-20T14:30:00.000Z"),
    startOutcome: "ACTIVATED_ON_TIME",
    startProcessedAt: new Date("2026-08-20T14:00:10.000Z"),
  };
  const client = {
    async $transaction(callback) {
      return callback({
        async $executeRawUnsafe() { lockOrder.push("global-enrollment"); },
        globalStepEventEntitlement: {
          async findMany() { return [entitlement]; },
          async updateMany() { assert.fail("an activated entitlement is immutable"); },
          async update() { assert.fail("an activated entitlement is immutable"); },
        },
        globalEventRaceImpact: {
          async findMany() { return []; },
          async createMany({ data }) { writes.push(...data); return { count: data.length }; },
        },
        globalEventSummaryWork: {
          async findMany() { return []; },
        },
      });
    },
    globalStepEvent: {
      async findMany() { return []; },
    },
    globalEventRaceImpact: {
      async findMany() {
        return writes.map((row) => ({ id: "impact-1", status: "PENDING", ...row }));
      },
    },
    globalStepEventEntitlement: {
      async findMany() {
        return [{ ...entitlement, event: EVENT }];
      },
    },
  };

  const result = await ensureRaceGlobalEventEligibility({
    race: {
      id: "race-1",
      startedAt: new Date("2026-08-20T13:00:00.000Z"),
      participants: [{
        userId: "user-1",
        status: "ACCEPTED",
        joinedAt: new Date("2026-08-20T13:00:00.000Z"),
      }],
    },
    at: new Date("2026-08-20T14:30:00.000Z"),
    prisma: client,
    async acquireRaceFence(_tx, { raceId }) {
      assert.equal(raceId, "race-1");
      fenceClaims += 1;
      lockOrder.push("race-fence");
    },
  });

  assert.equal(fenceClaims, 1);
  assert.deepEqual(lockOrder.slice(0, 2), ["race-fence", "global-enrollment"]);
  assert.deepEqual(writes, [{
    eventId: "event-1",
    raceId: "race-1",
    userId: "user-1",
    status: "PENDING",
  }]);
  assert.equal(eventsForUser(result, "user-1").length, 1);
});

test("settlement eligibility repair still enrolls v2 membership before WAITING_SYNC capture", async () => {
  const writes = [];
  const event = { ...EVENT, summaryAttributionVersion: 2 };
  const entitlement = {
    id: "ent-v2",
    eventId: event.id,
    userId: "user-1",
    startsAt: new Date("2026-08-20T14:00:00.000Z"),
    endsAt: new Date("2026-08-20T14:30:00.000Z"),
    startOutcome: "ACTIVATED_ON_TIME",
    startProcessedAt: new Date("2026-08-20T14:00:10.000Z"),
    event,
  };
  const client = {
    async $transaction(callback) {
      return callback({
        async $executeRawUnsafe() {},
        globalStepEventEntitlement: {
          async findMany() { return [entitlement]; },
          async update() { assert.fail("an activated entitlement is immutable"); },
        },
        globalEventRaceImpact: {
          async findMany() { return []; },
          async createMany({ data }) { writes.push(...data); return { count: data.length }; },
        },
        globalEventSummaryWork: {
          async findMany() {
            return [{
              eventId: event.id,
              userId: "user-1",
              status: "WAITING_SYNC",
            }];
          },
        },
      });
    },
    globalStepEvent: { async findMany() { return []; } },
    globalEventRaceImpact: {
      async findMany() {
        return writes.map((row) => ({ id: "impact-v2", status: "PENDING", ...row }));
      },
    },
    globalStepEventEntitlement: {
      async findMany() { return [entitlement]; },
    },
  };

  const result = await ensureRaceGlobalEventEligibility({
    race: {
      id: "race-1",
      startedAt: new Date("2026-08-20T13:00:00.000Z"),
      participants: [{
        userId: "user-1",
        status: "ACCEPTED",
        joinedAt: new Date("2026-08-20T13:00:00.000Z"),
      }],
    },
    at: new Date("2026-08-20T14:30:00.000Z"),
    prisma: client,
    async acquireRaceFence() {},
  });

  assert.deepEqual(writes, [{
    eventId: event.id,
    raceId: "race-1",
    userId: "user-1",
    status: "PENDING",
    attributionVersion: 2,
  }]);
  assert.equal(eventsForUser(result, "user-1").length, 1);
});

test("settlement eligibility repair uses a long enough transaction timeout for weekly fields", async () => {
  let options;
  const client = {
    async $transaction(callback, transactionOptions) {
      options = transactionOptions;
      return callback({
        async $executeRawUnsafe() {},
        globalStepEventEntitlement: { async findMany() { return []; } },
      });
    },
    globalStepEvent: { async findMany() { return []; } },
    globalEventRaceImpact: { async findMany() { return []; } },
    globalStepEventEntitlement: { async findMany() { return []; } },
  };

  await ensureRaceGlobalEventEligibility({
    race: {
      id: "weekly-race",
      startedAt: new Date("2026-08-17T04:00:00.000Z"),
      participants: [{ userId: "user-1", status: "ACCEPTED" }],
    },
    at: new Date("2026-08-24T04:00:00.000Z"),
    prisma: client,
    async acquireRaceFence() {},
  });

  assert.deepEqual(options, { timeout: 30_000, maxWait: 10_000 });
});

test("boundary workers claim due entitlement ids with SKIP LOCKED", async () => {
  const sql = [];
  const tx = {
    async $queryRawUnsafe(statement) {
      sql.push(statement);
      return [{ id: "ent-2" }, { id: "ent-1" }];
    },
    globalStepEventEntitlement: {
      async findMany({ where }) {
        assert.deepEqual(where, { id: { in: ["ent-2", "ent-1"] } });
        return [{ id: "ent-1" }, { id: "ent-2" }];
      },
    },
  };

  const rows = await findDueEntitlementsForUpdate(tx, {
    boundary: "start",
    now: new Date("2026-08-20T14:00:00.000Z"),
    take: 100,
    includeEvent: true,
  });

  assert.match(sql[0], /FOR UPDATE SKIP LOCKED/);
  assert.match(sql[0], /"start_processed_at" IS NULL/);
  assert.deepEqual(rows.map((row) => row.id), ["ent-2", "ent-1"]);
});

test("eligible local windows are clipped to the participant join instant", async () => {
  const client = {
    globalStepEvent: { async findMany() { return []; } },
    globalEventRaceImpact: {
      async findMany() {
        return [{ id: "impact-1", eventId: "event-1", userId: "user-1", status: "PENDING" }];
      },
    },
    globalStepEventEntitlement: {
      async findMany() {
        return [{
          id: "ent-1", eventId: "event-1", userId: "user-1",
          startsAt: new Date("2026-08-20T14:00:00Z"),
          endsAt: new Date("2026-08-20T14:30:00Z"),
          event: EVENT,
        }];
      },
    },
    raceParticipant: {
      async findMany() {
        return [{ userId: "user-1", joinedAt: new Date("2026-08-20T14:12:00Z") }];
      },
    },
  };
  const map = await findEligibleByRace({
    raceId: "race-1",
    userIds: ["user-1"],
    rangeStart: new Date("2026-08-20T14:05:00Z"),
    rangeEnd: new Date("2026-08-20T14:30:00Z"),
    client,
  });
  assert.equal(eventsForUser(map, "user-1")[0].startsAt.toISOString(), "2026-08-20T14:12:00.000Z");
});

test("viewer active lookup requires an accepted non-forfeited live membership", async () => {
  let impactWhere;
  const client = {
    globalStepEventEntitlement: {
      async findFirst() {
        return { ...EVENT, id: "ent-1", eventId: EVENT.id,
          startsAt: new Date("2026-08-20T14:00:00Z"),
          endsAt: new Date("2026-08-20T14:30:00Z"), event: EVENT };
      },
    },
    globalEventRaceImpact: {
      async findFirst({ where }) { impactWhere = where; return null; },
    },
  };
  assert.equal(await findViewerActive({
    userId: "user-1", raceId: "race-1",
    now: new Date("2026-08-20T14:10:00Z"), client,
  }), null);
  assert.deepEqual(impactWhere.race.participants.some, {
    userId: "user-1",
    status: "ACCEPTED",
    forfeitedAt: null,
    finishedAt: null,
  });
});

test("materialization cursor advances past a full page of ended timezone candidates", async () => {
  const users = Array.from({ length: 150 }, (_, index) => ({
    id: `user-${String(index).padStart(3, "0")}`,
    timezone: index < 110 ? "Pacific/Kiritimati" : "America/Adak",
    globalEventTimezone: index < 110 ? "Pacific/Kiritimati" : "America/Adak",
  }));
  const created = [];
  const client = {
    raceParticipant: {
      async findMany({ where, take }) {
        const after = where.userId?.gt || "";
        return users.filter((user) => user.id > after).slice(0, take)
          .map((user) => ({ user }));
      },
    },
    globalStepEventEntitlement: {
      async findUnique() { return null; },
      async upsert({ create }) { created.push(create.userId); return { id: create.userId, ...create }; },
    },
  };
  const event = {
    id: "event-cursor", scheduleMode: "LOCAL_ENTITLEMENTS",
    eventDay: "2026-08-20", localStartMinute: 8 * 60,
    durationMinutes: 30, multiplier: 2,
  };
  const first = await materializeEntitlementsForActiveRacers(event, {
    prisma: client, now: new Date("2026-08-20T00:00:00Z"),
    batchSize: 100, returnPage: true,
  });
  const second = await materializeEntitlementsForActiveRacers(event, {
    prisma: client, now: new Date("2026-08-20T00:00:00Z"),
    batchSize: 100, returnPage: true, afterUserId: first.nextCursor,
  });

  assert.deepEqual(first, {
    candidates: 100, created: 0, nextCursor: "user-099", exhausted: false,
  });
  assert.deepEqual(second, {
    candidates: 50, created: 40, nextCursor: "user-149", exhausted: true,
  });
  assert.deepEqual(created, users.slice(110).map((user) => user.id));
});

test("production materialization writes one bounded entitlement/event page instead of per-user transactions", async () => {
  const users = Array.from({ length: 100 }, (_, index) => ({
    id: `batch-user-${String(index).padStart(3, "0")}`,
    timezone: "America/New_York",
    globalEventTimezone: "America/New_York",
  }));
  const entitlements = [];
  const domainEvents = [];
  const audiences = [];
  const tx = {
    globalStepEventEntitlement: {
      async createMany({ data }) {
        entitlements.push(...data.map((row, index) => ({
          id: `entitlement-${index}`, scheduleRevision: 0, ...row,
        })));
        return { count: data.length };
      },
      async findMany() { return entitlements; },
    },
    domainEventOutbox: {
      async createMany({ data }) {
        domainEvents.push(...data.map((row, index) => ({ id: `event-${index}`, ...row })));
        return { count: data.length };
      },
      async findMany() { return domainEvents; },
    },
    domainEventAudience: {
      async createMany({ data }) { audiences.push(...data); return { count: data.length }; },
    },
  };
  const client = {
    raceParticipant: { async findMany() { return users.map((user) => ({ user })); } },
    globalStepEventEntitlement: tx.globalStepEventEntitlement,
    async $transaction(work) { return work(tx); },
  };
  const page = await materializeEntitlementsForActiveRacers({
    ...EVENT, eventDay: "2098-08-26", localStartMinute: 600,
  }, {
    prisma: client, now: new Date("2098-08-25T10:00:00.000Z"),
    batchSize: 100, returnPage: true,
    generationUsable: async () => true,
    recordCounters: async () => {},
  });
  assert.equal(entitlements.length, 100);
  assert.equal(domainEvents.length, 100);
  assert.equal(audiences.length, 100);
  assert.equal(page.created, 100);
  assert.equal(page.nextCursor, "batch-user-099");
  assert.equal(page.exhausted, false);
});

test("production materialization persists a 500-user page with one set-based statement", async () => {
  const users = Array.from({ length: 500 }, (_, index) => ({
    id: `set-user-${String(index).padStart(3, "0")}`,
    timezone: "America/New_York",
    globalEventTimezone: "America/New_York",
  }));
  let statements = 0;
  const tx = {
    async $queryRawUnsafe(_sql, preparedJson) {
      statements += 1;
      assert.equal(JSON.parse(preparedJson).length, 500);
      return [{ created: 500, selected: 500, events: 500, conflicts: 0 }];
    },
    globalStepEventEntitlement: {
      async createMany() { throw new Error("set-based path must not call createMany"); },
    },
  };
  const client = {
    raceParticipant: { async findMany() { return users.map((user) => ({ user })); } },
    globalStepEventEntitlement: tx.globalStepEventEntitlement,
    async $transaction(work) { return work(tx); },
  };

  const page = await materializeEntitlementsForActiveRacers({
    ...EVENT, eventDay: "2098-08-26", localStartMinute: 600,
  }, {
    prisma: client, now: new Date("2098-08-25T10:00:00.000Z"),
    batchSize: 500, returnPage: true,
    generationUsable: async () => true,
    recordCounters: async () => {},
  });

  assert.equal(statements, 1);
  assert.equal(page.created, 500);
  assert.equal(page.nextCursor, "set-user-499");
  assert.equal(page.exhausted, false);
});
