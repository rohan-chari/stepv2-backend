const assert = require("node:assert/strict");
const test = require("node:test");

const { buildRenewSeededRaces } = require("../../src/modules/races/jobs/seededRaceRenewal");

// ET 14:00 EDT on 2026-06-25 (Thursday). Daily window [06-25T04Z, 06-26T04Z];
// weekly window Mon 06-22T04Z .. Mon 06-29T04Z (EDT, UTC-4).
const NOW = new Date("2026-06-25T18:00:00Z");
const silent = { log() {}, error() {} };

const dailySeed = {
  id: "seed-daily-10k",
  kind: "DAILY_10K",
  name: "Daily 10K Sprint",
  targetSteps: 10000,
  durationHours: 24,
  cadence: "DAILY",
  maxParticipants: 500,
  active: true,
};

const weeklySeed = {
  id: "seed-weekly-50k",
  kind: "WEEKLY_50K",
  name: "Weekly 50K Challenge",
  targetSteps: 50000,
  durationHours: 168,
  cadence: "WEEKLY",
  maxParticipants: 500,
  active: true,
};

function makeCtx({ seeds = [], races = [], participantsByRace = {} } = {}) {
  let idSeq = races.length;
  const emitted = [];
  const enqueued = [];
  const prisma = {
    async $transaction(fn) {
      return fn(prisma);
    },
    async $executeRaw() {
      return [];
    },
    raceSeed: {
      async findMany() {
        return seeds;
      },
    },
    race: {
      async findFirst({ where, orderBy }) {
        let rows = races.filter(
          (r) => r.seedId === where.seedId && r.status === where.status
        );
        if (orderBy) {
          const key = Object.keys(orderBy)[0];
          const dir = orderBy[key];
          rows = rows.slice().sort((a, b) => {
            const av = a[key] ? new Date(a[key]).getTime() : 0;
            const bv = b[key] ? new Date(b[key]).getTime() : 0;
            return dir === "asc" ? av - bv : bv - av;
          });
        }
        return rows[0] || null;
      },
      async create({ data }) {
        const race = { id: `race-${++idSeq}`, ...data };
        races.push(race);
        return race;
      },
      async update({ where, data }) {
        const race = races.find((r) => r.id === where.id);
        Object.assign(race, data);
        return race;
      },
    },
    raceParticipant: {
      async findMany({ where }) {
        const list = participantsByRace[where.raceId] || [];
        return list.filter((p) => p.status === where.status);
      },
      async update({ where, data }) {
        for (const list of Object.values(participantsByRace)) {
          const p = list.find((x) => x.id === where.id);
          if (p) Object.assign(p, data);
        }
        return null;
      },
    },
  };
  return {
    prisma,
    races,
    participantsByRace,
    emitted,
    enqueued,
    eventBus: { emit: (name, payload) => emitted.push({ name, payload }) },
  };
}

function buildRenew(ctx) {
  return buildRenewSeededRaces({
    prisma: ctx.prisma,
    appSettings: {
      async getFlag(key) {
        return key === "fundedPrizePoolsEnabled" || key === "payoutRoundingV1Enabled";
      },
    },
    now: () => NOW,
    logger: silent,
    eventBus: ctx.eventBus,
    enqueueRaceResolution: async (value) => ctx.enqueued.push(value),
  });
}

const iso = (d) => new Date(d).toISOString();

test("fresh start: creates current ACTIVE + next PENDING on ET-midnight boundaries (daily)", async () => {
  const ctx = makeCtx({ seeds: [dailySeed] });
  const results = await buildRenew(ctx)();

  assert.equal(ctx.races.length, 2);
  const active = ctx.races.find((r) => r.status === "ACTIVE");
  const pending = ctx.races.find((r) => r.status === "PENDING");

  assert.equal(iso(active.startedAt), "2026-06-25T04:00:00.000Z");
  assert.equal(iso(active.endsAt), "2026-06-26T04:00:00.000Z");
  assert.equal(active.timezone, "America/New_York");
  assert.equal(active.isPublic, true);
  assert.equal(active.maxParticipants, 500);

  // The next race stays PENDING with startedAt NULL until promotion.
  assert.equal(pending.startedAt, null);
  assert.equal(iso(pending.scheduledStartAt), "2026-06-26T04:00:00.000Z");
  assert.equal(iso(pending.endsAt), "2026-06-27T04:00:00.000Z");

  assert.deepEqual(
    results.map((r) => r.action).sort(),
    ["created-active", "created-upcoming"]
  );
});

test("fresh start: weekly seed aligns to Monday 00:00 ET", async () => {
  const ctx = makeCtx({ seeds: [weeklySeed] });
  await buildRenew(ctx)();

  const active = ctx.races.find((r) => r.status === "ACTIVE");
  const pending = ctx.races.find((r) => r.status === "PENDING");
  assert.equal(iso(active.startedAt), "2026-06-22T04:00:00.000Z"); // Mon
  assert.equal(iso(active.endsAt), "2026-06-29T04:00:00.000Z"); // next Mon
  assert.equal(iso(pending.scheduledStartAt), "2026-06-29T04:00:00.000Z");
  assert.equal(iso(pending.endsAt), "2026-07-06T04:00:00.000Z");
});

test("steady state (one ACTIVE covering now + one future PENDING) is a no-op", async () => {
  const ctx = makeCtx({
    seeds: [dailySeed],
    races: [
      {
        id: "active-1",
        seedId: dailySeed.id,
        status: "ACTIVE",
        startedAt: new Date("2026-06-25T04:00:00Z"),
        endsAt: new Date("2026-06-26T04:00:00Z"),
      },
      {
        id: "pending-1",
        seedId: dailySeed.id,
        status: "PENDING",
        startedAt: null,
        scheduledStartAt: new Date("2026-06-26T04:00:00Z"),
        endsAt: new Date("2026-06-27T04:00:00Z"),
      },
    ],
  });
  const results = await buildRenew(ctx)();
  assert.equal(results.length, 0);
  assert.equal(ctx.races.length, 2);
  assert.equal(ctx.emitted.length, 0);
});

test("idempotent: a second run in steady state changes nothing", async () => {
  const ctx = makeCtx({ seeds: [dailySeed] });
  const renew = buildRenew(ctx);
  await renew(); // creates 2
  const after1 = ctx.races.length;
  const results2 = await renew(); // should be a no-op now
  assert.equal(after1, 2);
  assert.equal(results2.length, 0);
  assert.equal(ctx.races.length, 2);
});

test("promotes a due PENDING to ACTIVE, emits RACE_STARTED, and creates the next PENDING", async () => {
  const ctx = makeCtx({
    seeds: [dailySeed],
    races: [
      {
        id: "pending-due",
        seedId: dailySeed.id,
        status: "PENDING",
        name: "Daily 10K Sprint",
        startedAt: null,
        scheduledStartAt: new Date("2026-06-25T04:00:00Z"), // already passed vs NOW
        endsAt: new Date("2026-06-26T04:00:00Z"),
        powerupsEnabled: false,
        powerupStepInterval: null,
      },
    ],
    participantsByRace: {
      "pending-due": [
        { id: "p1", userId: "u1", status: "ACCEPTED", nextBoxAtSteps: 0 },
        { id: "p2", userId: "u2", status: "ACCEPTED", nextBoxAtSteps: 0 },
      ],
    },
  });

  const results = await buildRenew(ctx)();

  const promoted = ctx.races.find((r) => r.id === "pending-due");
  assert.equal(promoted.status, "ACTIVE");
  assert.equal(iso(promoted.startedAt), "2026-06-25T04:00:00.000Z"); // = scheduled
  assert.equal(iso(promoted.endsAt), "2026-06-26T04:00:00.000Z"); // unchanged

  const ev = ctx.emitted.find((e) => e.name === "RACE_STARTED");
  assert.ok(ev, "RACE_STARTED should be emitted");
  assert.equal(ev.payload.raceId, "pending-due");
  assert.equal(ev.payload.creatorUserId, null); // -> handler notifies everyone
  assert.deepEqual(ev.payload.participantUserIds.sort(), ["u1", "u2"]);

  // A fresh PENDING for the following day was created.
  const newPending = ctx.races.find((r) => r.status === "PENDING");
  assert.ok(newPending);
  assert.equal(iso(newPending.scheduledStartAt), "2026-06-26T04:00:00.000Z");
  assert.equal(iso(newPending.endsAt), "2026-06-27T04:00:00.000Z");

  assert.deepEqual(
    results.map((r) => r.action).sort(),
    ["created-upcoming", "promoted"]
  );
});

test("a failed current-window bucket recovery does not block due legacy promotion", async () => {
  const ctx = makeCtx({
    seeds: [dailySeed],
    races: [{
      id: "legacy-due-after-recovery-error",
      seedId: dailySeed.id,
      status: "PENDING",
      name: dailySeed.name,
      scheduledStartAt: new Date("2026-06-25T04:00:00Z"),
      endsAt: new Date("2026-06-26T04:00:00Z"),
      powerupsEnabled: false,
      powerupStepInterval: null,
    }],
  });
  const errors = [];
  const renew = buildRenewSeededRaces({
    prisma: ctx.prisma,
    appSettings: { async getFlag() { return false; } },
    now: () => NOW,
    logger: { log() {}, error(...args) { errors.push(args); } },
    eventBus: ctx.eventBus,
    enqueueRaceResolution: async (value) => ctx.enqueued.push(value),
    seededRaceBuckets: {
      async finalise() { throw new Error("simulated finalization timeout"); },
    },
  });

  await renew();

  assert.equal(
    ctx.races.find((race) => race.id === "legacy-due-after-recovery-error").status,
    "ACTIVE",
  );
  assert.ok(errors.some(([message]) => /bucket recovery failed/i.test(message)));
});

test("promotion initializes nextBoxAtSteps for opt-ins when powerups are enabled", async () => {
  const ctx = makeCtx({
    seeds: [{ ...dailySeed, powerupsEnabled: true, powerupStepInterval: 2000 }],
    races: [
      {
        id: "pending-due",
        seedId: dailySeed.id,
        status: "PENDING",
        name: "Daily 10K Sprint",
        startedAt: null,
        scheduledStartAt: new Date("2026-06-25T04:00:00Z"),
        endsAt: new Date("2026-06-26T04:00:00Z"),
        powerupsEnabled: true,
        powerupStepInterval: 2000,
      },
    ],
    participantsByRace: {
      "pending-due": [
        { id: "p1", userId: "u1", status: "ACCEPTED", nextBoxAtSteps: 0 },
      ],
    },
  });

  await buildRenew(ctx)();

  assert.equal(ctx.participantsByRace["pending-due"][0].nextBoxAtSteps, 2000);
  assert.deepEqual(ctx.enqueued, [{
    raceId: "pending-due",
    reason: "RACE_START",
    priority: "IMMEDIATE",
  }]);
});

test("cold-start gap mid-day: ACTIVE anchors to today's ET midnight, not now", async () => {
  // Only a stale (already-ended) ACTIVE race exists, plus no pending.
  const ctx = makeCtx({
    seeds: [dailySeed],
    races: [
      {
        id: "stale",
        seedId: dailySeed.id,
        status: "ACTIVE",
        startedAt: new Date("2026-06-24T04:00:00Z"),
        endsAt: new Date("2026-06-25T04:00:00Z"), // ended before NOW
      },
    ],
  });
  const results = await buildRenew(ctx)();

  const fresh = ctx.races.find(
    (r) => r.status === "ACTIVE" && r.id !== "stale"
  );
  assert.ok(fresh, "a current ACTIVE race should be created");
  assert.equal(iso(fresh.startedAt), "2026-06-25T04:00:00.000Z"); // today midnight ET
  assert.equal(iso(fresh.endsAt), "2026-06-26T04:00:00.000Z");
  assert.ok(results.some((r) => r.action === "created-active"));
  assert.ok(results.some((r) => r.action === "created-upcoming"));
});

test("multiple seeds reconcile independently", async () => {
  const ctx = makeCtx({ seeds: [dailySeed, weeklySeed] });
  await buildRenew(ctx)();
  const daily = ctx.races.filter((r) => r.seedId === dailySeed.id);
  const weekly = ctx.races.filter((r) => r.seedId === weeklySeed.id);
  assert.equal(daily.length, 2);
  assert.equal(weekly.length, 2);
});

test("no active seeds: no-op", async () => {
  const ctx = makeCtx({ seeds: [] });
  const results = await buildRenew(ctx)();
  assert.equal(results.length, 0);
  assert.equal(ctx.races.length, 0);
});
