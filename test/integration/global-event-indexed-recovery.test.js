process.env.PRISMA_QUERY_EVENTS_ENABLED = "true";
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { setTimeout: delay } = require("node:timers/promises");
const { before, beforeEach, it } = require("node:test");
const { cleanDatabase, createTestUser, getSharedServer, prisma, request } = require("./setup");
const { buildGlobalEventSummaryV1Tick, buildGlobalEventSummaryV2Tick } = require("../../src/modules/steps/jobs/globalEventSummary");
const { buildGlobalEventEntitlementEventReconciler } = require("../../src/modules/steps/jobs/globalEventEntitlementEventReconciler");
let server;
let observed = null;
prisma.$on("query", event => observed?.push(event.query));
before(async () => { server = await getSharedServer(); });
beforeEach(cleanDatabase);
async function capture(run) {
  const queries = [];
  observed = queries;
  try { await run(); } finally { observed = null; }
  assert.ok(queries.length, "SQL observation must be active");
  return queries;
}
async function fixture(version = 2, future = false) {
  const account = await createTestUser();
  const current = new Date();
  const startsAt = new Date(current.getTime() + (future ? 3600000 : -1800000));
  const endsAt = new Date(startsAt.getTime() + 900000);
  const event = await prisma.globalStepEvent.create({ data: {
    startsAt, endsAt, multiplier: 2, summaryAttributionVersion: version,
    scheduleMode: future ? "LOCAL_ENTITLEMENTS" : "LEGACY_GLOBAL",
  } });
  const entitlement = await prisma.globalStepEventEntitlement.create({ data: {
    eventId: event.id, userId: account.user.id, timezone: "UTC",
    localDate: startsAt.toISOString().slice(0, 10), startsAt, endsAt,
    startOutcome: "ACTIVATED_ON_TIME", startProcessedAt: startsAt,
  } });
  return { account, event, entitlement, current };
}
const workKey = f => ({ eventId_userId: { eventId: f.event.id, userId: f.account.user.id } });
async function readyGeneration(current) {
  const capabilities = ["SCHEDULED_EVENT_CONSUMER", "UNIVERSAL_C0_LOCK_ORDER", "TOKEN_LIFECYCLE", "TARGET_AWARE_SENDER", "RECONCILER_OWNERSHIP"];
  await prisma.globalStepEventCronOwner.createMany({ data: ["http:0", "http:1", "resolution:0", "cron:0"].map(id => ({
    ownerId: `indexed-${id}`, logicalOwnerId: id, bootId: "indexed", role: id.split(":")[0],
    generation: 2, capabilities, heartbeatAt: current, expiresAt: new Date(current.getTime() + 300000),
  })) });
  await prisma.globalStepEventGenerationState.create({ data: { id: 1, readySince: new Date(current.getTime() - 100000) } });
}

it("v2 recovery repairs missing work and deleted receipts without a historical entitlement scan", async () => {
  const f = await fixture();
  const tick = buildGlobalEventSummaryV2Tick({ prisma });
  const queries = await capture(() => tick({ recovery: true }));
  let work = await prisma.globalEventSummaryWork.findUniqueOrThrow({ where: workKey(f) });
  const response = await request(server.baseUrl, "GET", `/home/global-event-summary-work/${work.id}`, {
    token: f.account.token, headers: { "X-Client-Features": "impact_summaries,impact_summary_expiry_v1" },
  });
  assert.equal(response.status, 200);
  await prisma.globalEventSummaryWork.delete({ where: { id: work.id } });
  await tick({ recovery: true });
  work = await prisma.globalEventSummaryWork.findUniqueOrThrow({ where: workKey(f) });
  assert.equal(work.eventId, f.event.id);
  assert.equal(queries.filter(q => /SELECT e\.id\s+FROM global_step_event_entitlements e/.test(q)).length, 0,
    "recovery must select bounded outstanding work, not scan all ended entitlements");
  assert.ok(queries.some(q => q.includes("global_event_recovery_candidates")));
});

it("v1 recovery preserves exactly-once summaries while selecting indexed outstanding groups", async () => {
  const f = await fixture(1);
  const race = await prisma.race.create({ data: { creatorId: f.account.user.id, name: "Recovery", status: "ACTIVE", targetSteps: 10000 } });
  await prisma.globalEventRaceImpact.create({ data: { eventId: f.event.id, raceId: race.id,
    userId: f.account.user.id, status: "FINAL", attributionVersion: 1, deltaSteps: 75 } });
  const tick = buildGlobalEventSummaryV1Tick({ prisma });
  const queries = await capture(tick);
  assert.equal((await prisma.globalEventUserSummary.findUniqueOrThrow({ where: workKey(f) })).extraRaceSteps, 75);
  assert.equal((await tick()).candidatesSelected, 0);
  assert.ok(queries.some(q => q.includes("global_event_recovery_candidates")),
    "v1 completion discovery must start from outstanding groups");
});

it("entitlement recovery repairs exact revisions and deleted outbox receipts without historical scans", async () => {
  const f = await fixture(2, true);
  await readyGeneration(f.current);
  const tick = buildGlobalEventEntitlementEventReconciler({ prisma });
  const queries = await capture(tick);
  const key = revision => `GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1:${f.entitlement.id}:${revision}`;
  const original = await prisma.domainEventOutbox.findUniqueOrThrow({ where: { eventKey: key(0) } });
  const receipt = await prisma.domainEventReceipt.findUniqueOrThrow({ where: { eventKey: key(0) } });
  await prisma.domainEventOutbox.delete({ where: { eventKey: key(0) } });
  assert.equal((await tick()).published, 1);
  assert.equal((await prisma.domainEventOutbox.findUniqueOrThrow({ where: { eventKey: key(0) } })).id, original.id,
    "repair must restore the receipt's immutable event identity");
  assert.equal((await prisma.domainEventReceipt.findUniqueOrThrow({ where: { eventKey: key(0) } })).envelopeDigest, receipt.envelopeDigest);
  await prisma.globalStepEventEntitlement.update({ where: { id: f.entitlement.id }, data: { scheduleRevision: 1 } });
  assert.equal((await tick()).published, 1);
  assert.ok(await prisma.domainEventOutbox.findUnique({ where: { eventKey: key(1) } }));
  assert.equal((await tick()).published, 0);
  assert.equal(queries.filter(q => /SELECT entitlement\.id\s+FROM global_step_event_entitlements entitlement\s+WHERE entitlement\.ends_at/.test(q)).length, 0,
    "outbox recovery must select indexed gaps, not rescan all future entitlements");
  assert.ok(queries.some(q => q.includes("global_event_recovery_candidates")));
});

it("a terminal scheduled-event receipt prevents resurrection after outbox retention", async () => {
  const f = await fixture(2, true);
  await readyGeneration(f.current);
  const tick = buildGlobalEventEntitlementEventReconciler({ prisma });
  assert.equal((await tick()).published, 1);
  const eventKey = `GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1:${f.entitlement.id}:0`;
  await prisma.domainEventReceipt.update({ where: { eventKey }, data: { terminalStatus: "COMPLETED", completedAt: new Date() } });
  await prisma.domainEventOutbox.delete({ where: { eventKey } });
  assert.equal((await tick()).published, 0);
  assert.equal(await prisma.domainEventOutbox.findUnique({ where: { eventKey } }), null);
});

it("outbox repair fails closed if the immutable payload cannot be reconstructed", async () => {
  const f = await fixture(2, true);
  await readyGeneration(f.current);
  const tick = buildGlobalEventEntitlementEventReconciler({ prisma });
  assert.equal((await tick()).published, 1);
  const eventKey = `GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1:${f.entitlement.id}:0`;
  const receipt = await prisma.domainEventReceipt.findUniqueOrThrow({ where: { eventKey } });
  await prisma.domainEventOutbox.delete({ where: { eventKey } });
  await prisma.globalStepEvent.update({ where: { id: f.event.id }, data: { multiplier: 3 } });
  await assert.rejects(tick(), { code: "DOMAIN_EVENT_RECEIPT_COLLISION" });
  assert.equal(await prisma.domainEventOutbox.findUnique({ where: { eventKey } }), null);
  assert.equal((await prisma.domainEventReceipt.findUniqueOrThrow({ where: { eventKey } })).envelopeDigest, receipt.envelopeDigest);
});

it("bootstrap advances a bounded durable cursor and stops revisiting completed history", async () => {
  const fixtures = [];
  for (let i = 0; i < 8; i++) fixtures.push(await fixture());
  // Simulate pre-migration source rows, without modifying any source facts.
  await prisma.$executeRawUnsafe("DELETE FROM global_event_recovery_candidates");
  const page = async () => (await prisma.$queryRawUnsafe("SELECT global_event_recovery_seed_page(3) AS n"))[0].n;
  assert.equal(await page(), 3);
  const first = await prisma.$queryRawUnsafe("SELECT last_id,complete FROM global_event_recovery_seed WHERE source='entitlements'");
  assert.equal(first[0].complete, false);
  assert.ok(first[0].last_id);
  assert.equal(await page(), 3);
  assert.equal(await page(), 2);
  assert.equal(await page(), 0);
  assert.equal((await prisma.$queryRawUnsafe("SELECT count(*)::int AS n FROM global_event_recovery_candidates WHERE kind='SUMMARY_V2'"))[0].n, 8);
  const tick = buildGlobalEventSummaryV2Tick({ prisma });
  await tick({ recovery: true });
  for (const f of fixtures) assert.ok(await prisma.globalEventSummaryWork.findUnique({ where: workKey(f) }));
  assert.equal(await page(), 0, "completed bootstrap must not restart a historical sweep");
});

it("rolled-back source writes cannot leave phantom repair work", async () => {
  const f = await fixture();
  const before = await prisma.$queryRawUnsafe("SELECT id::text FROM global_event_recovery_candidates WHERE event_id=$1 ORDER BY id", f.event.id);
  await assert.rejects(prisma.$transaction(async tx => {
    await tx.globalStepEventEntitlement.delete({ where: { id: f.entitlement.id } });
    assert.equal(await tx.globalStepEventEntitlement.findUnique({ where: { id: f.entitlement.id } }), null);
    throw new Error("rollback source deletion");
  }), /rollback source deletion/);
  assert.deepEqual(await prisma.$queryRawUnsafe("SELECT id::text FROM global_event_recovery_candidates WHERE event_id=$1 ORDER BY id", f.event.id), before,
    "rollback must preserve the exact pre-transaction signal identities");
  await buildGlobalEventSummaryV2Tick({ prisma })({ recovery: true });
  assert.ok(await prisma.globalEventSummaryWork.findUnique({ where: workKey(f) }));
});

it("a parent event edit queues a bounded refresh and respects its new end time", async () => {
  const f = await fixture(1);
  const race = await prisma.race.create({ data: { creatorId: f.account.user.id, name: "Parent edit", status: "ACTIVE", targetSteps: 10000 } });
  await prisma.globalEventRaceImpact.create({ data: { eventId: f.event.id, raceId: race.id,
    userId: f.account.user.id, status: "FINAL", attributionVersion: 1, deltaSteps: 25 } });
  await prisma.globalStepEvent.update({ where: { id: f.event.id }, data: { endsAt: new Date(Date.now() + 3600000) } });
  assert.equal((await prisma.$queryRawUnsafe("SELECT count(*)::int AS n FROM global_event_recovery_event_refresh"))[0].n, 1);
  assert.equal((await buildGlobalEventSummaryV1Tick({ prisma })()).candidatesSelected, 0);
  assert.equal(await prisma.globalEventUserSummary.count(), 0);
  await prisma.globalStepEvent.update({ where: { id: f.event.id }, data: { endsAt: f.event.endsAt } });
  assert.equal((await buildGlobalEventSummaryV1Tick({ prisma })()).summariesCommitted, 1);
});

it("source writers append a fresh signal without waiting for maintenance's observed signal lock", async () => {
  const f = await fixture(2, true);
  const [signal] = await prisma.$queryRawUnsafe("SELECT id::text FROM global_event_recovery_candidates WHERE kind='ENTITLEMENT_EVENT' AND event_id=$1", f.event.id);
  const maintenance = new Client({ connectionString: process.env.DATABASE_URL });
  const writer = new Client({ connectionString: process.env.DATABASE_URL });
  await maintenance.connect(); await writer.connect();
  try {
    await maintenance.query("BEGIN");
    await maintenance.query("SELECT id FROM global_event_recovery_candidates WHERE id=$1 FOR UPDATE", [signal.id]);
    await writer.query("SET statement_timeout='500ms'");
    await writer.query("UPDATE global_step_event_entitlements SET schedule_revision=1 WHERE id=$1", [f.entitlement.id]);
    const fresh = (await writer.query("SELECT id::text FROM global_event_recovery_candidates WHERE completion_key=$1", [
      `GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1:${f.entitlement.id}:1`,
    ])).rows;
    assert.equal(fresh.length, 1);
    await maintenance.query("ROLLBACK");
    await prisma.$executeRawUnsafe("SELECT global_event_recovery_refresh($1,$2,$3::timestamp,$4::bigint)",
      f.event.id, f.account.user.id, new Date(), signal.id);
    assert.equal((await writer.query("SELECT count(*)::int AS n FROM global_event_recovery_candidates WHERE id=$1", [fresh[0].id])).rows[0].n, 1,
      "maintenance must not retire a concurrently appended revision signal");
  } finally {
    await maintenance.query("ROLLBACK");
    await maintenance.end(); await writer.end();
  }
});

it("simultaneous final transitions in different races cannot lose the last-ready summary signal", async () => {
  const f = await fixture(1);
  const impacts = [];
  for (let i = 0; i < 2; i++) {
    const race = await prisma.race.create({ data: { creatorId: f.account.user.id, name: "Concurrent final", status: "ACTIVE", targetSteps: 10000 } });
    impacts.push(await prisma.globalEventRaceImpact.create({ data: {
      eventId: f.event.id, raceId: race.id, userId: f.account.user.id, status: "PENDING", attributionVersion: 1,
    } }));
  }
  const tick = buildGlobalEventSummaryV1Tick({ prisma });
  assert.equal((await tick()).summariesCommitted, 0);
  const first = new Client({ connectionString: process.env.DATABASE_URL });
  const second = new Client({ connectionString: process.env.DATABASE_URL });
  await first.connect(); await second.connect();
  try {
    await first.query("BEGIN"); await second.query("BEGIN");
    await first.query("SET LOCAL statement_timeout='500ms'");
    await second.query("SET LOCAL statement_timeout='500ms'");
    await first.query("UPDATE global_event_race_impacts SET status='FINAL',delta_steps=25 WHERE id=$1", [impacts[0].id]);
    // Each trigger still sees the OTHER transaction's old PENDING row. Both
    // must signal independently rather than trying to prove all-final here.
    await second.query("UPDATE global_event_race_impacts SET status='FINAL',delta_steps=50 WHERE id=$1", [impacts[1].id]);
    await first.query("COMMIT"); await second.query("COMMIT");
  } finally {
    await first.query("ROLLBACK"); await second.query("ROLLBACK");
    await first.end(); await second.end();
  }
  assert.equal((await tick()).summariesCommitted, 1);
  const summary = await prisma.globalEventUserSummary.findUniqueOrThrow({ where: workKey(f) });
  assert.equal(summary.extraRaceSteps, 75);
  assert.equal(summary.raceCount, 2, "duplicate source signals must never multiply the impact aggregation");
});

it("more than a page of duplicate pending signals cannot permanently hide distinct ready work", async () => {
  const pending = await fixture(1);
  const race = await prisma.race.create({ data: { creatorId: pending.account.user.id, name: "Duplicate signals", status: "ACTIVE", targetSteps: 10000 } });
  const impact = await prisma.globalEventRaceImpact.create({ data: {
    eventId: pending.event.id, raceId: race.id, userId: pending.account.user.id, status: "PENDING", attributionVersion: 1,
  } });
  // Real source transitions, not fabricated queue rows. Each transition must
  // remain recoverable, even if many accumulate before the maintenance tick.
  for (let i = 0; i < 300; i++) {
    await prisma.globalEventRaceImpact.update({ where: { id: impact.id }, data: { status: "FINAL", deltaSteps: 10 } });
    await prisma.globalEventRaceImpact.update({ where: { id: impact.id }, data: { status: "PENDING" } });
  }
  const ready = await fixture(1);
  await prisma.globalEventRaceImpact.create({ data: {
    eventId: ready.event.id, raceId: race.id, userId: ready.account.user.id, status: "FINAL", attributionVersion: 1, deltaSteps: 75,
  } });
  const tick = buildGlobalEventSummaryV1Tick({ prisma });
  let committed = 0;
  for (let i = 0; i < 3; i++) committed += (await tick()).summariesCommitted;
  assert.equal(committed, 1);
  assert.equal((await prisma.globalEventUserSummary.findUniqueOrThrow({ where: workKey(ready) })).extraRaceSteps, 75);
  assert.equal(await prisma.globalEventUserSummary.findUnique({ where: workKey(pending) }), null);
});

it("maintenance cannot deadlock a user deletion through replacement-signal foreign keys", async () => {
  const f = await fixture();
  const [signal] = await prisma.$queryRawUnsafe("SELECT id::text FROM global_event_recovery_candidates WHERE kind='SUMMARY_V2' AND event_id=$1", f.event.id);
  const maintenance = new Client({ connectionString: process.env.DATABASE_URL });
  const deletingUser = new Client({ connectionString: process.env.DATABASE_URL });
  await maintenance.connect(); await deletingUser.connect();
  let deletion;
  try {
    await maintenance.query("BEGIN");
    await maintenance.query("SET LOCAL statement_timeout='500ms'");
    await maintenance.query("SELECT id FROM global_event_recovery_candidates WHERE id=$1 FOR UPDATE", [signal.id]);
    deletion = deletingUser.query("DELETE FROM users WHERE id=$1", [f.account.user.id])
      .then(value => ({ value }), error => ({ error }));
    let blocked = false;
    for (let i = 0; i < 50; i++) {
      const [state] = await prisma.$queryRawUnsafe("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", deletingUser.processID);
      if (state?.wait_event_type === "Lock") { blocked = true; break; }
      await delay(10);
    }
    assert.equal(blocked, true, "user deletion must be waiting on the observed signal before maintenance proceeds");
    await maintenance.query("SELECT global_event_recovery_refresh($1,$2,$3::timestamp,$4::bigint)",
      [f.event.id, f.account.user.id, new Date(), signal.id]);
    await maintenance.query("COMMIT");
    const outcome = await deletion;
    assert.ifError(outcome.error);
    assert.equal(outcome.value.rowCount, 1);
  } finally {
    await maintenance.query("ROLLBACK");
    if (deletion) await deletion;
    await maintenance.end(); await deletingUser.end();
  }
});

it("a source status update cannot deadlock account deletion while appending its recovery signal", async () => {
  const f = await fixture(1);
  const owner = await createTestUser();
  const race = await prisma.race.create({ data: { creatorId: owner.user.id, name: "Source deletion race", status: "ACTIVE", targetSteps: 10000 } });
  const impact = await prisma.globalEventRaceImpact.create({ data: {
    eventId: f.event.id, userId: f.account.user.id, raceId: race.id, status: "PENDING", attributionVersion: 1,
  } });
  const source = new Client({ connectionString: process.env.DATABASE_URL });
  const deletingUser = new Client({ connectionString: process.env.DATABASE_URL });
  await source.connect(); await deletingUser.connect();
  let deletion;
  try {
    await source.query("BEGIN");
    await source.query("SET LOCAL statement_timeout='500ms'");
    await source.query("SELECT id FROM global_event_race_impacts WHERE id=$1 FOR UPDATE", [impact.id]);
    deletion = deletingUser.query("DELETE FROM users WHERE id=$1", [f.account.user.id])
      .then(value => ({ value }), error => ({ error }));
    let blocked = false;
    for (let i = 0; i < 50; i++) {
      const [state] = await prisma.$queryRawUnsafe("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", deletingUser.processID);
      if (state?.wait_event_type === "Lock") { blocked = true; break; }
      await delay(10);
    }
    assert.equal(blocked, true);
    await source.query("UPDATE global_event_race_impacts SET status='FINAL',delta_steps=25 WHERE id=$1", [impact.id]);
    await source.query("COMMIT");
    // The existing impact->user FK is RESTRICT, not CASCADE. Once the source
    // commits, deletion must promptly reject normally, not deadlock/time out.
    assert.equal((await deletion).error?.code, "23503");
    assert.equal((await prisma.globalEventRaceImpact.findUniqueOrThrow({ where: { id: impact.id } })).status, "FINAL");
    assert.ok(await prisma.user.findUnique({ where: { id: f.account.user.id } }));
  } finally {
    await source.query("ROLLBACK");
    if (deletion) await deletion;
    await source.end(); await deletingUser.end();
  }
});

it("orphan cleanup bounds its work even for future-dated hints inserted after parent cleanup", async () => {
  const f = await fixture(2, true);
  await prisma.user.delete({ where: { id: f.account.user.id } });
  // Models the narrow bootstrap-insert race AFTER the parent deletion trigger.
  await prisma.$executeRawUnsafe(`INSERT INTO global_event_recovery_candidates(kind,event_id,user_id,source_id,available_at,completion_key)
    SELECT 'SUMMARY_V2',$1,$2,$3,clock_timestamp()+interval '1 year','orphan' FROM generate_series(1,8)`,
    f.event.id, f.account.user.id, f.entitlement.id);
  const cleanup = async () => (await prisma.$queryRawUnsafe("SELECT global_event_recovery_cleanup_orphans(3) AS n"))[0].n;
  assert.equal(await cleanup(), 3);
  assert.equal((await prisma.$queryRawUnsafe("SELECT count(*)::int AS n FROM global_event_recovery_candidates"))[0].n, 5);
  assert.equal(await cleanup(), 3);
  assert.equal(await cleanup(), 2);
  assert.equal(await cleanup(), 0);
  assert.equal((await prisma.$queryRawUnsafe("SELECT count(*)::int AS n FROM global_event_recovery_candidates"))[0].n, 0);
});

it("parent refresh skips an event deletion lock before claiming its cursor", async () => {
  const f = await fixture();
  await prisma.$queryRawUnsafe("SELECT global_event_recovery_seed_page(128)");
  await prisma.globalStepEvent.update({ where: { id: f.event.id }, data: { endsAt: new Date(Date.now() + 3600000) } });
  const parent = new Client({ connectionString: process.env.DATABASE_URL });
  await parent.connect();
  try {
    await parent.query("BEGIN");
    await parent.query("SELECT id FROM global_step_events WHERE id=$1 FOR UPDATE", [f.event.id]);
    await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout='500ms'");
      assert.equal((await tx.$queryRawUnsafe("SELECT global_event_recovery_seed_page(128) AS n"))[0].n, 0);
    });
    assert.equal((await prisma.$queryRawUnsafe("SELECT count(*)::int AS n FROM global_event_recovery_event_refresh"))[0].n, 1);
  } finally { await parent.query("ROLLBACK"); await parent.end(); }
  await prisma.$queryRawUnsafe("SELECT global_event_recovery_seed_page(128)");
  assert.equal((await prisma.$queryRawUnsafe("SELECT count(*)::int AS n FROM global_event_recovery_event_refresh"))[0].n, 0);
});

it("empty due selection and exact completion retirement use indexes amid a large future population", async () => {
  const f = await fixture(2, true);
  await prisma.$executeRawUnsafe(`INSERT INTO global_event_recovery_candidates(kind,event_id,user_id,source_id,available_at,completion_key)
    SELECT 'SUMMARY_V2',$1,$2,$3,clock_timestamp()+interval '1 day','future:' || n::text FROM generate_series(1,20000) n`,
    f.event.id, f.account.user.id, f.entitlement.id);
  // cleanDatabase uses DELETE, so previous runs can leave thousands of dead
  // due-key entries until autovacuum happens. Normalize this test-only physical
  // fixture before measuring the index's cost against the 20k live future rows.
  // Keep the same row, index-choice, and <100-buffer assertions below.
  await prisma.$executeRawUnsafe("VACUUM (ANALYZE) global_event_recovery_candidates");
  const plan = async sql => (await prisma.$queryRawUnsafe(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`))[0]["QUERY PLAN"][0].Plan;
  const nodes = root => [root, ...(root.Plans || []).flatMap(nodes)];
  const due = await plan(`SELECT id FROM global_event_recovery_candidates
    WHERE kind='SUMMARY_V2' AND available_at<=CURRENT_TIMESTAMP::timestamp
    ORDER BY available_at,event_id,user_id,id LIMIT 100`);
  assert.equal(due["Actual Rows"], 0);
  assert.ok(nodes(due).some(node => node["Index Name"] === "global_event_recovery_due_idx"));
  assert.ok((due["Shared Hit Blocks"] || 0) + (due["Shared Read Blocks"] || 0) < 100,
    `an empty due probe must not walk thousands of future hints: ${JSON.stringify(due)}`);
  const retired = await plan("DELETE FROM global_event_recovery_candidates WHERE completion_key='future:10000' RETURNING id");
  assert.equal(retired["Actual Rows"], 1);
  assert.ok(nodes(retired).some(node => node["Index Name"] === "global_event_recovery_completion_idx"));
  assert.ok((retired["Shared Hit Blocks"] || 0) + (retired["Shared Read Blocks"] || 0) < 100);
});

it("orphan sweeps revisit skipped IDs even when arrivals continually outrun the page size", async () => {
  const f = await fixture(2, true);
  await prisma.user.delete({ where: { id: f.account.user.id } });
  const append = size => prisma.$executeRawUnsafe(`INSERT INTO global_event_recovery_candidates(kind,event_id,user_id,source_id,available_at,completion_key)
    SELECT 'SUMMARY_V2',$1,$2,$3,clock_timestamp()+interval '1 year','orphan' FROM generate_series(1,$4::int)`,
    f.event.id, f.account.user.id, f.entitlement.id, size);
  await append(8);
  const [oldest] = await prisma.$queryRawUnsafe("SELECT id::text FROM global_event_recovery_candidates ORDER BY id LIMIT 1");
  const lock = new Client({ connectionString: process.env.DATABASE_URL });
  await lock.connect();
  try {
    await lock.query("BEGIN");
    await lock.query("SELECT id FROM global_event_recovery_candidates WHERE id=$1 FOR UPDATE", [oldest.id]);
    assert.equal((await prisma.$queryRawUnsafe("SELECT global_event_recovery_cleanup_orphans(3) AS n"))[0].n, 3);
    await lock.query("ROLLBACK");
    for (let i = 0; i < 4; i++) {
      await append(5); // Faster arrival rate than the cleanup page.
      await prisma.$queryRawUnsafe("SELECT global_event_recovery_cleanup_orphans(3)");
    }
    assert.equal((await prisma.$queryRawUnsafe("SELECT count(*)::int AS n FROM global_event_recovery_candidates WHERE id=$1::bigint", oldest.id))[0].n, 0,
      "a finite sweep watermark must wrap and revisit the skipped old signal despite new arrivals");
  } finally { await lock.query("ROLLBACK"); await lock.end(); }
});
