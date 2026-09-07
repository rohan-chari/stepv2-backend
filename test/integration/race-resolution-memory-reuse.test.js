process.env.PRISMA_QUERY_EVENTS_ENABLED = "true";
process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS = "0";
process.env.RACE_RESOLVE_DEBOUNCE_MS = "0";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { before, beforeEach, it } = require("node:test");
const { prisma, cleanDatabase, createTestUser, getSharedServer, request } = require("./setup");
const { buildRaceResolutionWorkerV2 } = require("../../src/modules/races/jobs/raceResolutionQueueV2");
let baseUrl, queries;
prisma.$on("query", event => queries?.push(event.query));
before(async () => { baseUrl = (await getSharedServer()).baseUrl; });
beforeEach(cleanDatabase);
const sampleReads = qs => qs.filter(q => q.includes("WITH requested AS MATERIALIZED") && q.includes("JOIN step_samples sample"));
async function sync(account, samples) {
  const response = await request(baseUrl, "POST", "/steps/sync-v2", {
    token: account.token, headers: { "Idempotency-Key": randomUUID(), "X-Timezone": "UTC" },
    body: { date: samples[0].periodStart.slice(0, 10), steps: samples.reduce((n, s) => n + s.steps, 0), samples },
  });
  assert.equal(response.status, 202, JSON.stringify(await response.json()));
}
async function fixture() {
  const account = await createTestUser();
  // Fixed closed history avoids tests changing behavior near midnight.
  const day = new Date(); day.setUTCDate(day.getUTCDate() - 1); day.setUTCHours(0, 0, 0, 0);
  const races = [];
  for (const hour of [2, 1, 3]) {
    const startedAt = new Date(+day + hour * 3600000);
    const race = await prisma.race.create({ data: {
      creatorId: account.user.id, name: `Memory reuse ${hour}`, status: "ACTIVE", targetSteps: 100000,
      powerupsEnabled: true, timezone: "UTC", startedAt, endsAt: new Date(Date.now() + 86400000),
    } });
    await prisma.raceParticipant.create({ data: { raceId: race.id, userId: account.user.id,
      status: "ACCEPTED", joinedAt: startedAt } });
    races.push(race);
  }
  const samples = [1, 2, 3].map(hour => ({ periodStart: new Date(+day + hour * 3600000).toISOString(),
    periodEnd: new Date(+day + (hour + 1) * 3600000).toISOString(), steps: 100 }));
  await sync(account, samples);
  return { account, races, samples };
}
async function totals(f, expected) {
  for (let i = 0; i < f.races.length; i++) {
    const saved = await prisma.raceParticipant.findFirstOrThrow({
      where: { raceId: f.races[i].id, userId: f.account.user.id },
    });
    assert.equal(saved.totalSteps, expected[i], "worker must persist the right result before any HTTP read");
    const r = await request(baseUrl, "GET", `/races/${f.races[i].id}/progress`, { token: f.account.token });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.progress.participants.find(p => p.userId === f.account.user.id).totalSteps, expected[i]);
  }
}
it("one HTTP sync shares history across races with different start/join times without mixing their totals", async () => {
  const f = await fixture(); const captured = []; queries = captured;
  try {
    const worker = buildRaceResolutionWorkerV2({ bootAt: 0 });
    for (const race of f.races) await worker.processRace({ raceId: race.id });
  } finally { queries = null; }
  assert.equal(sampleReads(captured).length, 1, "compatible queued races must load the user's history once");
  await totals(f, [200, 300, 100]);
});
it("a later HTTP sync invalidates shared history for every affected race", async () => {
  const f = await fixture(); const worker = buildRaceResolutionWorkerV2({ bootAt: 0 });
  for (const race of f.races) await worker.processRace({ raceId: race.id });
  await sync(f.account, f.samples.map(s => ({ ...s, steps: 150 })));
  const captured = []; queries = captured;
  try { for (const race of f.races) await worker.processRace({ raceId: race.id }); }
  finally { queries = null; }
  assert.equal(sampleReads(captured).length, 1, "new version reloads once, then shares only the new inputs");
  await totals(f, [300, 450, 150]);
});
it("mixed changed/unchanged HTTP sample batches do not rewrite unchanged source rows", async () => {
  const f = await fixture();
  const before = await prisma.$queryRawUnsafe('SELECT period_start::text, xmin::text FROM step_samples WHERE user_id=$1 ORDER BY period_start', f.account.user.id);
  await sync(f.account, f.samples.map((s, i) => ({ ...s, steps: i === 1 ? 150 : s.steps })));
  const after = await prisma.$queryRawUnsafe('SELECT period_start::text, xmin::text, steps FROM step_samples WHERE user_id=$1 ORDER BY period_start', f.account.user.id);
  assert.equal(after[0].xmin, before[0].xmin, "unchanged first sample must keep its physical row version");
  assert.notEqual(after[1].xmin, before[1].xmin, "changed sample must be persisted");
  assert.equal(after[1].steps, 150);
  assert.equal(after[2].xmin, before[2].xmin, "unchanged last sample must keep its physical row version");
  const worker = buildRaceResolutionWorkerV2({ bootAt: 0 });
  for (const race of f.races) await worker.processRace({ raceId: race.id });
  await totals(f, [250, 350, 100]);
});
it("concurrent queued races share an in-flight history load", async () => {
  const f = await fixture(); const captured = []; queries = captured;
  try {
    const worker = buildRaceResolutionWorkerV2({ bootAt: 0 });
    await Promise.all(f.races.map(race => worker.processRace({ raceId: race.id })));
  } finally { queries = null; }
  assert.equal(sampleReads(captured).length, 1, "parallel jobs must join a compatible pending history read");
  await totals(f, [200, 300, 100]);
});
it("a protected planning snapshot supplies effects without re-reading them for scoring", async () => {
  const f = await fixture(); const captured = []; queries = captured;
  try { await buildRaceResolutionWorkerV2({ bootAt: 0 }).processRace({ raceId: f.races[0].id }); }
  finally { queries = null; }
  const duplicateEffectReads = captured.filter(q => q.startsWith('SELECT "public"."race_active_effects"') &&
    q.includes('"race_id" IN') && q.includes('"status" = CAST'));
  assert.equal(duplicateEffectReads.length, 0, "scoring must reuse the protected effect input instead of loading it again");
  assert.ok(captured.filter(q => q.includes('FROM race_active_effects') && q.includes('updated_at')).length >= 2,
    "reuse must retain an independent commit-time effect fence");
});
it("metadata-only updates persist while untouched samples and scores remain unchanged", async () => {
  const f = await fixture();
  const before = await prisma.$queryRawUnsafe('SELECT period_start::text,xmin::text FROM step_samples WHERE user_id=$1 ORDER BY period_start', f.account.user.id);
  await sync(f.account, f.samples.map((s, i) => i === 1 ? { ...s, sourceName: "Health", metadata: { hkWasUserEntered: false } } : s));
  const after = await prisma.$queryRawUnsafe('SELECT xmin::text,source_name,metadata FROM step_samples WHERE user_id=$1 ORDER BY period_start', f.account.user.id);
  assert.equal(after[0].xmin, before[0].xmin);
  assert.notEqual(after[1].xmin, before[1].xmin);
  assert.equal(after[1].source_name, "Health");
  assert.deepEqual(after[1].metadata, { hkWasUserEntered: false });
  assert.equal(after[2].xmin, before[2].xmin);
  // Null is also a real change, rather than an equality comparison that SQL
  // silently treats as unknown.
  await sync(f.account, f.samples);
  const cleared = await prisma.$queryRawUnsafe('SELECT source_name,metadata FROM step_samples WHERE user_id=$1 ORDER BY period_start', f.account.user.id);
  assert.equal(cleared[1].source_name, null);
  assert.equal(cleared[1].metadata, null);
  const worker = buildRaceResolutionWorkerV2({ bootAt: 0 });
  for (const race of f.races) await worker.processRace({ raceId: race.id });
  await totals(f, [200, 300, 100]);
});
it("the protected race and roster snapshot replaces the separate scoring hydration reads", async () => {
  const f = await fixture(); const logs = [];
  await buildRaceResolutionWorkerV2({ bootAt: 0,
    logger: { log: value => { try { logs.push(JSON.parse(value)); } catch {} }, warn() {}, error: console.error },
  }).processRace({ raceId: f.races[0].id });
  const completed = logs.find(x => x.event === "race_resolution_v2" && x.computePhaseQueryCount);
  assert.ok(completed);
  assert.equal(completed.computePhaseQueryCount.raceLoad, 0, "already protected race/roster must not be reloaded during compute");
  const p = await prisma.raceParticipant.findFirstOrThrow({ where: { raceId: f.races[0].id } });
  assert.equal(p.totalSteps, 200);
});
it("a new upload between cached computation and commit rejects stale totals across queued races", async () => {
  const f = await fixture();
  await buildRaceResolutionWorkerV2({ bootAt: 0 }).processRace({ raceId: f.races[0].id });
  const logs = []; let uploaded = false;
  const worker = buildRaceResolutionWorkerV2({ bootAt: 0,
    logger: { log: value => { try { logs.push(JSON.parse(value)); } catch {} }, warn() {}, error: console.error },
    beforeWriteTransaction: async () => {
      if (uploaded) return;
      uploaded = true;
      await sync(f.account, f.samples.map(s => ({ ...s, steps: 175 })));
    },
  });
  await worker.processRace({ raceId: f.races[1].id });
  assert.ok(uploaded);
  assert.ok(logs.some(x => (x.sourceInputFenceRejections || 0) + (x.closureFenceRejections || 0) > 0),
    "the cached old version must be rejected at the write fence");
  for (const race of f.races) await worker.processRace({ raceId: race.id });
  await totals(f, [350, 525, 175]);
});
it("a race needing older history cannot use a narrower cached window", async () => {
  const f = await fixture();
  const oldStart = new Date(new Date(f.samples[0].periodStart).getTime() - 86400000);
  await prisma.race.update({ where: { id: f.races[1].id }, data: { startedAt: oldStart } });
  await prisma.raceParticipant.updateMany({ where: { raceId: f.races[1].id }, data: { joinedAt: oldStart } });
  await sync(f.account, [{ periodStart: oldStart.toISOString(), periodEnd: new Date(+oldStart + 3600000).toISOString(), steps: 90 }]);
  const worker = buildRaceResolutionWorkerV2({ bootAt: 0 });
  await worker.processRace({ raceId: f.races[0].id });
  const captured = []; queries = captured;
  try { await worker.processRace({ raceId: f.races[1].id }); }
  finally { queries = null; }
  assert.equal(sampleReads(captured).length, 1, "uncovered older history must be fetched, not assumed empty");
  await worker.processRace({ raceId: f.races[2].id });
  await totals(f, [200, 390, 100]);
});
it("overlap replacement still removes obsolete samples while leaving unrelated rows untouched", async () => {
  const f = await fixture();
  const before = await prisma.$queryRawUnsafe('SELECT xmin::text FROM step_samples WHERE user_id=$1 ORDER BY period_start', f.account.user.id);
  const start = new Date(f.samples[0].periodStart).getTime();
  // Finer replacement with a 1 ms, zero-credit overhang exercises the real
  // overlap-delete path. A coarser replacement is intentionally rejected.
  await sync(f.account, [
    { periodStart: new Date(start + 1).toISOString(), periodEnd: new Date(start + 1800000).toISOString(), steps: 100 },
    { periodStart: new Date(start + 1800000).toISOString(), periodEnd: f.samples[0].periodEnd, steps: 50 },
    ...f.samples.slice(1),
  ]);
  const rows = await prisma.$queryRawUnsafe('SELECT period_start::text,period_end::text,steps,xmin::text FROM step_samples WHERE user_id=$1 ORDER BY period_start', f.account.user.id);
  assert.equal(rows.length, 4, "old coarse row must be replaced by two finer rows");
  assert.equal(new Date(rows[0].period_start + "Z").getTime(), start + 1);
  assert.equal(rows[0].steps + rows[1].steps, 150);
  assert.equal(rows[2].xmin, before[1].xmin);
  assert.equal(rows[3].xmin, before[2].xmin);
  const worker = buildRaceResolutionWorkerV2({ bootAt: 0 });
  for (const race of f.races) await worker.processRace({ raceId: race.id });
  await totals(f, [200, 350, 100]);
});
it("historical effect changes reject a cached closure before it can persist stale scoring", async () => {
  const f = await fixture(); const race = f.races[0];
  const participant = await prisma.raceParticipant.findFirstOrThrow({ where: { raceId: race.id } });
  const powerup = await prisma.racePowerup.create({ data: { raceId: race.id, participantId: participant.id,
    userId: f.account.user.id, type: "RUNNERS_HIGH", rarity: "RARE", status: "USED", earnedAtSteps: 0 } });
  const effect = await prisma.raceActiveEffect.create({ data: { raceId: race.id, targetParticipantId: participant.id,
    targetUserId: f.account.user.id, sourceUserId: f.account.user.id, powerupId: powerup.id,
    type: "RUNNERS_HIGH", status: "EXPIRED", startsAt: new Date(f.samples[1].periodStart),
    expiresAt: new Date(f.samples[1].periodEnd), metadata: { multiplier: 2 } } });
  let changed = false; const logs = [];
  await buildRaceResolutionWorkerV2({ bootAt: 0,
    logger: { log: value => { try { logs.push(JSON.parse(value)); } catch {} }, warn() {}, error: console.error },
    beforeWriteTransaction: async () => {
      if (changed) return;
      changed = true;
      await prisma.raceActiveEffect.update({ where: { id: effect.id }, data: { expiresAt: effect.startsAt } });
    },
  }).processRace({ raceId: race.id });
  assert.ok(logs.some(x => x.closureFenceRejections > 0), "historical effect inputs must participate in the closure fence");
  const saved = await prisma.raceParticipant.findUniqueOrThrow({ where: { id: participant.id } });
  assert.equal(saved.totalSteps, 200, "truncated historical bonus must not survive a stale cached calculation");
  const response = await request(baseUrl, "GET", `/races/${race.id}/progress`, { token: f.account.token });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).progress.participants.find(p => p.userId === f.account.user.id).totalSteps, 200);
});
it("mixed sample batches send only changed rows to PostgreSQL, not redundant conflict checks", async () => {
  const f = await fixture(); const captured = []; queries = captured;
  try { await sync(f.account, f.samples.map((s, i) => ({ ...s, steps: i === 1 ? 125 : s.steps }))); }
  finally { queries = null; }
  const writes = captured.filter(q => q.includes("INSERT INTO step_samples") && q.includes("WITH deleted AS"));
  assert.equal(writes.length, 1);
  assert.equal((writes[0].match(/gen_random_uuid\(\)/g) || []).length, 1,
    "only the changed source row should be submitted for insertion/upsert");
  const worker = buildRaceResolutionWorkerV2({ bootAt: 0 });
  for (const race of f.races) await worker.processRace({ raceId: race.id });
  await totals(f, [225, 325, 100]);
});
it("unchanged retained samples still remove an obsolete overlapping row without inserts", async () => {
  const f = await fixture();
  const before = await prisma.$queryRawUnsafe('SELECT id,xmin::text FROM step_samples WHERE user_id=$1 ORDER BY period_start', f.account.user.id);
  // Legacy redundant coarse history: all its credit is zero, so the finer
  // public upload may remove it even with a one-millisecond leading overhang.
  const obsolete = await prisma.stepSample.create({ data: {
    userId: f.account.user.id, periodStart: new Date(+new Date(f.samples[0].periodStart) - 1),
    periodEnd: new Date(f.samples[1].periodEnd), steps: 0,
  } });
  const captured = []; queries = captured;
  try { await sync(f.account, f.samples); } finally { queries = null; }
  assert.equal(captured.filter(q => q.includes("INSERT INTO step_samples")).length, 0);
  assert.equal(await prisma.stepSample.count({ where: { id: obsolete.id } }), 0);
  const after = await prisma.$queryRawUnsafe('SELECT id,xmin::text FROM step_samples WHERE user_id=$1 ORDER BY period_start', f.account.user.id);
  assert.deepEqual(after, before, "cleanup must preserve every retained physical row");
  const worker = buildRaceResolutionWorkerV2({ bootAt: 0 });
  for (const race of f.races) await worker.processRace({ raceId: race.id });
  await totals(f, [200, 300, 100]);
});
