const DAY_MS = 86_400_000;
const LONG_SPAN_DAY = "0001-01-01";

function missingInputs(message) {
  const error = new Error(message);
  error.code = "INPUTS_NOT_RETAINED";
  return error;
}

function requestedDays(start, end) {
  const lower = new Date(start).getTime();
  const upper = new Date(end).getTime();
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower >= upper) {
    throw new Error("Invalid durable capture fact interval");
  }
  const days = [LONG_SPAN_DAY];
  for (let cursor = Math.floor(lower / DAY_MS) * DAY_MS; cursor < upper; cursor += DAY_MS) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return days;
}

/** One SQL snapshot for every owner/user/day in the accepted intake. */
async function pinFactRoots({ client, requests, ownerId, userIds, rangeStart, rangeEnd, revisionHeads }) {
  const batches = requests || [{ ownerId, userIds, rangeStart, rangeEnd }];
  const wanted = new Map();
  for (const batch of batches) {
    for (const userId of batch.userIds) {
      for (const day of requestedDays(batch.rangeStart, batch.rangeEnd)) {
        wanted.set(`${batch.ownerId}:${userId}:${day}`, { ownerId: batch.ownerId, userId, day });
      }
    }
  }
  if (!wanted.size) return [];
  if (revisionHeads) {
    // The caller acquired the shared retention fence BEFORE selecting these
    // revisions alongside metadata. Missing heads in that snapshot mean zero,
    // not permission to look up a newer head after a concurrent source write.
    const revisions = new Map(revisionHeads.map((head) => [`${head.userId}:${head.day}`, head.revision]));
    const saved = JSON.stringify([...wanted.values()].map((row) => ({
      ...row, revision: revisions.get(`${row.userId}:${row.day}`) || "0",
    })));
    await client.$executeRawUnsafe(`INSERT INTO durable_capture_fact_roots(user_id,day,revision)
      SELECT DISTINCT x."userId",x.day::date,x.revision::bigint
      FROM jsonb_to_recordset($1::jsonb) AS x("userId" text,day text,revision text)
      WHERE NOT EXISTS(SELECT 1 FROM durable_capture_fact_roots r
        WHERE r.user_id=x."userId" AND r.day=x.day::date AND r.revision=x.revision::bigint AND NOT r.evicting)
      ORDER BY x."userId",x.day::date,x.revision::bigint
      ON CONFLICT(user_id,day,revision) WHERE NOT evicting DO NOTHING`, saved);
    // Separate statement resolves a concurrent first creator after its commit,
    // while retaining exactly the saved revision rather than refreshing heads.
    const pinned = await client.$queryRawUnsafe(`WITH selected AS MATERIALIZED (
      SELECT x."ownerId"::uuid AS owner_id,r.id AS root_id,r.user_id,r.day::text,r.revision
      FROM jsonb_to_recordset($1::jsonb) AS x("ownerId" text,"userId" text,day text,revision text)
      JOIN durable_capture_fact_roots r ON r.user_id=x."userId" AND r.day=x.day::date
        AND r.revision=x.revision::bigint AND NOT r.evicting
    ), pins AS (INSERT INTO durable_capture_fact_pins(owner_id,root_id)
      SELECT owner_id,root_id FROM selected ON CONFLICT DO NOTHING)
    SELECT * FROM selected ORDER BY owner_id,user_id,day`, saved);
    return pinned.map((row) => ({ id: row.root_id, ownerId: row.owner_id,
      userId: row.user_id, day: row.day, revision: String(row.revision) }));
  }
  const rows = await client.$queryRawUnsafe(
    "SELECT * FROM durable_capture_pin_roots(NULL::uuid,$1::jsonb)", JSON.stringify([...wanted.values()]),
  );
  return rows.map((row) => ({ id: row.root_id, ownerId: row.owner_id,
    userId: row.user_id, day: row.day, revision: String(row.revision) }));
}

/** Bounded roots per claim; other processes reuse committed immutable payloads. */
async function materializeFactRoots({ client, rootIds, limit = 32 }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 256) throw new Error("Invalid fact materialization limit");
  const ids = [...new Set(rootIds)];
  if (!ids.length) return { prepared: 0, remaining: 0, sourceSampleRows: 0, sourceDailyRows: 0, journalRows: 0 };
  const result = await client.$queryRawUnsafe(`
    WITH selected AS MATERIALIZED (
      SELECT id FROM durable_capture_fact_roots WHERE id=ANY($1::uuid[]) AND prepared_at IS NULL AND NOT evicting
      ORDER BY user_id,day,revision LIMIT $2
    ) SELECT id,durable_capture_materialize_root(id) AS work FROM selected`, ids, limit);
  // The SQL function returns work performed by this invocation, not the root's
  // lifetime totals. Record here (before later validation can fail) so retries
  // and discarded preparation still count as actual database work.
  const metrics = require("../../../shared/observability/coordinatedOptimizationMetrics")
    .coordinatedOptimizationMetrics;
  for (const { work } of result) {
    metrics.observe("global_summary_capture_sample_db_rows", work.sourceSampleRows);
    metrics.observe("global_summary_capture_daily_db_rows", work.sourceDailyRows);
    metrics.observe("global_summary_capture_journal_db_rows", work.journalRows);
    metrics.observe("global_summary_capture_mutable_rows", work.sourceSampleRows + work.sourceDailyRows);
  }
  const rows = await client.$queryRawUnsafe(`
    SELECT id,prepared_at,source_sample_rows,source_daily_rows,journal_rows
    FROM durable_capture_fact_roots WHERE id=ANY($1::uuid[]) AND NOT evicting`, ids);
  if (rows.length !== ids.length) throw missingInputs("Durable capture input owner was deleted or root is missing");
  return result.reduce((value, row) => {
    value.prepared += row.work.prepared;
    value.sourceSampleRows += row.work.sourceSampleRows;
    value.sourceDailyRows += row.work.sourceDailyRows;
    value.journalRows += row.work.journalRows;
    return value;
  }, { prepared: 0, remaining: rows.filter((row) => !row.prepared_at).length,
    sourceSampleRows: 0, sourceDailyRows: 0, journalRows: 0 });
}

async function readFactRootPage({ client, rootId, afterPage = 0, expectedDigest = null }) {
  if (!Number.isInteger(afterPage) || afterPage < 0) throw new Error("Invalid immutable page cursor");
  const [row] = await client.$queryRawUnsafe(`
    SELECT id,user_id,day::text,revision::text,digest,initial_digest,page_count,row_count,prepared_at,
      initial_digest=encode(digest(user_id||'|'||day::text||'|'||revision::text,'sha256'),'hex') AS valid_initial
    FROM durable_capture_fact_roots WHERE id=$1::uuid AND NOT evicting`, rootId);
  if (!row?.prepared_at || !row.valid_initial || !row.digest || afterPage > row.page_count) {
    throw missingInputs("Durable capture root is missing, unprepared, or corrupt");
  }
  const root = { id: row.id, userId: row.user_id, day: row.day, revision: row.revision,
    digest: row.digest, pageCount: row.page_count, rowCount: row.row_count };
  const previous = afterPage === 0 ? row.initial_digest : expectedDigest;
  if (!previous) throw missingInputs("Durable capture page chain witness is missing");
  if (afterPage === row.page_count) {
    if (previous !== row.digest || (afterPage === 0 && row.row_count !== 0)) {
      throw missingInputs("Durable capture terminal page witness is corrupt");
    }
    return { root, page: null, nextPage: afterPage, done: true };
  }
  const [page] = await client.$queryRawUnsafe(`
    SELECT page_number,rows,row_count,digest,prior_digest,cumulative_digest,
      (digest=encode(digest(rows::text,'sha256'),'hex')
       AND cumulative_digest=encode(digest(prior_digest||'|'||digest||'|'||page_number::text,'sha256'),'hex')
       AND row_count=jsonb_array_length(rows) AND row_count<=256) AS valid
    FROM durable_capture_fact_pages WHERE root_id=$1::uuid AND page_number=$2`, rootId, afterPage + 1);
  const done = afterPage + 1 === row.page_count;
  if (!page?.valid || page.prior_digest !== previous || (done && page.cumulative_digest !== row.digest)) {
    throw missingInputs("Durable capture page is missing, corrupt, or detached from its immutable chain");
  }
  require("../../../shared/observability/coordinatedOptimizationMetrics")
    .coordinatedOptimizationMetrics.observe("global_summary_capture_durable_fact_bytes", Buffer.byteLength(JSON.stringify(page.rows)));
  return { root, page: { number: page.page_number, priorDigest: page.prior_digest, digest: page.digest,
    cumulativeDigest: page.cumulative_digest, rows: page.rows }, nextPage: page.page_number, done };
}

// Compatibility/assertion helper only. Production scoring consumes one bounded
// readFactRootPage at a time and persists its cursor instead of calling this.
async function loadFactRoots({ client, rootIds, rangeStart, rangeEnd }) {
  const ids = [...new Set(rootIds)];
  const roots = [];
  const lower = rangeStart == null ? -Infinity : new Date(rangeStart).getTime();
  const upper = rangeEnd == null ? Infinity : new Date(rangeEnd).getTime();
  const samples = new Map();
  const dailySteps = new Map();
  for (const rootId of ids) {
    let afterPage = 0; let expectedDigest = null; let observedRows = 0;
    const facts = { samples: [], dailySteps: [] };
    while (true) {
      const result = await readFactRootPage({ client, rootId, afterPage, expectedDigest });
      for (const row of result.page?.rows || []) facts[row.kind === "sample" ? "samples" : "dailySteps"].push(row.fact);
      observedRows += result.page?.rows.length || 0;
      if (result.done) {
        if (observedRows !== result.root.rowCount) throw missingInputs("Durable capture root row count is corrupt");
        roots.push(result.root); break;
      }
      afterPage = result.nextPage; expectedDigest = result.page.cumulativeDigest;
    }
    for (const sample of facts.samples) {
      if (new Date(sample.periodEnd).getTime() <= lower || new Date(sample.periodStart).getTime() >= upper) continue;
      const { rowId, ...fact } = sample;
      if (samples.has(rowId) && JSON.stringify(samples.get(rowId)) !== JSON.stringify(fact)) {
        throw missingInputs("Inconsistent durable capture sample revisions");
      }
      samples.set(rowId, fact);
    }
    for (const daily of facts.dailySteps) {
      if (new Date(daily.date).getTime() + DAY_MS <= lower || new Date(daily.date).getTime() >= upper) continue;
      const { rowId, ...fact } = daily;
      if (dailySteps.has(rowId) && JSON.stringify(dailySteps.get(rowId)) !== JSON.stringify(fact)) {
        throw missingInputs("Inconsistent durable capture daily revisions");
      }
      dailySteps.set(rowId, fact);
    }
  }
  return {
    samples: [...samples.values()].sort((a, b) => a.userId.localeCompare(b.userId) || a.periodStart.localeCompare(b.periodStart)),
    dailySteps: [...dailySteps.values()].sort((a, b) => a.userId.localeCompare(b.userId) || a.date.localeCompare(b.date)),
    roots,
  };
}

async function releaseFactRoots({ client, ownerId }) {
  return client.$executeRawUnsafe("DELETE FROM durable_capture_fact_pins WHERE owner_id=$1::uuid", ownerId);
}

async function compactFactHistory({ client, limit = 1000 }) {
  const [result] = await client.$queryRawUnsafe("SELECT * FROM durable_capture_compact($1::integer)", limit);
  return { journalDeleted: result.journal_deleted, rootsDeleted: result.roots_deleted };
}

async function compactFactHistoryIfDue({ client, limit = 128 }) {
  const [result] = await client.$queryRawUnsafe("SELECT * FROM durable_capture_compact_if_due($1::integer)", limit);
  return { journalDeleted: result.journal_deleted, rootsDeleted: result.roots_deleted };
}

module.exports = { pinFactRoots, materializeFactRoots, readFactRootPage, loadFactRoots, releaseFactRoots, compactFactHistory, compactFactHistoryIfDue };
