const assert = require("node:assert/strict");
const { beforeEach, it } = require("node:test");

const target = new URL(process.env.DATABASE_URL);
assert.ok(["localhost", "127.0.0.1"].includes(target.hostname));
assert.match(decodeURIComponent(target.pathname), /_test$/);
assert.equal(process.env.NODE_ENV, "test");
process.env.PRISMA_QUERY_EVENTS_ENABLED = "true";
const { prisma, cleanDatabase } = require("./setup");
const { bulkAppendDomainEvents } = require("../../src/modules/domainEvents");
const { DomainEventReceiptRecovery } = require("../../src/modules/domainEvents/models/domainEventReceiptRecovery");

let observed = null;
let claimStatement = null;
prisma.$on("query", (query) => {
  if (observed) observed.push(query.query);
  if (query.query.trim().startsWith("WITH fresh AS MATERIALIZED")) claimStatement = query;
});
beforeEach(cleanDatabase);

it("bulk receipt creation keeps database round trips constant as an event page grows", async () => {
  const results = [];
  for (const count of [2, 100]) {
    const events = Array.from({ length: count }, (_, i) => ({
      eventKey: `receipt-budget:${count}:${i}`, eventType: "RECEIPT_BUDGET_V1",
      schemaVersion: 1, aggregateType: "TEST", aggregateId: `source:${count}:${i}`,
      occurredAt: new Date("2026-09-01"), availableAt: new Date("2026-09-01"),
      payload: { index: i }, audience: [{ recipientId: `recipient:${i}`, facts: {} }],
    }));
    observed = [];
    let output;
    try { output = await bulkAppendDomainEvents(prisma, events); }
    finally {
      results.push({ events: count, calls: observed.length,
        receiptCalls: observed.filter((sql) => sql.includes("domain_event_receipts")).length });
      observed = null;
    }
    assert.equal(output.inserted, count);
    assert.equal(await prisma.domainEventReceipt.count({ where: {
      eventKey: { in: events.map((event) => event.eventKey) }, receiptState: "FINAL",
    } }), count);
    assert.equal(await prisma.domainEventReceiptRecovery.count(), 0);
  }
  assert.ok(results[0].receiptCalls > 0, "real query observer must capture receipt statements");
  assert.equal(results[1].calls, results[0].calls, JSON.stringify(results));
  assert.equal(results[1].receiptCalls, results[0].receiptCalls, JSON.stringify(results));
  console.log(JSON.stringify({ event: "receipt_bulk_query_budget", results,
    excludes: "server-side trigger statements, WAL bytes, and downstream delivery work" }));
});

it("uses the partial due, fresh and lease indexes with a ten-thousand-row recovery backlog", async () => {
  // Local disposable data only. There is no HTTP entry point for queue claims.
  await prisma.$executeRawUnsafe(`INSERT INTO domain_event_receipt_recovery
    (domain_event_id,event_key,reason,status,available_at,lease_until,attempt_count)
    SELECT gen_random_uuid(),'receipt-plan:'||i,
      CASE WHEN i%20=0 THEN 'COMPAT_PROVISIONAL' ELSE 'LEGACY_MISSING' END,
      CASE WHEN i%10=1 THEN 'PROCESSING' ELSE 'QUEUED' END,
      timestamp '2026-09-01' + i * interval '1 millisecond',
      CASE WHEN i%10=1 THEN timestamp '2026-09-02' END,1
    FROM generate_series(1,10000) AS i`);
  await prisma.$executeRawUnsafe("ANALYZE domain_event_receipt_recovery");
  claimStatement = null;
  const claim = await DomainEventReceiptRecovery.claimPage({ now: new Date("2026-09-03"), limit: 10 });
  assert.equal(claim.rows.length, 10);
  assert.ok(claimStatement, "capture the real worker claim, not a rewritten stand-in query");
  const statement = claimStatement;
  const plan = await prisma.$queryRawUnsafe(`EXPLAIN (FORMAT JSON) ${statement.query}`,
    ...JSON.parse(statement.params));
  const indexes = [];
  const nodes = [];
  function visit(node) {
    nodes.push(node);
    if (node["Index Name"]) indexes.push(node["Index Name"]);
    for (const child of node.Plans || []) visit(child);
  }
  visit(plan[0]["QUERY PLAN"][0].Plan);
  for (const suffix of ["due", "fresh_due", "lease"]) {
    assert.ok(indexes.includes(`domain_event_receipt_recovery_${suffix}_idx`), JSON.stringify(indexes));
  }
  for (const [name, maximum, suffix] of [["fresh", 2, "fresh_due"], ["due", 10, "due"], ["expired", 10, "lease"]]) {
    const branch = nodes.find((node) => node["Subplan Name"] === `CTE ${name}`);
    assert.equal(branch?.["Node Type"], "Limit", `${name} must be independently limited`);
    assert.ok(branch["Plan Rows"] <= maximum);
    const locked = branch.Plans[0];
    assert.equal(locked["Node Type"], "LockRows");
    assert.equal(locked.Plans[0]["Node Type"], "Index Scan", "ordered index scan must feed the limit without a backlog sort");
    assert.equal(locked.Plans[0]["Index Name"], `domain_event_receipt_recovery_${suffix}_idx`);
  }
  const mergeSort = nodes.find((node) => node["Node Type"] === "Sort" &&
    node.Plans?.[0]?.["Node Type"] === "Append");
  assert.ok(mergeSort, "bounded due and expired inputs must be merged");
  assert.deepEqual(mergeSort.Plans[0].Plans.map((node) => node["CTE Name"]).sort(), ["due", "expired"]);
  assert.ok(mergeSort["Plan Rows"] <= 20, "merge sort must consume at most two bounded pages, not the backlog");
  console.log(JSON.stringify({ event: "receipt_claim_index_plan", rows: 10000, claimed: 10, indexes }));
});
