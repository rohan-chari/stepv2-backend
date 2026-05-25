const assert = require("node:assert/strict");
const test = require("node:test");

const { buildRenewSeededRaces } = require("../../src/jobs/seededRaceRenewal");

function makePrisma({ seeds = [], liveRacesBySeed = {} } = {}) {
  const created = [];
  return {
    created,
    prisma: {
      raceSeed: {
        async findMany() {
          return seeds;
        },
      },
      race: {
        async findFirst({ where }) {
          return liveRacesBySeed[where.seedId] || null;
        },
        async create({ data }) {
          const race = { id: `race-${created.length + 1}`, ...data };
          created.push(race);
          return { id: race.id, name: data.name };
        },
      },
    },
  };
}

const FIXED_NOW = new Date("2026-05-21T18:00:00Z");

test("renewSeededRaces creates a race when no live race exists for a seed", async () => {
  const ctx = makePrisma({
    seeds: [
      {
        id: "seed-daily-10k",
        kind: "DAILY_10K",
        name: "Daily 10K Sprint",
        targetSteps: 10000,
        durationHours: 24,
        cadence: "DAILY",
        maxParticipants: 100,
        active: true,
      },
    ],
    liveRacesBySeed: {},
  });

  const renew = buildRenewSeededRaces({
    prisma: ctx.prisma,
    now: () => FIXED_NOW,
    logger: { log() {}, error() {} },
  });

  const created = await renew();

  assert.equal(created.length, 1);
  assert.equal(ctx.created.length, 1);
  assert.equal(ctx.created[0].seedId, "seed-daily-10k");
  assert.equal(ctx.created[0].creatorId, null);
  assert.equal(ctx.created[0].isPublic, true);
  assert.equal(ctx.created[0].status, "ACTIVE");
  assert.equal(ctx.created[0].targetSteps, 10000);
  // Step-goal-only races: no endsAt is set
  assert.equal(ctx.created[0].endsAt, undefined);
});

test("renewSeededRaces skips seeds that already have a live race", async () => {
  const ctx = makePrisma({
    seeds: [
      {
        id: "seed-daily-10k",
        kind: "DAILY_10K",
        name: "Daily 10K Sprint",
        targetSteps: 10000,
        durationHours: 24,
        cadence: "DAILY",
        maxParticipants: 100,
        active: true,
      },
    ],
    liveRacesBySeed: { "seed-daily-10k": { id: "existing-race" } },
  });

  const renew = buildRenewSeededRaces({
    prisma: ctx.prisma,
    now: () => FIXED_NOW,
    logger: { log() {}, error() {} },
  });

  const created = await renew();
  assert.equal(created.length, 0);
  assert.equal(ctx.created.length, 0);
});

test("renewSeededRaces handles multiple seeds independently", async () => {
  const ctx = makePrisma({
    seeds: [
      {
        id: "seed-daily-10k",
        kind: "DAILY_10K",
        name: "Daily 10K Sprint",
        targetSteps: 10000,
        durationHours: 24,
        cadence: "DAILY",
        maxParticipants: 100,
        active: true,
      },
      {
        id: "seed-weekly-50k",
        kind: "WEEKLY_50K",
        name: "Weekly 50K Challenge",
        targetSteps: 50000,
        durationHours: 168,
        cadence: "WEEKLY",
        maxParticipants: 100,
        active: true,
      },
    ],
    liveRacesBySeed: { "seed-daily-10k": { id: "existing-daily" } },
  });

  const renew = buildRenewSeededRaces({
    prisma: ctx.prisma,
    now: () => FIXED_NOW,
    logger: { log() {}, error() {} },
  });

  const created = await renew();
  assert.equal(created.length, 1);
  assert.equal(created[0].seedKind, "WEEKLY_50K");
  assert.equal(ctx.created[0].targetSteps, 50000);
});

test("renewSeededRaces is a no-op when no active seeds exist", async () => {
  const ctx = makePrisma({ seeds: [] });

  const renew = buildRenewSeededRaces({
    prisma: ctx.prisma,
    now: () => FIXED_NOW,
    logger: { log() {}, error() {} },
  });

  const created = await renew();
  assert.equal(created.length, 0);
});
