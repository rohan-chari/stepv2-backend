#!/usr/bin/env node
"use strict";

// Disposable-local diagnostic. Run this SAME file against each checkout using
// --root. No application code, query result or scheduling function is mocked.
// One invocation = one fixed offered trace; repeat every trace >=3 times.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const args = Object.fromEntries(process.argv.slice(2).map((x) => {
  const at = x.indexOf("=");
  assert.ok(x.startsWith("--") && at > 2, "arguments use --key=value");
  return [x.slice(2, at), x.slice(at + 1)];
}));
const root = path.resolve(args.root || process.cwd());
const target = new URL(process.env.DATABASE_URL);
const redisTarget = new URL(process.env.REDIS_URL);
assert.ok(["localhost", "127.0.0.1"].includes(target.hostname));
assert.match(target.pathname, /^\/bara_event_matched_\w+_test$/);
assert.ok(["localhost", "127.0.0.1"].includes(redisTarget.hostname));
assert.equal(redisTarget.port, "6396", "reserved disposable benchmark Redis only");
assert.equal(process.env.NODE_ENV, "test");
assert.ok(["baseline", "candidate"].includes(args.variant));
const membershipCount = Number(args.memberships);
assert.ok([1, 3, 5].includes(membershipCount));
assert.ok(["same", "disjoint"].includes(args.topology));
assert.ok(args.output, "--output is required");
process.chdir(root);
process.env.PRISMA_QUERY_EVENTS_ENABLED = "true";
const { prisma, cleanDatabase, createTestUser, getSharedServer, request } = require(path.join(root, "test/integration/setup"));
const Redis = require(path.join(root, "node_modules/ioredis"));
const redis = new Redis(process.env.REDIS_URL);
const headers = {
  "X-App-Version": "2.3.13", "X-Timezone": "UTC",
  "X-Client-Features": "characters,remote_assets,remote_asset_preferred,race_leave,race_participants_paging,api_payload_compact_v1,powerups4,powerups5,team_races,seeded_race_buckets,privacy_safe_display_ranks,recurring_races_v1,impact_summaries,impact_summary_expiry_v1",
};
const trace = { users: 6, memberships: membershipCount, topology: args.topology,
  arrivalIntervalMs: 100, pollScheduleMs: [750, 1500, 3000, 5000], samples: 24,
  actions: ["warm intake and worker drain (excluded)", "event start cohort", "full Home open", "unchanged fresh-key intake", "changed intake", "resolution poll", "Home/races/profile catch-up", "all membership jobs drain and HTTP progress proves visible totals", "event end cohort and final drain"],
  acceptance: "Same accepted/completed actions, identical durable outcomes; candidate p95/p99 must not exceed baseline maximum plus baseline repeat-to-repeat range. Report all repetitions, no best-run selection.",
};
let phase = "setup", server, child, workerLogs = "";
const sql = [], requests = [], phases = [], observerQueries = [];
const evidence = { variant: args.variant, revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), trace, startedAt: new Date().toISOString(), sql, requests, phases, observerQueries,
  limitations: ["Prisma events include SQL control commands, not all physical wire round trips.", "Query elapsed includes waits; it is not query CPU or isolated planning time.", "Six-user local traces establish bounded comparative evidence, not production capacity or 70% CPU idle.", "Worker startup and a separate idle window are reported separately; periodic worker work remains included in measured traffic windows.", "completionMs measures backend-ready explicit-navigation visibility after observer drain; automaticCatchupHttpMs separately records successful-poll catch-up HTTP completion and is null for SUPERSEDED.", "Observer drain SELECTs are counted separately; they still consume local DB resources and are not application SQL."] };
prisma.$on("query", (e) => sql.push({ process: "http/cron", phase, at: Date.now(), durationMs: e.duration, query: e.query }));
async function timedPhase(name, fn) {
  phase = name;
  const start = Date.now(), sqlStart = sql.length;
  const value = await fn();
  phases.push({ name, elapsedMs: Date.now() - start, sqlEvents: sql.length - sqlStart });
  return value;
}
async function http(user, method, route, body) {
  const start = Date.now();
  const res = await request(server.baseUrl, method, route, { token: user.token,
    headers: { ...headers, ...(method === "POST" ? { "Idempotency-Key": randomUUID() } : {}) }, body });
  const result = await res.json();
  requests.push({ phase, user: user.index, method, route, status: res.status, elapsedMs: Date.now() - start });
  assert.ok(res.status >= 200 && res.status < 300, `${route}: ${res.status} ${JSON.stringify(result)}`);
  return result;
}
async function waitFor(fn, label, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw Error("worker exited: " + workerLogs.slice(-5000));
    if (await fn()) return;
    await delay(100);
  }
  throw Error(`Timed out: ${label}; worker tail: ${workerLogs.slice(-5000)}`);
}
async function drain(raceIds) {
  // The observer connection is separate so measurement does not count harness
  // polling as application SQL. No test-only worker shortcut is used.
  const { Client } = require(path.join(root, "node_modules/pg"));
  const observer = new Client({ connectionString: process.env.DATABASE_URL });
  await observer.connect();
  try {
    let finalJobs = [];
    await waitFor(async () => {
      const observationStarted = Date.now();
      const { rows: [counts] } = await observer.query(`SELECT
        (SELECT count(*) FROM race_resolution_jobs_v2 WHERE race_id=ANY($1::text[]) AND state <> 'succeeded') AS jobs,
        (SELECT count(*) FROM race_resolution_post_tasks WHERE race_id=ANY($1::text[]) AND state IN ('queued','running')) AS tasks,
        (SELECT count(*) FROM race_placement_transition_jobs WHERE race_id=ANY($1::text[]) AND state IN ('queued','running','retry')) AS placements,
        (SELECT json_agg(json_build_object('jobId',id,'raceId',race_id,'generation',generation,'committedGeneration',committed_generation,'state',state)) FROM race_resolution_jobs_v2 WHERE race_id=ANY($1::text[])) AS details`, [raceIds]);
      observerQueries.push({ phase, memberships: raceIds.length, elapsedMs: Date.now() - observationStarted });
      finalJobs = counts.details || [];
      return finalJobs.length === raceIds.length && finalJobs.every((j) => j.committedGeneration >= j.generation) && Number(counts.jobs) === 0 && Number(counts.tasks) === 0 && Number(counts.placements) === 0;
    }, "all core, post-task and placement work drained");
    return finalJobs;
  } finally { await observer.end(); }
}
async function stopWorker() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}
function summarize() {
  const summaries = {};
  for (const entry of sql) {
    const key = `${entry.phase}/${entry.process}`;
    const out = summaries[key] ||= { events: 0, elapsedMs: 0, leadingSql: {}, sourceReads: 0 };
    out.events++;
    out.elapsedMs += Number(entry.durationMs || 0);
    const kind = entry.query.replace(/^\s*(\/\*[\s\S]*?\*\/\s*)*/, "").match(/^(\w+)/)?.[1]?.toUpperCase() || "OTHER";
    out.leadingSql[kind] = (out.leadingSql[kind] || 0) + 1;
    if (/\bSELECT\b/i.test(entry.query) && /\bFROM\s+(?:"public"\.)?"?step_samples\b/i.test(entry.query)) out.sourceReads++;
  }
  evidence.sqlSummary = summaries;
  evidence.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
  fs.writeFileSync(args.output, JSON.stringify(evidence, null, 2));
  fs.writeFileSync(args.output + ".worker.log", workerLogs);
}
async function main() {
  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
  await cleanDatabase();
  await redis.flushdb();
  server = await getSharedServer();
  const now = Date.now();
  const users = [];
  for (let i = 0; i < trace.users; i++) users.push({ ...await createTestUser({ displayName: `Matched user ${i}`, timezone: "UTC" }), index: i, races: [] });
  const raceIds = [];
  for (let i = 0; i < (args.topology === "same" ? 1 : users.length); i++) {
    const group = args.topology === "same" ? users : [users[i]];
    for (let j = 0; j < membershipCount; j++) {
      const race = await prisma.race.create({ data: { name: `Matched race ${i}/${j}`, creatorId: group[0].user.id, status: "ACTIVE", timezone: "UTC", targetSteps: 1000000, maxParticipants: 100, startedAt: new Date(now - 86400000), endsAt: new Date(now + 86400000), powerupsEnabled: true } });
      raceIds.push(race.id);
      await prisma.raceParticipant.createMany({ data: group.map((u) => ({ raceId: race.id, userId: u.user.id, status: "ACCEPTED", joinedAt: new Date(now - 86400000), buyInStatus: "NONE" })) });
      for (const user of group) user.races.push(race.id);
    }
  }
  const samples = Array.from({ length: trace.samples }, (_, i) => ({ periodStart: new Date(now - (25 - i) * 300000).toISOString(), periodEnd: new Date(now - (24 - i) * 300000).toISOString(), steps: 10 }));
  const uploadBody = { date: new Date(now).toISOString().slice(0, 10), steps: 240, samples };
  const observerPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bara-matched-observer-")), "observer.cjs");
  fs.writeFileSync(observerPath, `const {prisma}=require(${JSON.stringify(path.join(root, "src/db"))});prisma.$on('query',e=>{if(process.send)process.send({query:e.query,durationMs:e.duration})});`);
  await timedPhase("worker-startup-and-warmup", async () => {
    child = spawn(process.execPath, ["--require", observerPath, "src/index.js"], { cwd: root, env: { ...process.env, STEPS_PROCESS_ROLE: "resolution", NODE_APP_INSTANCE: "0", PORT: "0", CRON_START_DELAY_MS: "0", RACE_QUEUE_V2_QUIET_PERIOD_MS: "0", ASYNC_RACE_RESOLUTION_CONCURRENCY: "3" }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    child.on("message", (m) => { if (m.query) sql.push({ ...m, process: "worker", phase, at: Date.now() }); });
    child.stdout.on("data", (b) => { workerLogs += b; fs.appendFileSync(args.output + ".live-worker.log", b); });
    child.stderr.on("data", (b) => { workerLogs += b; fs.appendFileSync(args.output + ".live-worker.log", b); });
    for (const user of users) await http(user, "POST", "/steps/sync-v2", uploadBody);
    await drain(raceIds);
  });
  await timedPhase("warm-worker-idle", () => delay(2000));
  phase = "event-fixture-setup";
  const event = await prisma.globalStepEvent.create({ data: { startsAt: new Date(now - 1800000), endsAt: new Date(now + 1800000), scheduleMode: "LOCAL_ENTITLEMENTS", summaryAttributionVersion: 2, multiplier: 2 } });
  await prisma.globalStepEventEntitlement.createMany({ data: users.map((u) => ({ eventId: event.id, userId: u.user.id, timezone: "UTC", localDate: uploadBody.date, startsAt: event.startsAt, endsAt: event.endsAt })) });
  await timedPhase("event-start-cohort", async () => {
    const { buildGlobalEventBoundaryDrain } = require(path.join(root, "src/modules/steps/jobs/globalEventBoundaryDrain"));
    evidence.eventStart = await buildGlobalEventBoundaryDrain().runUntilIdle();
    assert.equal(evidence.eventStart.failures, 0);
    await drain(raceIds);
  });
  const sessionResults = [];
  await timedPhase("fixed-arrival-event-sessions", async () => {
    const begin = Date.now();
    await Promise.all(users.map(async (user, i) => {
      await delay(Math.max(0, begin + i * trace.arrivalIntervalMs - Date.now()));
      const start = Date.now();
      await http(user, "GET", "/home/race-card?view=shell-v1&homeActiveRaces=1&localDate=" + uploadBody.date);
      await http(user, "POST", "/steps/sync-v2", uploadBody);
      const changed = { ...uploadBody, steps: 241, samples: samples.map((s, n) => n === 23 ? { ...s, steps: 11 } : s) };
      const result = await http(user, "POST", "/steps/sync-v2", changed);
      const job = result.raceResolution;
      assert.ok(job?.jobId, "changed upload must enqueue race resolution");
      let state = null;
      for (const pollDelay of trace.pollScheduleMs) {
        await delay(pollDelay);
        const status = await http(user, "GET", `/steps/race-resolution/${job.jobId}?generation=${job.generation}`);
        state = status.raceResolution?.state;
        if (["SUCCEEDED", "FAILED", "SUPERSEDED"].includes(state)) break;
      }
      assert.ok(["SUCCEEDED", "SUPERSEDED"].includes(state), "poll must reach a successful or superseded terminal state");
      // A superseded receipt belongs to a newer queue generation. Preserve the
      // real app's full-navigation behavior and prove that newer work below.
      const view = args.variant === "candidate" && state === "SUCCEEDED" ? "sync-refresh-v1" : "shell-v1";
      const [home] = await Promise.all([
        http(user, "GET", `/home/race-card?view=${view}&homeActiveRaces=1&localDate=${uploadBody.date}`),
        http(user, "GET", "/races?view=compact"), http(user, "GET", "/auth/me"),
      ]);
      if (view === "sync-refresh-v1") assert.equal(home.contract, "home-sync-refresh-v1");
      const automaticCatchupHttpMs = state === "SUCCEEDED" ? Date.now() - start : null;
      const drainedJobs = await drain(user.races);
      const reportedJob = drainedJobs.find((j) => j.jobId === job.jobId);
      assert.ok(reportedJob && reportedJob.committedGeneration >= job.generation, "accepted receipt must be durably covered by a succeeded generation");
      const expectedTotal = changed.samples.reduce((sum, sample) => sum + sample.steps *
        (new Date(sample.periodStart) >= event.startsAt ? event.multiplier : 1), 0);
      const visible = [];
      for (const raceId of user.races) {
        const progress = await http(user, "GET", `/races/${raceId}/progress`);
        const participant = progress.progress?.participants?.find((p) => p.userId === user.user.id);
        assert.ok(participant, "HTTP progress must include the authenticated participant");
        assert.equal(participant.totalSteps, expectedTotal, "client-visible total must reflect the changed upload and event");
        visible.push({ membership: visible.length, totalSteps: participant.totalSteps, expectedTotal });
      }
      sessionResults.push({ user: i, completionMs: Date.now() - start, pollState: state, catchupView: view, automaticCatchupHttpMs, visible, jobs: drainedJobs.map((j) => ({ membership: user.races.indexOf(j.raceId), generation: j.generation, committedGeneration: j.committedGeneration, state: j.state })), receiptCovered: true });
    }));
    await drain(raceIds);
  });
  evidence.sessions = sessionResults.sort((a, b) => a.user - b.user);
  // End the local fixture at a fixed relative sample boundary. This fixture
  // mutation is excluded; the actual end job and downstream work are measured.
  phase = "event-end-fixture-setup";
  await prisma.globalStepEventEntitlement.updateMany({ where: { eventId: event.id }, data: { endsAt: new Date(now - 60000) } });
  await prisma.globalStepEvent.update({ where: { id: event.id }, data: { endsAt: new Date(now - 60000) } });
  await timedPhase("event-end-cohort", async () => {
    const { buildGlobalEventEndDrain } = require(path.join(root, "src/modules/steps/jobs/globalEventEndDrain"));
    const job = buildGlobalEventEndDrain();
    evidence.eventEnd = [];
    await waitFor(async () => {
      const result = await job.run(); evidence.eventEnd.push(result);
      return !result.more && result.failures === 0;
    }, "event end cohort");
    await drain(raceIds);
  });
  phase = "final-outcome-inspection";
  evidence.outcomes = [];
  for (const user of users) {
    const participants = await prisma.raceParticipant.findMany({ where: { userId: user.user.id }, select: { totalSteps: true, rawSteps: true, boxProgressSteps: true, status: true, placement: true, payoutCoins: true }, orderBy: { raceId: "asc" } });
    const entitlement = await prisma.globalStepEventEntitlement.findUnique({ where: { eventId_userId: { eventId: event.id, userId: user.user.id } } });
    const source = await prisma.userScoringInputVersion.findUnique({ where: { userId: user.user.id }, select: { generation: true, sourceQueueSemanticsGeneration: true } });
    const summaryWork = await prisma.globalEventSummaryWork.findUnique({ where: { eventId_userId: { eventId: event.id, userId: user.user.id } }, select: { status: true, requiredRaceCount: true, finalRaceCount: true, sourceScoringInputGeneration: true, captureCompletedAt: true } });
    const coins = (await prisma.user.findUnique({ where: { id: user.user.id }, select: { coins: true } })).coins;
    evidence.outcomes.push({ user: user.index, coins, source: source && { generation: String(source.generation), sourceQueueSemanticsGeneration: String(source.sourceQueueSemanticsGeneration) }, summaryWork: summaryWork && { ...summaryWork, sourceScoringInputGeneration: summaryWork.sourceScoringInputGeneration == null ? null : String(summaryWork.sourceScoringInputGeneration), captureCompletedAt: !!summaryWork.captureCompletedAt }, participants: participants.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), endProcessed: !!entitlement.endProcessedAt, startOutcome: entitlement.startOutcome });
    assert.ok(entitlement.endProcessedAt, "end must durably complete");
  }
  evidence.success = true;
  console.log(JSON.stringify({ success: true, variant: args.variant, trace, phases, sessions: evidence.sessions }));
}
main().catch((error) => { evidence.success = false; evidence.error = error.stack; console.error(error); process.exitCode = 1; }).finally(async () => {
  await stopWorker();
  summarize();
  if (server) await server.close();
  await prisma.$disconnect();
  await redis.quit();
  process.exit(process.exitCode || 0);
});
