process.env.PRISMA_QUERY_EVENTS_ENABLED = "true";
const assert = require("node:assert/strict");
const { test, after } = require("node:test");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { randomUUID } = require("node:crypto");
const { Client } = require("pg");
const target = new URL(process.env.DATABASE_URL);
assert.ok(["localhost", "127.0.0.1"].includes(target.hostname));
assert.match(target.pathname, /_test$/);
const {
  prisma,
  cleanDatabase,
  createTestUser,
  getSharedServer,
  request,
} = require("./setup");
let server;
after(async () => {
  if (server) await server.close();
  await prisma.$disconnect();
});
const isClaim = (m) =>
  m.query?.includes("WITH candidate AS") &&
  m.query.includes("UPDATE race_resolution_jobs_v2 j");
function worker() {
  const messages = [];
  let logs = "";
  const child = spawn(
    process.execPath,
    [
      "--require",
      "./test/integration/fixtures/query-efficiency/observe-fingerprint.cjs",
      "src/index.js",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "test",
        STEPS_PROCESS_ROLE: "resolution",
        NODE_APP_INSTANCE: "0",
        PORT: "0",
        CRON_START_DELAY_MS: "0",
        RACE_QUEUE_V2_QUIET_PERIOD_MS: "0",
        ASYNC_RACE_RESOLUTION_CONCURRENCY: "3",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  child.on("message", (m) => messages.push({ ...m, receivedAt: Date.now() }));
  child.stdout.on("data", (b) => (logs += b));
  child.stderr.on("data", (b) => (logs += b));
  return {
    messages,
    child,
    logs: () => logs,
    async stop() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise((r) => child.once("exit", r));
      }
    },
  };
}
async function waitFor(predicate, timeout = 10000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await predicate()) return;
    await delay(50);
  }
  assert.fail("condition did not become true before deadline");
}
async function makeRace(isTeamRace = false) {
  const user = await createTestUser({ timezone: "UTC" }),
    id = randomUUID(),
    now = new Date();
  await prisma.race.create({
    data: {
      id,
      name: "Claim efficiency",
      creatorId: user.user.id,
      status: "ACTIVE",
      targetSteps: 1000000,
      isTeamRace,
      teamSize: isTeamRace ? 2 : null,
      powerupsEnabled: true,
      startedAt: new Date(+now - 3600000),
      endsAt: new Date(+now + 86400000),
    },
  });
  const participant = await prisma.raceParticipant.create({
    data: {
      raceId: id,
      userId: user.user.id,
      status: "ACCEPTED",
      team: isTeamRace ? "TEAM_A" : null,
      joinedAt: new Date(+now - 3600000),
      buyInStatus: "NONE",
    },
  });
  return { id, user, participant };
}
async function upload(race, steps = 100) {
  server ||= await getSharedServer();
  const now = Date.now();
  const res = await request(server.baseUrl, "POST", "/steps/samples", {
    token: race.user.token,
    headers: { "X-Timezone": "UTC" },
    body: {
      samples: [
        {
          periodStart: new Date(now - 1800000).toISOString(),
          periodEnd: new Date(now - 900000).toISOString(),
          steps,
        },
      ],
    },
  });
  assert.equal(res.status, 200);
  return prisma.raceResolutionJobV2.findUnique({ where: { raceId: race.id } });
}
async function committed(race, generation) {
  const row = await prisma.raceResolutionJobV2.findUnique({
    where: { raceId: race.id },
  });
  return row?.committedGeneration >= generation;
}

const fs = require("node:fs");
const crypto = require("node:crypto");
const legacySql = fs.readFileSync(
  require("node:path").join(
    __dirname,
    "fixtures/query-efficiency/fingerprint-legacy.sql",
  ),
  "utf8",
);
const canonical = (value) =>
  Array.isArray(value)
    ? "[" + value.map(canonical).join(",") + "]"
    : value && typeof value === "object"
      ? "{" +
        Object.keys(value)
          .sort()
          .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
          .join(",") +
        "}"
      : JSON.stringify(value);
for (const team of [false, true])
  test(
    `typed fingerprint preserves payload/HTTP results and versions its digest: team=${team}`,
    { timeout: 45000 },
    async () => {
      await cleanDatabase();
      const race = await makeRace(team);
      const other = await createTestUser({
        timezone: "UTC",
        displayName: "Other 🦫",
      });
      await prisma.raceParticipant.create({
        data: {
          raceId: race.id,
          userId: other.user.id,
          status: "ACCEPTED",
          team: team ? "TEAM_B" : null,
          joinedAt: new Date(Date.now() - 3600000),
          buyInStatus: "NONE",
          maxBonusSteps: 123,
          nextBoxAtSteps: 456,
        },
      });
      const job = await upload(race);
      const [legacy] = await prisma.$queryRawUnsafe(legacySql, race.id);
      const w = worker();
      try {
        await waitFor(() =>
          w.messages.some((m) => m.kind === "fingerprint" && m.value),
        );
        const first = w.messages.find(
          (m) => m.kind === "fingerprint" && m.value,
        );
        assert.deepEqual(first.value.race, legacy.race);
        assert.deepEqual(first.value.participants, legacy.participants);
        const v = first.value;
        const payload = {
          schema: 5,
          race: legacy.race,
          participants: legacy.participants.map(({ user, ...p }) => p),
          inputs: v.inputs,
          effects: v.activeEffects,
          expiredScoringEffects: v.expiredScoringEffects,
          historicalScoringEffects: v.historicalScoringEffects,
          events: v.globalEvents,
          balanceConfigVersion:
            first.balanceConfigVersion == null
              ? "code-default"
              : String(first.balanceConfigVersion),
        };
        assert.equal(
          v.digest,
          crypto.createHash("sha256").update(canonical(payload)).digest("hex"),
          "same immutable facts use the current versioned digest",
        );
        assert.notEqual(
          v.digest,
          crypto.createHash("sha256").update(canonical({ ...payload, schema: 4 })).digest("hex"),
          "old artifact fingerprints must mismatch after the ordering version change",
        );
        await waitFor(() => committed(race, job.generation));
        const typed = w.messages.filter(
          (m) =>
            m.query?.includes('AS "r_id"') && m.query.includes('AS "p_id"'),
        );
        assert.ok(typed.length, "real worker must request typed roster rows");
        for (const { query } of typed) {
          const rosterStart = query.indexOf('SELECT race.id AS "r_id"');
          assert.ok(rosterStart >= 0, "typed roster SELECT must be present");
          const proofPrefix = query.slice(0, rosterStart);
          assert.doesNotMatch(proofPrefix, /race_participants|\busers\b/,
            "proof CTE must not hide roster JSON assembly");
          assert.doesNotMatch(query.slice(rosterStart), /jsonb_build_object|jsonb_agg/,
            "roster JSON assembly leaves PostgreSQL");
        }
        const read = async () => {
          const r = await request(
            server.baseUrl,
            "GET",
            `/races/${race.id}/progress`,
            { token: race.user.token, headers: { "X-Timezone": "UTC" } },
          );
          assert.equal(r.status, 200);
          return (await r.json()).progress.participants.find(
            (p) => p.userId === race.user.user.id,
          );
        };
        assert.equal((await read()).totalSteps, 100);
        const renamed = await request(
          server.baseUrl,
          "PUT",
          "/auth/me/display-name",
          { token: race.user.token, body: { displayName: "Fresh_Name" } },
        );
        assert.equal(renamed.status, 200);
        const next = await upload(race, 200);
        await waitFor(() => committed(race, next.generation));
        const latest = await read();
        assert.equal(latest.totalSteps, 200);
        assert.equal(latest.displayName, "Fresh_Name");
        if (team)
          assert.ok(
            w.messages.some(
              (m) => m.kind === "fingerprint" && !m.includePresentation,
            ),
            "team FULL fence still uses scoring-only mode",
          );
      } finally {
        await w.stop();
      }
    },
  );
