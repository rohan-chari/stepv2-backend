const assert = require("node:assert/strict");
const test = require("node:test");

const { prisma, disconnectDatabase } = require("./setup");

test.after(async () => disconnectDatabase());

test("local global-event schema is additive and default-safe", async () => {
  const parentColumns = await prisma.$queryRawUnsafe(`
    SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'global_step_events'
       AND column_name IN (
         'schedule_mode',
         'event_day',
         'local_start_minute',
         'duration_minutes',
         'schedule_policy_version'
       )
     ORDER BY column_name
  `);
  assert.deepEqual(parentColumns.map((row) => row.column_name), [
    "duration_minutes", "event_day", "local_start_minute", "schedule_mode",
    "schedule_policy_version",
  ]);
  const scheduleMode = parentColumns.find((row) => row.column_name === "schedule_mode");
  assert.equal(scheduleMode.is_nullable, "NO");
  assert.match(scheduleMode.column_default || "", /LEGACY_GLOBAL/);
  const schedulePolicyVersion = parentColumns.find(
    (row) => row.column_name === "schedule_policy_version"
  );
  assert.equal(schedulePolicyVersion.is_nullable, "YES");
  assert.equal(schedulePolicyVersion.column_default, null);

  const userColumns = await prisma.$queryRawUnsafe(`
    SELECT column_name, is_nullable
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'users'
       AND column_name IN (
         'global_event_timezone',
         'global_event_timezone_candidate',
         'global_event_timezone_candidate_since'
       )
     ORDER BY column_name
  `);
  assert.equal(userColumns.length, 3);
  assert.ok(userColumns.every((row) => row.is_nullable === "YES"));

  const entitlementColumns = await prisma.$queryRawUnsafe(`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'global_step_event_entitlements'
  `);
  assert.ok(entitlementColumns.length > 0, "entitlement table exists");

  const uniqueConstraint = await prisma.$queryRawUnsafe(`
    SELECT 1
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'global_step_event_entitlements'
       AND indexdef LIKE '%(event_id, user_id)%'
  `);
  assert.equal(uniqueConstraint.length, 1);

  const snapshotColumns = await prisma.$queryRawUnsafe(`
    SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'global_step_event_operational_snapshots'
       AND column_name IN ('exposure_buckets', 'entitlements_by_offset', 'rollout_counters')
     ORDER BY column_name
  `);
  assert.deepEqual(snapshotColumns.map((row) => row.column_name), [
    "entitlements_by_offset", "exposure_buckets", "rollout_counters",
  ]);
  assert.ok(snapshotColumns.every((row) =>
    row.is_nullable === "NO" && /jsonb/.test(row.column_default || "")
  ));

  const counterColumns = await prisma.$queryRawUnsafe(`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'global_step_event_operational_counters'
     ORDER BY column_name
  `);
  assert.deepEqual(counterColumns.map((row) => row.column_name), [
    "metric", "updated_at", "value",
  ]);
});
