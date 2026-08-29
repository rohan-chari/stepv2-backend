const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");
const { before, beforeEach, describe, it } = require("node:test");
const IORedis = require("ioredis");

const {
  cleanDatabase,
  createTestUser,
  getSharedServer,
  prisma,
  request,
} = require("./setup");
const { startTestRedis } = require("./redisTestServer");

const execFileAsync = promisify(execFile);
const SCRIPT = path.join(__dirname, "../../scripts/repair-duplicate-live-leeches.js");
const APPLY_CONFIRMATION = "EXPIRE_DUPLICATE_LIVE_LEECHES_V1";
const POWERUP_HEADERS = {
  "X-Client-Features": "characters,powerups2,powerups3,powerups4,powerups5",
};

let server;

function assertTestDatabase() {
  const name = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, "");
  assert.equal(name, "steps-tracker-integration_test");
}

async function runRepair(args = [], env = {}) {
  assertTestDatabase();
  const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT, ...args], {
    cwd: path.join(__dirname, "../.."),
    env: { ...process.env, ...env },
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(stderr, "");
  return JSON.parse(stdout);
}

async function createRace(users, overrides = {}) {
  const now = Date.now();
  const race = await prisma.race.create({
    data: {
      creatorId: users[0].user.id,
      name: `Duplicate Leech repair ${now}`,
      targetSteps: 100_000,
      status: "ACTIVE",
      startedAt: new Date(now - 3 * 60 * 60 * 1000),
      endsAt: new Date(now + 3 * 60 * 60 * 1000),
      timezone: "UTC",
      powerupsEnabled: true,
      powerupStepInterval: 5_000,
      ...overrides,
    },
  });
  await prisma.raceParticipant.createMany({
    data: users.map(({ user }) => ({
      raceId: race.id,
      userId: user.id,
      status: "ACCEPTED",
      joinedAt: race.startedAt,
    })),
  });
  return race;
}

async function participant(raceId, userId) {
  return prisma.raceParticipant.findUnique({
    where: { raceId_userId: { raceId, userId } },
  });
}

async function createEffect({
  race,
  source,
  target,
  type = "LEECH",
  status = "ACTIVE",
  startsAt,
  expiresAt = new Date(Date.now() + 60 * 60 * 1000),
}) {
  const sourceParticipant = await participant(race.id, source.user.id);
  const targetParticipant = await participant(race.id, target.user.id);
  const powerup = await prisma.racePowerup.create({
    data: {
      raceId: race.id,
      participantId: sourceParticipant.id,
      userId: source.user.id,
      type,
      rarity: "COMMON",
      status: "USED",
    },
  });
  return prisma.raceActiveEffect.create({
    data: {
      raceId: race.id,
      targetParticipantId: targetParticipant.id,
      targetUserId: target.user.id,
      sourceUserId: source.user.id,
      powerupId: powerup.id,
      type,
      status,
      startsAt,
      expiresAt,
      metadata: {
        ratio: 2,
        scoringVersion: 2,
        impactBoundaryV1: {
          version: 1,
          responsibleActorUserId: source.user.id,
          originalExpiresAt: expiresAt.toISOString(),
          endReason: "NATURAL",
        },
      },
    },
  });
}

async function seedDuplicateFixture({ settlementRisk = false } = {}) {
  const first = await createTestUser({ displayName: "Repair First" });
  const second = await createTestUser({ displayName: "Repair Second" });
  const third = await createTestUser({ displayName: "Repair Third" });
  const victim = await createTestUser({ displayName: "Repair Victim" });
  const otherVictim = await createTestUser({ displayName: "Repair Other" });
  const now = Date.now();
  const race = await createRace(
    [first, second, third, victim, otherVictim],
    settlementRisk ? { endsAt: new Date(now - 1000) } : {},
  );
  const kept = await createEffect({
    race,
    source: first,
    target: victim,
    startsAt: new Date(now - 30 * 60 * 1000),
  });
  const duplicateA = await createEffect({
    race,
    source: second,
    target: victim,
    startsAt: new Date(now - 20 * 60 * 1000),
  });
  const duplicateB = await createEffect({
    race,
    source: third,
    target: victim,
    startsAt: new Date(now - 10 * 60 * 1000),
  });
  const singleLeech = await createEffect({
    race,
    source: first,
    target: otherVictim,
    startsAt: new Date(now - 5 * 60 * 1000),
  });
  const unrelated = await createEffect({
    race,
    source: second,
    target: victim,
    type: "RUNNERS_HIGH",
    startsAt: new Date(now - 5 * 60 * 1000),
  });
  await prisma.stepSample.createMany({
    data: [
      {
        userId: victim.user.id,
        periodStart: new Date(now - 90 * 60 * 1000),
        periodEnd: new Date(now - 80 * 60 * 1000),
        steps: 5_000,
      },
      {
        userId: second.user.id,
        periodStart: new Date(now - 19 * 60 * 1000),
        periodEnd: new Date(now - 18 * 60 * 1000),
        steps: 1_000,
      },
      {
        userId: third.user.id,
        periodStart: new Date(now - 9 * 60 * 1000),
        periodEnd: new Date(now - 8 * 60 * 1000),
        steps: 1_000,
      },
    ],
  });
  return {
    race,
    first,
    second,
    third,
    victim,
    otherVictim,
    kept,
    duplicateA,
    duplicateB,
    singleLeech,
    unrelated,
  };
}

describe("duplicate live Leech repair CLI", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    assertTestDatabase();
    await cleanDatabase();
  });

  it("dry-run is mutation-free and reports the deterministic keep/expire set", async () => {
    const fixture = await seedDuplicateFixture();
    const report = await runRepair();

    assert.equal(report.mode, "dry-run");
    assert.equal(report.duplicateGroupCount, 1);
    assert.equal(report.affectedEffectCount, 2);
    assert.match(report.reportDigest, /^[a-f0-9]{64}$/);
    assert.deepEqual(report.groups[0].keepEffectId, fixture.kept.id);
    assert.deepEqual(
      report.groups[0].expireEffectIds,
      [fixture.duplicateA.id, fixture.duplicateB.id],
    );
    assert.equal(
      await prisma.raceActiveEffect.count({
        where: { id: { in: [fixture.duplicateA.id, fixture.duplicateB.id] }, status: "ACTIVE" },
      }),
      2,
      "dry-run must not mutate rows",
    );
  });

  it("apply expires only later duplicate live Leeches, finalizes boundaries, invalidates/enqueues, and is idempotent", async () => {
    const fixture = await seedDuplicateFixture();
    const dryRun = await runRepair();
    const applied = await runRepair([
      "--apply",
      `--confirm=${APPLY_CONFIRMATION}`,
      `--report-digest=${dryRun.reportDigest}`,
    ]);

    assert.equal(applied.mode, "apply");
    assert.equal(applied.affectedEffectCount, 2);
    assert.equal(applied.postAuditDuplicateGroupCount, 0);
    const all = await prisma.raceActiveEffect.findMany({
      where: {
        id: {
          in: [
            fixture.kept.id,
            fixture.duplicateA.id,
            fixture.duplicateB.id,
            fixture.singleLeech.id,
            fixture.unrelated.id,
          ],
        },
      },
    });
    const byId = new Map(all.map((row) => [row.id, row]));
    assert.equal(byId.get(fixture.kept.id).status, "ACTIVE");
    assert.equal(byId.get(fixture.singleLeech.id).status, "ACTIVE");
    assert.equal(byId.get(fixture.unrelated.id).status, "ACTIVE");
    for (const id of [fixture.duplicateA.id, fixture.duplicateB.id]) {
      const row = byId.get(id);
      assert.equal(row.status, "EXPIRED");
      assert.ok(new Date(row.expiresAt) <= new Date(applied.cutoff));
      assert.equal(
        row.metadata.impactBoundaryV1.endReason,
        "DUPLICATE_LEECH_REPAIR",
      );
      assert.equal(
        new Date(row.metadata.impactBoundaryV1.endedAt).toISOString(),
        new Date(applied.cutoff).toISOString(),
      );
    }
    const boundaryEvents = await prisma.raceImpactEvent.findMany({
      where: {
        raceId: fixture.race.id,
        sourceKind: "ACTIVE_EFFECT",
        sourceId: { in: [fixture.duplicateA.id, fixture.duplicateB.id] },
      },
      orderBy: [{ sourceId: "asc" }, { recipientUserId: "asc" }],
    });
    assert.ok(
      boundaryEvents.some((event) => event.sourceId === fixture.duplicateA.id),
      "the first discarded duplicate has a durable resolved boundary",
    );
    assert.ok(
      boundaryEvents.some((event) => event.sourceId === fixture.duplicateB.id),
      "the second discarded duplicate has a durable resolved boundary",
    );
    assert.ok(
      boundaryEvents.every(
        (event) => new Date(event.resolvedAt).toISOString() === new Date(applied.cutoff).toISOString(),
      ),
    );
    const job = await prisma.raceResolutionJobV2.findUnique({
      where: { raceId: fixture.race.id },
    });
    assert.ok(job && Number(job.generation) >= 1, "a fresh C0 generation is enqueued");

    const postAudit = await runRepair();
    assert.equal(postAudit.duplicateGroupCount, 0);
    const secondApply = await runRepair([
      "--apply",
      `--confirm=${APPLY_CONFIRMATION}`,
      `--report-digest=${postAudit.reportDigest}`,
    ]);
    assert.equal(secondApply.affectedEffectCount, 0);
    assert.equal(secondApply.postAuditDuplicateGroupCount, 0);
  });

  it("refuses apply without both the explicit confirmation and reviewed digest", async () => {
    await seedDuplicateFixture();
    await assert.rejects(
      () => runRepair(["--apply"]),
      (error) => {
        assert.match(error.stderr, /apply refused/i);
        return true;
      },
    );
  });

  it("serializes repair against a real-HTTP Leech use and leaves one live effect", async () => {
    const fixture = await seedDuplicateFixture();
    const challengerItem = await prisma.racePowerup.create({
      data: {
        raceId: fixture.race.id,
        participantId: (await participant(fixture.race.id, fixture.otherVictim.user.id)).id,
        userId: fixture.otherVictim.user.id,
        type: "LEECH",
        rarity: "COMMON",
        status: "HELD",
      },
    });
    const dryRun = await runRepair();

    const [applied, useResponse] = await Promise.all([
      runRepair([
        "--apply",
        `--confirm=${APPLY_CONFIRMATION}`,
        `--report-digest=${dryRun.reportDigest}`,
      ]),
      request(
        server.baseUrl,
        "POST",
        `/races/${fixture.race.id}/powerups/${challengerItem.id}/use`,
        {
          token: fixture.otherVictim.token,
          headers: POWERUP_HEADERS,
          body: { targetUserId: fixture.victim.user.id },
        },
      ),
    ]);

    assert.equal(applied.postAuditDuplicateGroupCount, 0);
    assert.equal(useResponse.status, 409, await useResponse.clone().text());
    assert.equal((await useResponse.json()).code, "LEECH_TARGET_ALREADY_ACTIVE");
    assert.equal(
      await prisma.raceActiveEffect.count({
        where: {
          raceId: fixture.race.id,
          targetUserId: fixture.victim.user.id,
          type: "LEECH",
          status: "ACTIVE",
          expiresAt: { gt: new Date() },
        },
      }),
      1,
    );
  });

  it("invalidates the touched race's Redis progress snapshot after commit", async (t) => {
    const live = await startTestRedis();
    if (!live) return t.skip("no local test Redis available");
    t.after(() => live.close());
    const probe = new IORedis(live.url);
    t.after(() => probe.quit());
    await probe.flushdb();
    const fixture = await seedDuplicateFixture();
    const key = `t:v1:race:progress:${fixture.race.id}`;
    await probe.set(key, JSON.stringify({ stale: true }));
    const dryRun = await runRepair([], {
      REDIS_URL: live.url,
      CACHE_ENV_PREFIX: "t:",
    });

    await runRepair(
      [
        "--apply",
        `--confirm=${APPLY_CONFIRMATION}`,
        `--report-digest=${dryRun.reportDigest}`,
      ],
      { REDIS_URL: live.url, CACHE_ENV_PREFIX: "t:" },
    );
    assert.equal(await probe.get(key), null);
  });

  it("defers a race that is concurrently settlement-eligible", async () => {
    const fixture = await seedDuplicateFixture({ settlementRisk: true });
    const report = await runRepair();
    assert.equal(report.duplicateGroupCount, 0);
    assert.equal(report.deferredRaceCount, 1);
    assert.deepEqual(report.deferredRaces, [
      {
        raceId: fixture.race.id,
        reason: "SETTLEMENT_RISK",
      },
    ]);
    const applied = await runRepair([
      "--apply",
      `--confirm=${APPLY_CONFIRMATION}`,
      `--report-digest=${report.reportDigest}`,
    ]);
    assert.equal(applied.affectedEffectCount, 0);
    assert.equal(
      await prisma.raceActiveEffect.count({
        where: {
          raceId: fixture.race.id,
          type: "LEECH",
          status: "ACTIVE",
          expiresAt: { gt: new Date(0) },
        },
      }),
      4,
    );
  });

  it("reports a race that becomes settlement-risky after audit", async () => {
    const fixture = await seedDuplicateFixture();
    const dryRun = await runRepair();
    let applyProcess;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM races WHERE id = ${fixture.race.id} FOR UPDATE
      `;
      applyProcess = execFileAsync(
        process.execPath,
        [
          SCRIPT,
          "--apply",
          `--confirm=${APPLY_CONFIRMATION}`,
          `--report-digest=${dryRun.reportDigest}`,
        ],
        {
          cwd: path.join(__dirname, "../.."),
          env: process.env,
          maxBuffer: 2 * 1024 * 1024,
        },
      );

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const waiting = await prisma.$queryRaw`
          SELECT 1
          FROM pg_stat_activity
          WHERE wait_event_type = 'Lock'
            AND query LIKE '%SELECT id FROM races WHERE id =%FOR UPDATE%'
          LIMIT 1
        `;
        if (waiting.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const waiting = await prisma.$queryRaw`
        SELECT 1
        FROM pg_stat_activity
        WHERE wait_event_type = 'Lock'
          AND query LIKE '%SELECT id FROM races WHERE id =%FOR UPDATE%'
        LIMIT 1
      `;
      assert.equal(waiting.length, 1, "repair CLI must reach the held race lock");
      await tx.race.update({
        where: { id: fixture.race.id },
        data: { endsAt: new Date(Date.now() - 1000) },
      });
    });
    const { stdout, stderr } = await applyProcess;
    assert.equal(stderr, "");
    const applied = JSON.parse(stdout);

    assert.equal(applied.affectedEffectCount, 0);
    assert.deepEqual(applied.deferredRaces, [
      { raceId: fixture.race.id, reason: "SETTLEMENT_RISK" },
    ]);
    assert.equal(applied.deferredRaceCount, 1);
  });
});
