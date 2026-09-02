const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "../..");

test("projection claims bound due and expired-lease branches before global ordering", () => {
  const source = fs.readFileSync(path.join(ROOT,
    "src/modules/domainEvents/models/domainEventOutbox.js"), "utf8");
  assert.match(source, /due_candidates AS MATERIALIZED[\s\S]*LIMIT \$2[\s\S]*FOR UPDATE OF p SKIP LOCKED/);
  assert.match(source, /recovery_candidates AS MATERIALIZED[\s\S]*LIMIT \$2[\s\S]*FOR UPDATE OF p SKIP LOCKED/);
  assert.match(source, /UNION ALL[\s\S]*ORDER BY due_at,occurred_at,id[\s\S]*LIMIT \$2/);
});

test("domain event exact due honors scheduled pacing and aggregate FIFO", () => {
  const source = fs.readFileSync(path.join(ROOT,
    "src/modules/domainEvents/models/domainEventOutbox.js"), "utf8");
  const claimStart = source.indexOf("async function claimEvents");
  const dueStart = source.indexOf("async function nextDueAt", claimStart);
  const claim = source.slice(claimStart, dueStart);
  const dueEnd = source.indexOf("async function loadAudiencePage", dueStart);
  const due = source.slice(dueStart, dueEnd);
  assert.match(claim, /notification_release_lanes[\s\S]*SCHEDULED_PROJECTION_LANE/);
  assert.match(due, /next_token_at/);
  assert.match(due, /NOT EXISTS \([\s\S]*older\.aggregate_type=e\.aggregate_type/);
});

test("admission retries and expired leases are bounded independently", () => {
  const source = fs.readFileSync(path.join(ROOT,
    "src/modules/notifications/services/notificationAdmission.js"), "utf8");
  assert.match(source, /retry_candidates AS MATERIALIZED[\s\S]*status='ADMISSION_RETRY'[\s\S]*LIMIT \$3/);
  assert.match(source, /lease_candidates AS MATERIALIZED[\s\S]*status='ADMISSION_LEASED'[\s\S]*LIMIT \$3/);
  assert.match(source, /UNION ALL[\s\S]*ORDER BY "dueAt","admissionSequence",id[\s\S]*LIMIT \$3/);
});

test("active due/lease/expiry claim branches have purpose-built partial indexes", () => {
  const migration = fs.readFileSync(path.join(ROOT,
    "prisma/migrations/20260902126000_exact_due_branch_indexes/migration.sql"), "utf8");
  for (const name of [
    "inbox_delivery_outbox_normal_expiry_v2_idx",
    "inbox_delivery_outbox_admission_expiry_v2_idx",
  ]) assert.match(migration, new RegExp(name));
  const expiryMigration = fs.readFileSync(path.join(ROOT,
    "prisma/migrations/20260902127000_schedule_and_admission_expiry_indexes/migration.sql"), "utf8");
  for (const name of [
    "notification_schedules_pending_expiry_v2_idx",
    "notification_schedules_admission_expiry_v2_idx",
    "inbox_delivery_outbox_admission_expiry_by_class_v2_idx",
  ]) assert.match(expiryMigration, new RegExp(name));
  const summaryLeaseMigration = fs.readFileSync(path.join(ROOT,
    "prisma/migrations/20260902128000_global_summary_exact_lease_indexes/migration.sql"), "utf8");
  for (const name of [
    "global_event_summary_work_ready_lease_v2_idx",
    "global_event_summary_work_sync_lease_v2_idx",
  ]) assert.match(summaryLeaseMigration, new RegExp(name));
});

test("summary exact-due probes use branch-indexable minima instead of row expressions", () => {
  const source = fs.readFileSync(path.join(ROOT,
    "src/modules/steps/jobs/globalEventSummary.js"), "utf8");
  const start = source.indexOf("async function nextSummaryDueAt");
  const end = source.indexOf("async function releaseWorkLease", start);
  const query = source.slice(start, end);
  assert.doesNotMatch(query, /GREATEST\(/);
  assert.match(query, /MIN\(available_at\)[\s\S]*status='WAITING_RACES'[\s\S]*lease_until IS NULL/);
  assert.match(query, /MIN\(lease_until\)[\s\S]*status='WAITING_RACES'[\s\S]*available_at <= CURRENT_TIMESTAMP/);
  assert.match(query, /MIN\(expires_at\)[\s\S]*status='WAITING_SYNC'[\s\S]*lease_until IS NULL/);
  assert.match(query, /MIN\(lease_until\)[\s\S]*status='WAITING_SYNC'[\s\S]*expires_at <= CURRENT_TIMESTAMP/);
});

test("summary claims bound unleased and expired-lease work in separate branches", () => {
  const source = fs.readFileSync(path.join(ROOT,
    "src/modules/steps/jobs/globalEventSummary.js"), "utf8");
  const start = source.indexOf("async function claimActiveWork");
  const end = source.indexOf("async function repairSummaryReadiness", start);
  const claim = source.slice(start, end);
  assert.doesNotMatch(claim, /lease_until IS NULL OR lease_until <=/);
  assert.match(claim, /status='WAITING_RACES'[\s\S]*lease_until IS NULL[\s\S]*LIMIT \$2/);
  assert.match(claim, /status='WAITING_RACES'[\s\S]*lease_until <= \$1[\s\S]*LIMIT \$2/);
  assert.match(claim, /status='WAITING_SYNC'[\s\S]*lease_until IS NULL[\s\S]*LIMIT \$2/);
  assert.match(claim, /status='WAITING_SYNC'[\s\S]*lease_until <= \$1[\s\S]*LIMIT \$2/);
});

test("admission exact-due probes split FIRST, RETRY, LEASED and include the indexed class", () => {
  const admission = fs.readFileSync(path.join(ROOT,
    "src/modules/notifications/services/notificationAdmission.js"), "utf8");
  assert.match(admission, /status: ADMISSION_FIRST[\s\S]*orderBy: \[\{ availableAt: "asc"/);
  assert.match(admission, /status: ADMISSION_RETRY[\s\S]*orderBy: \[\{ availableAt: "asc"/);
  assert.match(admission, /status: ADMISSION_LEASED[\s\S]*orderBy: \[\{ leaseUntil: "asc"/);

  const inbox = fs.readFileSync(path.join(ROOT,
    "src/modules/inbox/jobs/inboxDelivery.js"), "utf8");
  for (const state of ["ADMISSION_FIRST", "ADMISSION_RETRY", "ADMISSION_LEASED"]) {
    assert.match(inbox, new RegExp(`admission_class='visible:GLOBAL_EVENT_STARTED' AND status='${state}'`));
  }
  const schedules = fs.readFileSync(path.join(ROOT,
    "src/modules/notifications/services/notificationDelivery.js"), "utf8");
  assert.match(schedules, /status: ADMISSION_PENDING,[\s\S]*admissionClass: ADMISSION_CLASS_GLOBAL_EVENT_STARTED/);
});

test("normal Inbox claims bound due and expired leases before one atomic SKIP LOCKED update", () => {
  const source = fs.readFileSync(path.join(ROOT,
    "src/modules/inbox/jobs/inboxDelivery.js"), "utf8");
  const start = source.indexOf("async function claimNormalInboxPage");
  const end = source.indexOf("async function nextInboxDeliveryDueAt", start);
  const claim = source.slice(start, end);
  assert.match(claim, /due_candidates AS MATERIALIZED[\s\S]*status IN \('PENDING','RETRY'\)[\s\S]*LIMIT \$2/);
  assert.match(claim, /recovery_candidates AS MATERIALIZED[\s\S]*status='LEASED'[\s\S]*LIMIT \$2/);
  assert.match(claim, /ORDER BY lease_until,available_at,id LIMIT \$2/);
  assert.match(claim, /FOR UPDATE OF outbox SKIP LOCKED/);
  assert.match(claim, /UPDATE inbox_delivery_outbox/);
  assert.doesNotMatch(claim, /provider|sendNotification/);
});
