const assert = require("node:assert/strict");
const test = require("node:test");

const {
  filterInactiveUserIds,
  findUsersWithActivitySince,
  inactivityWindowStart,
} = require("../../src/modules/races/services/seededInactivity");

// Inactivity predicate ET-window math (spec §7 test 16). Pure date/tz algebra
// over three bulk queries, so the collaborators are a recording fake: the
// assertions that matter are (a) which UTC instants the queries are bounded by
// and (b) how returned rows bucket into the two ET days.
//
// 2026 US DST: forward Sun Mar 8, back Sun Nov 1.

const OLD = new Date("2020-01-01T00:00:00.000Z");

function fakePrisma({ samples = [], stepRows = [], users = [] } = {}) {
  const calls = {};
  return {
    calls,
    // Recording adapter for the new existence-query transport. Keep the
    // existing date-bound assertions below unchanged; SQL semantics are also
    // exercised through the real cron/enrollment integration suites.
    async $queryRawUnsafe(sql, ids, from, through) {
      if (sql.includes("FROM step_samples")) {
        calls.stepSample = { where: { userId: { in: ids }, periodEnd: { gt: from }, periodStart: { gte: from, lt: through } } };
        return samples.filter(row => ids.includes(row.userId) && row.steps > 0 && row.periodStart >= from && row.periodStart < through);
      }
      if (sql.includes("FROM steps")) {
        calls.step = { where: { userId: { in: ids }, date: { gte: from } } };
        return stepRows.filter(row => ids.includes(row.userId) && row.steps > 0 && (!row.date || row.date >= from));
      }
      throw new Error(`Unexpected activity query: ${sql}`);
    },
    stepSample: {
      async findMany(args) {
        calls.stepSample = args;
        return samples;
      },
    },
    step: {
      async findMany(args) {
        calls.step = args;
        return stepRows;
      },
    },
    user: {
      async findMany(args) {
        calls.user = args;
        return users;
      },
    },
  };
}

function user(id, overrides = {}) {
  return { id, createdAt: OLD, isReviewAccount: false, ...overrides };
}

function sample(userId, startIso, steps) {
  return { userId, periodStart: new Date(startIso), steps };
}

test("D comes from the ET calendar date, not the UTC date (evening-ET instant)", async () => {
  // 2026-03-11T01:30Z is 2026-03-10 21:30 ET — the UTC date is already D+1.
  const now = new Date("2026-03-11T01:30:00.000Z");
  const prisma = fakePrisma({ users: [user("u1")] });

  await filterInactiveUserIds({ userIds: ["u1"], now, prisma });

  // Sample window = [start of D-2 (Mar 8, still EST -> 05:00Z),
  //                  start of D   (Mar 10, EDT -> 04:00Z) )
  assert.equal(
    prisma.calls.stepSample.where.periodEnd.gt.toISOString(),
    "2026-03-08T05:00:00.000Z"
  );
  assert.equal(
    prisma.calls.stepSample.where.periodStart.lt.toISOString(),
    "2026-03-10T04:00:00.000Z"
  );

  // Daily rows: lower bound only, an ET calendar DATE (D-3) as UTC midnight —
  // NOT the 04:00/05:00Z window instant, which would skip the boundary row.
  assert.equal(
    prisma.calls.step.where.date.gte.toISOString(),
    "2026-03-07T00:00:00.000Z"
  );
  assert.equal(prisma.calls.step.where.date.lte, undefined, "no upper bound");
  assert.equal(prisma.calls.step.where.date.lt, undefined, "no upper bound");
});

test("November fall-back windows are DST-exact", async () => {
  const now = new Date("2026-11-03T17:00:00.000Z"); // 12:00 ET on Nov 3
  const prisma = fakePrisma({ users: [user("u1")] });

  await filterInactiveUserIds({ userIds: ["u1"], now, prisma });

  assert.equal(
    prisma.calls.stepSample.where.periodEnd.gt.toISOString(),
    "2026-11-01T04:00:00.000Z" // Nov 1 00:00 EDT
  );
  assert.equal(
    prisma.calls.stepSample.where.periodStart.lt.toISOString(),
    "2026-11-03T05:00:00.000Z" // Nov 3 00:00 EST
  );
  assert.equal(
    prisma.calls.step.where.date.gte.toISOString(),
    "2026-10-31T00:00:00.000Z"
  );
});

test("a user with no data at all on both days is inactive", async () => {
  const now = new Date("2026-03-11T01:30:00.000Z");
  const prisma = fakePrisma({ users: [user("u1")] });
  const inactive = await filterInactiveUserIds({ userIds: ["u1"], now, prisma });
  assert.deepEqual([...inactive], ["u1"]);
});

test("a sample exactly at ET midnight buckets into that day and keeps the user", async () => {
  const now = new Date("2026-03-11T01:30:00.000Z");
  // Mar 9 00:00 EDT = 04:00Z — the first instant of D-1.
  const prisma = fakePrisma({
    users: [user("u1")],
    samples: [sample("u1", "2026-03-09T04:00:00.000Z", 500)],
  });
  const inactive = await filterInactiveUserIds({ userIds: ["u1"], now, prisma });
  assert.equal(inactive.size, 0);
});

test("a sample bucketing to D-3 does not count", async () => {
  const now = new Date("2026-03-11T01:30:00.000Z");
  // One ms before D-2 starts (Mar 8 00:00 EST = 05:00Z) => ET day Mar 7.
  const prisma = fakePrisma({
    users: [user("u1")],
    samples: [sample("u1", "2026-03-08T04:59:59.999Z", 9000)],
  });
  const inactive = await filterInactiveUserIds({ userIds: ["u1"], now, prisma });
  assert.deepEqual([...inactive], ["u1"]);
});

test("samples on either of the two days keep the user (max rule, one day is enough)", async () => {
  const now = new Date("2026-03-11T01:30:00.000Z");
  const onlyD2 = fakePrisma({
    users: [user("u1")],
    samples: [sample("u1", "2026-03-08T15:00:00.000Z", 120)],
  });
  assert.equal(
    (await filterInactiveUserIds({ userIds: ["u1"], now, prisma: onlyD2 })).size,
    0
  );

  const onlyD1 = fakePrisma({
    users: [user("u1")],
    samples: [sample("u1", "2026-03-09T15:00:00.000Z", 120)],
  });
  assert.equal(
    (await filterInactiveUserIds({ userIds: ["u1"], now, prisma: onlyD1 })).size,
    0
  );
});

test("zero-step samples are not activity", async () => {
  const now = new Date("2026-03-11T01:30:00.000Z");
  const prisma = fakePrisma({
    users: [user("u1")],
    samples: [
      sample("u1", "2026-03-08T15:00:00.000Z", 0),
      sample("u1", "2026-03-09T15:00:00.000Z", 0),
    ],
    stepRows: [{ userId: "u1", steps: 0 }],
  });
  const inactive = await filterInactiveUserIds({ userIds: ["u1"], now, prisma });
  assert.deepEqual([...inactive], ["u1"]);
});

test("a daily row alone keeps the user (max rule, samples absent)", async () => {
  const now = new Date("2026-03-11T01:30:00.000Z");
  const prisma = fakePrisma({
    users: [user("u1")],
    stepRows: [{ userId: "u1", steps: 3000 }],
  });
  const inactive = await filterInactiveUserIds({ userIds: ["u1"], now, prisma });
  assert.equal(inactive.size, 0);
});

test("new accounts, race-createdAt accounts and review accounts are exempt", async () => {
  const now = new Date("2026-03-11T01:30:00.000Z");
  const raceCreatedAt = new Date("2026-03-09T12:00:00.000Z");
  const prisma = fakePrisma({
    users: [
      user("old"),
      // createdAt inside the two-day window => no history to judge.
      user("new", { createdAt: new Date("2026-03-08T06:00:00.000Z") }),
      // Born after the race row was minted => signup auto-enrolled into it.
      user("signup", { createdAt: new Date("2026-03-09T18:00:00.000Z") }),
      user("review", { isReviewAccount: true }),
    ],
  });

  const inactive = await filterInactiveUserIds({
    userIds: ["old", "new", "signup", "review"],
    now,
    raceCreatedAt,
    prisma,
  });
  assert.deepEqual([...inactive], ["old"]);
});

test("without raceCreatedAt only the two-day and review exemptions apply", async () => {
  const now = new Date("2026-03-11T01:30:00.000Z");
  const prisma = fakePrisma({
    users: [user("signup", { createdAt: new Date("2026-03-06T18:00:00.000Z") })],
  });
  const inactive = await filterInactiveUserIds({
    userIds: ["signup"],
    now,
    prisma,
  });
  assert.deepEqual([...inactive], ["signup"]);
});

test("an empty user list short-circuits without querying", async () => {
  const prisma = fakePrisma();
  const inactive = await filterInactiveUserIds({
    userIds: [],
    now: new Date(),
    prisma,
  });
  assert.equal(inactive.size, 0);
  assert.deepEqual(prisma.calls, {});
});

// ── Shared window helper (batch 2026-08-10 item 1) ─────────────────────────
// The auto-enroll flip's box-open query bounds on the SAME instant the steps
// predicate does. These assert the helper IS that instant, so the two can never
// disagree about where the window starts.

test("inactivityWindowStart is the ET start of D-2 (DST-exact, spring)", async () => {
  const now = new Date("2026-03-11T01:30:00.000Z"); // 21:30 ET on Mar 10
  assert.equal(
    inactivityWindowStart(now).toISOString(),
    "2026-03-08T05:00:00.000Z" // Mar 8 00:00 EST
  );
});

test("inactivityWindowStart is the ET start of D-2 (DST-exact, fall)", async () => {
  const now = new Date("2026-11-03T17:00:00.000Z"); // 12:00 ET on Nov 3
  assert.equal(
    inactivityWindowStart(now).toISOString(),
    "2026-11-01T04:00:00.000Z" // Nov 1 00:00 EDT
  );
});

test("inactivityWindowStart is exactly the bound the steps predicate queries on", async () => {
  const now = new Date("2026-03-11T01:30:00.000Z");
  const prisma = fakePrisma({ users: [user("u1")] });
  await filterInactiveUserIds({ userIds: ["u1"], now, prisma });
  assert.equal(
    prisma.calls.stepSample.where.periodEnd.gt.toISOString(),
    inactivityWindowStart(now).toISOString(),
    "one window, shared by the steps predicate and the box-open predicate"
  );
});

test("inactivityWindowStart honours an explicit timezone", async () => {
  const now = new Date("2026-03-11T01:30:00.000Z");
  // In UTC the calendar day is already Mar 11, so D-2 is Mar 9 00:00Z.
  assert.equal(
    inactivityWindowStart(now, "UTC").toISOString(),
    "2026-03-09T00:00:00.000Z"
  );
});

test("findUsersWithActivitySince reports race-window walkers only", async () => {
  const since = new Date("2026-03-09T04:00:00.000Z");
  const prisma = fakePrisma({
    samples: [
      sample("walker", "2026-03-09T10:00:00.000Z", 200),
      sample("ghost", "2026-03-09T10:00:00.000Z", 0),
    ],
    stepRows: [{ userId: "rowwalker", steps: 10 }, { userId: "ghost", steps: 0 }],
  });

  const active = await findUsersWithActivitySince({
    userIds: ["walker", "ghost", "rowwalker"],
    since,
    prisma,
  });
  assert.deepEqual([...active].sort(), ["rowwalker", "walker"]);
  assert.equal(
    prisma.calls.stepSample.where.periodStart.gte.toISOString(),
    since.toISOString()
  );
  // The daily-row bound is the ET calendar date of `since`, as UTC midnight.
  assert.equal(
    prisma.calls.step.where.date.gte.toISOString(),
    "2026-03-09T00:00:00.000Z"
  );
});
