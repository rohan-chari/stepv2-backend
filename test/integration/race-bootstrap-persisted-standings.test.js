process.env.PRISMA_QUERY_EVENTS_ENABLED = "true";
delete process.env.REDIS_URL;

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, createTestUser, getSharedServer, prisma, request } = require("./setup");
const { appSettings } = require("../../src/shared/config/appSettings");

let server;
const queries = [];
const headers = {
  "X-App-Version": "99.0.0",
  "X-Client-Features": "characters,powerups3,powerups4,powerups5,remote_assets,race_participants_paging,race_preview",
  "X-Timezone": "UTC",
};

async function fixture(size = 20) {
  const viewer = await createTestUser();
  const race = await prisma.race.create({ data: {
    creatorId: viewer.user.id, name: "Indexed standings", status: "ACTIVE",
    targetSteps: 50000, maxDurationDays: 7, maxParticipants: Math.max(size, 2),
    startedAt: new Date(Date.now() - 3600000), endsAt: new Date(Date.now() + 86400000),
    timezone: "UTC", powerupsEnabled: false, isPublic: true,
  } });
  const users = Array.from({ length: Math.max(0, size - 1) }, () => ({ id: randomUUID(), appleId: randomUUID() }));
  await prisma.user.createMany({ data: users });
  const ids = size ? [viewer.user.id, ...users.map((u) => u.id)] : [];
  await prisma.raceParticipant.createMany({ data: ids.map((userId, i) => ({
    raceId: race.id, userId, status: "ACCEPTED", totalSteps: size - i,
    rawSteps: size - i, nextBoxAtSteps: 5000, joinedAt: new Date(1700000000000 + i),
  })) });
  return { race, viewer, ids };
}

async function progress(f, offset = 0, limit = 15) {
  const response = await request(server.baseUrl, "GET", `/races/${f.race.id}/progress?view=participants-v1&offset=${offset}&limit=${limit}`, {
    token: f.viewer.token, headers,
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.progress;
}

function planNodes(plan) { return [plan, ...(plan.Plans || []).flatMap(planNodes)]; }

describe("indexed persisted standings through HTTP", () => {
  before(async () => {
    server = await getSharedServer();
    prisma.$on("query", (event) => queries.push(event));
  });
  beforeEach(async () => {
    await cleanDatabase();
    await appSettings.setFlag("redisStandingsEnabled", false);
    await appSettings.setFlag("racePreviewEnabled", true);
    queries.length = 0;
  });

  it("keeps exact finish/placement/steps/join/user ordering and global ranks across pages", async () => {
    const f = await fixture(20);
    const tied = f.ids.slice(4, 7).sort();
    for (const userId of tied) await prisma.raceParticipant.update({ where: { raceId_userId: { raceId: f.race.id, userId } }, data: { totalSteps: 100, joinedAt: new Date(1700000000000) } });
    for (const [index, placement] of [[2, 2], [3, 1]]) await prisma.raceParticipant.update({ where: { raceId_userId: { raceId: f.race.id, userId: f.ids[index] } }, data: { finishedAt: new Date(1700001000000), placement, totalSteps: 50000, finishTotalSteps: 50000 } });
    const expected = [f.ids[3], f.ids[2], ...tied, f.ids[0], f.ids[1], ...f.ids.slice(7)];
    const first = await progress(f, 0, 5);
    const second = await progress(f, 5, 15);
    assert.deepEqual([...first.participants, ...second.participants].map((p) => p.userId), expected);
    assert.deepEqual([...first.participants, ...second.participants].map((p) => p.placement), Array.from({ length: 20 }, (_, i) => i + 1));
    assert.equal(second.pagination.total, 20);
  });

  it("keeps the exact total on an out-of-range page with no fake participant", async () => {
    const f = await fixture(20);
    const body = await progress(f, 100, 15);
    assert.equal(body.pagination.total, 20);
    assert.deepEqual(body.participants, []);
    assert.equal(body.pagination.hasMore, false);
  });

  it("returns a real empty page and zero count before and after the last accepted member leaves", async () => {
    const f = await fixture(1);
    await prisma.raceParticipant.updateMany({ where: { raceId: f.race.id }, data: { status: "DECLINED" } });
    // A declined former member cannot preview; use a separate public viewer.
    f.viewer = await createTestUser();
    const empty = await progress(f);
    assert.equal(empty.pagination.total, 0);
    assert.deepEqual(empty.participants, []);
    const neverJoined = await fixture(0);
    const none = await progress(neverJoined);
    assert.equal(none.pagination.total, 0);
    assert.deepEqual(none.participants, []);
  });

  it("orders equal finish placements by finish time, null placements last, and forfeits by persisted steps", async () => {
    const f = await fixture(10);
    for (const [index, placement, finish] of [[1, 1, 2000], [2, 1, 1000], [3, null, 500]]) {
      await prisma.raceParticipant.update({ where: { raceId_userId: { raceId: f.race.id, userId: f.ids[index] } }, data: {
        finishedAt: new Date(1700000000000 + finish), placement, totalSteps: 50000, finishTotalSteps: 50000,
      } });
    }
    await prisma.raceParticipant.update({ where: { raceId_userId: { raceId: f.race.id, userId: f.ids[4] } }, data: { forfeitedAt: new Date(), totalSteps: 200 } });
    const body = await progress(f);
    assert.deepEqual(body.participants.map((p) => p.userId), [f.ids[2], f.ids[1], f.ids[3], f.ids[4], f.ids[0], ...f.ids.slice(5)]);
  });

  it("keeps count and rows correct across membership insert/status/delete/move and rollback", async () => {
    const a = await fixture(20);
    const b = await fixture(2);
    const member = await createTestUser();
    const row = await prisma.raceParticipant.create({ data: { raceId: a.race.id, userId: member.user.id, status: "INVITED" } });
    assert.equal((await progress(a)).pagination.total, 20);
    await prisma.raceParticipant.update({ where: { id: row.id }, data: { status: "ACCEPTED" } });
    assert.equal((await progress(a)).pagination.total, 21);
    await prisma.raceParticipant.update({ where: { id: row.id }, data: { raceId: b.race.id } });
    assert.equal((await progress(a)).pagination.total, 20);
    assert.equal((await progress(b)).pagination.total, 3);
    await assert.rejects(prisma.$transaction(async (tx) => {
      await tx.raceParticipant.update({ where: { id: row.id }, data: { status: "DECLINED" } });
      throw new Error("rollback fixture");
    }), /rollback fixture/);
    assert.equal((await progress(b)).pagination.total, 3);
    await prisma.raceParticipant.update({ where: { id: row.id }, data: { status: "DECLINED" } });
    assert.equal((await progress(b)).pagination.total, 2);
    await prisma.raceParticipant.update({ where: { id: row.id }, data: { status: "ACCEPTED" } });
    await prisma.raceParticipant.delete({ where: { id: row.id } });
    assert.equal((await progress(b)).pagination.total, 2);
  });

  it("does not write/lock count rows for ordinary scoring updates", async () => {
    const f = await fixture(20);
    const before = await prisma.$queryRaw`SELECT xmin::text AS version FROM race_accepted_participant_counts WHERE race_id = ${f.race.id}`;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT race_id FROM race_accepted_participant_counts WHERE race_id = ${f.race.id} FOR UPDATE`;
      await prisma.$transaction(async (other) => {
        await other.$executeRawUnsafe("SET LOCAL lock_timeout = '500ms'");
        await other.raceParticipant.updateMany({ where: { raceId: f.race.id }, data: { totalSteps: 42, rawSteps: 40 } });
      });
    });
    const after = await prisma.$queryRaw`SELECT xmin::text AS version FROM race_accepted_participant_counts WHERE race_id = ${f.race.id}`;
    assert.deepEqual(after, before);
    assert.equal((await progress(f)).pagination.total, 20);
  });

  it("handles concurrent opposite race moves without lost counts or deadlocks", async () => {
    const a = await fixture(20);
    const b = await fixture(20);
    await Promise.all([
      prisma.raceParticipant.updateMany({ where: { raceId: a.race.id, userId: { in: a.ids.slice(1, 6) } }, data: { raceId: b.race.id } }),
      prisma.raceParticipant.updateMany({ where: { raceId: b.race.id, userId: { in: b.ids.slice(1, 4) } }, data: { raceId: a.race.id } }),
    ]);
    assert.equal((await progress(a)).pagination.total, 18);
    assert.equal((await progress(b)).pagination.total, 22);
  });

  it("keeps each HTTP page and count in one committed snapshot during membership changes", async () => {
    const f = await fixture(20);
    const member = await createTestUser();
    const row = await prisma.raceParticipant.create({ data: { raceId: f.race.id, userId: member.user.id, status: "INVITED" } });
    await Promise.all([
      (async () => {
        for (let i = 0; i < 20; i += 1) await prisma.raceParticipant.update({ where: { id: row.id }, data: { status: i % 2 ? "INVITED" : "ACCEPTED" } });
      })(),
      (async () => {
        for (let i = 0; i < 8; i += 1) {
          const body = await progress(f, 0, 50);
          assert.equal(body.participants.length, body.pagination.total);
          assert.ok([20, 21].includes(body.pagination.total));
        }
      })(),
    ]);
  });

  for (const size of [50, 500, 5000]) it(`uses a bounded indexed first page for ${size} accepted participants`, async (t) => {
    const f = await fixture(size);
    // Remove dead tuples from previous fixtures before measuring a plan. A
    // delete-only reset otherwise leaves a 50-row field in a 5000-row heap.
    await prisma.$executeRawUnsafe("VACUUM (ANALYZE) race_participants");
    await prisma.$executeRawUnsafe("REINDEX INDEX race_participants_persisted_standings_idx");
    queries.length = 0;
    const body = await progress(f);
    assert.equal(body.participants.length, 15);
    assert.equal(body.pagination.total, size);
    const observed = queries.find((q) => q.query.includes('AS "computedPlacement"'));
    assert.ok(observed, "must observe the real HTTP persisted page SQL");
    assert.match(observed.query, /race_accepted_participant_counts/);
    const explained = await prisma.$queryRawUnsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${observed.query}`, ...JSON.parse(observed.params));
    const plan = explained[0]["QUERY PLAN"][0].Plan;
    const nodes = planNodes(plan);
    const scan = nodes.find((n) => n["Index Name"] === "race_participants_persisted_standings_idx");
    assert.ok(scan, JSON.stringify(plan));
    assert.equal(scan["Actual Rows"], 15);
    assert.ok(nodes.every((n) => n["Node Type"] !== "Sort" || n["Actual Rows"] <= 15), JSON.stringify(plan));
    assert.ok(nodes.every((n) => n["Node Type"] !== "WindowAgg" || n["Actual Rows"] <= 15), JSON.stringify(plan));
    t.diagnostic(JSON.stringify({ size, scanRows: scan["Actual Rows"], sharedHits: scan["Shared Hit Blocks"], executionMs: explained[0]["QUERY PLAN"][0]["Execution Time"] }));
    if (size === 5000) {
      const deep = await progress(f, 4500, 15);
      assert.deepEqual(deep.participants.map((p) => p.userId), f.ids.slice(4500, 4515));
      assert.deepEqual(deep.participants.map((p) => p.placement), Array.from({ length: 15 }, (_, i) => 4501 + i));
      assert.equal(deep.pagination.total, 5000);
    }
  });

  it("backfills pre-existing memberships atomically and cleans counters on race deletion", async () => {
    // Recreate the pre-migration fixture in this disposable database, then apply
    // the real migration file. Assertions still use the public HTTP route.
    assert.match(new URL(process.env.DATABASE_URL).pathname, /_test$/);
    const f = await fixture(20);
    const empty = await fixture(0);
    await prisma.$executeRawUnsafe("DROP TRIGGER race_accepted_counts_insert ON race_participants");
    await prisma.$executeRawUnsafe("DROP TRIGGER race_accepted_counts_delete ON race_participants");
    await prisma.$executeRawUnsafe("DROP TRIGGER race_accepted_counts_update ON race_participants");
    await prisma.$executeRawUnsafe("DROP FUNCTION maintain_race_accepted_participant_counts()");
    await prisma.$executeRawUnsafe("DROP TABLE race_accepted_participant_counts");
    await prisma.raceParticipant.updateMany({ where: { raceId: f.race.id, userId: { in: f.ids.slice(15) } }, data: { status: "INVITED" } });
    execFileSync("psql", [process.env.DATABASE_URL, "--set=ON_ERROR_STOP=1", "--file", path.join(__dirname, "../../prisma/migrations/20260906010100_accepted_participant_counts/migration.sql")], { stdio: "pipe" });
    assert.equal((await progress(f)).pagination.total, 15);
    assert.equal((await progress(empty)).pagination.total, 0);
    await prisma.raceParticipant.updateMany({ where: { raceId: f.race.id }, data: { status: "ACCEPTED" } });
    assert.equal((await progress(f)).pagination.total, 20);
    await prisma.raceResolutionJobV2.deleteMany({ where: { raceId: f.race.id } });
    await prisma.race.delete({ where: { id: f.race.id } });
    const remaining = await prisma.$queryRaw`SELECT race_id FROM race_accepted_participant_counts WHERE race_id = ${f.race.id}`;
    assert.deepEqual(remaining, []);
  });
});
