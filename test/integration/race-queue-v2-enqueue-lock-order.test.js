// Lock ordering of the batched resolution enqueue.
//
// WHY THIS EXISTS. `enqueueMany` used to be a `for` loop issuing one
// `INSERT … ON CONFLICT (race_id) DO UPDATE` per race, ascending. That loop made
// the ascending lock order self-evident: statement N locked race N, full stop.
// On 2026-08-17 it became ONE statement over a `jsonb_to_recordset` (that upsert
// was 81% of all database busy time — see
// docs/resolution-enqueue-cost-requirements.md), and the ascending order now
// rests on the rows being fed in sorted and on `ORDER BY i."raceId"`. That was
// shipped on evidence — deadlocks went 8 -> 0 in the load test — rather than on
// proof, and §3.1 of that doc flagged it as owed a real test. This is it.
//
// The property under test is NOT "no deadlock happened once". It is the
// mechanism: **this statement acquires its row locks in ascending race_id order,
// whatever order the caller passed the races in.** That is what makes two
// concurrent uploaders sharing a set of races safe.
//
// Method: park a blocker transaction on ONE row, run the enqueue so it collides
// with that row, and probe the OTHER row with `FOR UPDATE NOWAIT` from a third
// session. Whether the probe succeeds tells us which row the enqueue had already
// locked when it stalled — a direct read of acquisition order, not an inference
// from timing.
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");

const { cleanDatabase, prisma } = require("./setup");
const {
  RaceResolutionJobV2,
} = require("../../src/modules/races/models/raceResolutionJobV2");

// Generous, because two of these transactions deliberately sit blocked on a row
// lock for as long as the probe takes. The default 5s interactive timeout would
// abort the very transaction whose state we are inspecting.
const TX = { timeout: 30_000, maxWait: 20_000 };

function createRace(name) {
  return prisma.race.create({
    data: {
      creatorId: null,
      name,
      targetSteps: 0,
      isPublic: true,
      timeBased: true,
      timezone: "America/New_York",
      maxParticipants: 500,
      maxDurationDays: 1,
      status: "PENDING",
    },
    select: { id: true },
  });
}

// Race ids are uuids, so which of a pair sorts low is random per run. Sort with
// the SAME comparator enqueueMany uses so "low" here means what it means there.
async function createRacePairLowHigh() {
  const [r1, r2] = await Promise.all([
    createRace("Lock Order A"),
    createRace("Lock Order B"),
  ]);
  const [low, high] = [r1.id, r2.id].sort((a, b) => String(a).localeCompare(String(b)));
  return { low, high };
}

// Park a transaction on one queue row and keep it parked until the returned
// `release` is called. Resolves once the lock is actually held, so callers never
// race the blocker's own acquisition.
async function holdRowLock(raceId) {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let acquired;
  const held = new Promise((resolve) => {
    acquired = resolve;
  });

  const done = prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      `SELECT 1 FROM race_resolution_jobs_v2 WHERE race_id = $1 FOR UPDATE`,
      raceId
    );
    acquired();
    await gate;
  }, TX);

  await held;
  return {
    release: async () => {
      release();
      await done;
    },
  };
}

// True if the row is free, false if some other session holds it. NOWAIT means
// this probe can never block, so it cannot perturb what it is measuring.
async function isRowLockable(raceId) {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        `SELECT 1 FROM race_resolution_jobs_v2 WHERE race_id = $1 FOR UPDATE NOWAIT`,
        raceId
      );
    }, TX);
    return true;
  } catch (error) {
    const text = `${error?.message || ""} ${error?.meta?.code || ""}`;
    if (/55P03|could not obtain lock|lock_not_available/i.test(text)) return false;
    throw error;
  }
}

// Wait until some session in this database is parked on a lock — i.e. the
// enqueue under test has run as far as it can and stalled. Polling the real
// wait state beats sleeping: no arbitrary constant, and a regression that stops
// blocking fails loudly here instead of silently passing a too-short sleep.
async function waitForBlockedSession(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [{ n }] = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database()
          AND backend_type = 'client backend'
          AND wait_event_type = 'Lock'`
    );
    if (n > 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("no session ever blocked on a row lock");
}

describe("batched resolution enqueue: row-lock acquisition order", () => {
  before(async () => {
    await cleanDatabase();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  // Case 1 and case 2 are the same experiment with the blocker on opposite rows.
  // Either one alone is consistent with more than one acquisition order; only
  // the pair pins it to ascending.
  it("locks the LOW race id first: blocked on the high row, it already holds the low one", async () => {
    const { low, high } = await createRacePairLowHigh();
    await RaceResolutionJobV2.enqueueMany({ raceIds: [low, high], now: new Date() });

    const blocker = await holdRowLock(high);

    // Deliberately passed HIGH first: if the caller's order leaked through, this
    // would take `high` first and never touch `low` before stalling.
    const enqueue = prisma.$transaction(
      (tx) => RaceResolutionJobV2.enqueueMany({ raceIds: [high, low], now: new Date() }, tx),
      TX
    );

    await waitForBlockedSession();
    const lowFree = await isRowLockable(low);

    await blocker.release();
    const rows = await enqueue;

    assert.equal(
      lowFree,
      false,
      "enqueue stalled on the high row without holding the low row — locks are not ascending"
    );
    assert.equal(rows.length, 2, "enqueue should still return a row per race once unblocked");
  });

  it("has NOT yet locked the high race id when it is blocked on the low one", async () => {
    const { low, high } = await createRacePairLowHigh();
    await RaceResolutionJobV2.enqueueMany({ raceIds: [low, high], now: new Date() });

    const blocker = await holdRowLock(low);

    const enqueue = prisma.$transaction(
      (tx) => RaceResolutionJobV2.enqueueMany({ raceIds: [high, low], now: new Date() }, tx),
      TX
    );

    await waitForBlockedSession();
    const highFree = await isRowLockable(high);

    await blocker.release();
    const rows = await enqueue;

    assert.equal(
      highFree,
      true,
      "enqueue reached the high row before the low one — locks are not ascending"
    );
    assert.equal(rows.length, 2);
  });

  // Teeth. Cases 1-2 show the ordering holds; this shows the ordering is what is
  // doing the work, rather than Postgres happening to be well-behaved here. Same
  // statement shape, rows fed DESCENDING with no ORDER BY — and the lock order
  // flips. So row order determines lock order, and the sort + ORDER BY in
  // enqueueMany are load-bearing, not decoration.
  it("control: the same upsert with rows fed descending locks the HIGH id first", async () => {
    const { low, high } = await createRacePairLowHigh();
    await RaceResolutionJobV2.enqueueMany({ raceIds: [low, high], now: new Date() });

    const blocker = await holdRowLock(low);

    const descending = JSON.stringify([{ raceId: high }, { raceId: low }]);
    const control = prisma.$transaction(
      (tx) =>
        tx.$queryRawUnsafe(
          `
          INSERT INTO race_resolution_jobs_v2 (id, race_id, requested_at, updated_at)
          SELECT gen_random_uuid()::text, i."raceId", now(), now()
          FROM jsonb_to_recordset($1::jsonb) AS i("raceId" text)
          ON CONFLICT (race_id) DO UPDATE
            SET generation = race_resolution_jobs_v2.generation + 1
          RETURNING race_id
          `,
          descending
        ),
      TX
    );

    await waitForBlockedSession();
    const highFree = await isRowLockable(high);

    await blocker.release();
    await control;

    assert.equal(
      highFree,
      false,
      "descending input did not lock the high row first — the experiment cannot detect lock order at all, so cases 1-2 prove nothing"
    );
  });

  // The scenario the ordering exists for: many uploaders, overlapping race sets,
  // every caller passing them in a different order. Without a common order this
  // is the classic ABBA deadlock and some of these would die with 40P01.
  it("concurrent enqueues over the same races from every input order: no deadlocks", async () => {
    const races = await Promise.all(
      Array.from({ length: 6 }, (_, i) => createRace(`Lock Order Stress ${i}`))
    );
    const ids = races.map((r) => r.id);
    await RaceResolutionJobV2.enqueueMany({ raceIds: ids, now: new Date() });

    // Fixed rotations rather than random shuffles: every caller sees a different
    // order, and a failure reproduces exactly.
    const orders = ids.map((_, i) => [...ids.slice(i), ...ids.slice(0, i)].reverse());

    const results = await Promise.allSettled(
      orders.map((raceIds) =>
        prisma.$transaction(
          (tx) => RaceResolutionJobV2.enqueueMany({ raceIds, now: new Date() }, tx),
          TX
        )
      )
    );

    const failures = results
      .filter((r) => r.status === "rejected")
      .map((r) => String(r.reason?.message || r.reason));
    assert.deepEqual(failures, [], "concurrent enqueues failed");

    for (const r of results) assert.equal(r.value.length, ids.length);

    // Every enqueue landed: 6 callers each bumping all 6 rows, on top of the
    // seeding enqueue. A lost update would show up as a low generation.
    const rows = await prisma.raceResolutionJobV2.findMany({
      where: { raceId: { in: ids } },
      select: { generation: true },
    });
    assert.equal(rows.length, ids.length);
    for (const row of rows) assert.equal(row.generation, 1 + orders.length);
  });

  // Cases 1-2 pass on the JS sort alone, so they would not notice `ORDER BY`
  // being dropped. It still must not be dropped: it is what keeps the ordering
  // true if the planner ever stops preserving `jsonb_to_recordset` input order.
  // Guard both halves of the mechanism at the source.
  it("keeps both halves of the ordering: caller-order sort and ORDER BY in the SQL", () => {
    const source = require("node:fs").readFileSync(
      require.resolve("../../src/modules/races/models/raceResolutionJobV2.js"),
      "utf8"
    );
    assert.match(source, /ORDER BY i\."raceId"/, "the batched upsert lost its ORDER BY");
    assert.match(
      source,
      /\.sort\(\(a, b\) => String\(a\)\.localeCompare\(String\(b\)\)\)/,
      "enqueueMany stopped sorting its race ids"
    );
  });
});
