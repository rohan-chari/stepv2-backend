// Retain accepted capture provenance for 30 days after terminalization. The
// published outcome survives input collection. Pending owners never age out.
async function releaseTerminalCapturePins(client, { budget = { remaining:128 }, ownerIds = null } = {}) {
  const limit=Math.max(0,Math.min(128,Number(budget.remaining)||0));
  if (!limit) return 0;
  const [result]=await client.$queryRawUnsafe(`WITH owners AS MATERIALIZED (
      SELECT owner_id FROM durable_capture_pin_releases WHERE available_at<=clock_timestamp()
        AND ($2::uuid[] IS NULL OR owner_id=ANY($2::uuid[]))
      ORDER BY available_at,owner_id LIMIT 32 FOR UPDATE SKIP LOCKED
    ), selected AS MATERIALIZED (
      SELECT p.owner_id,p.root_id FROM durable_capture_fact_pins p
      WHERE p.owner_id IN(SELECT owner_id FROM owners)
      ORDER BY p.owner_id,p.root_id LIMIT $1 FOR UPDATE SKIP LOCKED
    ), deleted AS (
      DELETE FROM durable_capture_fact_pins p USING selected s
      WHERE p.owner_id=s.owner_id AND p.root_id=s.root_id RETURNING p.owner_id,p.root_id
    ), emptied AS (
      DELETE FROM durable_capture_pin_releases q USING owners o WHERE q.owner_id=o.owner_id
        AND NOT EXISTS(SELECT 1 FROM durable_capture_fact_pins p WHERE p.owner_id=q.owner_id
          AND NOT EXISTS(SELECT 1 FROM deleted d WHERE d.owner_id=p.owner_id AND d.root_id=p.root_id))
      RETURNING q.owner_id
    ) SELECT (SELECT count(*)::int FROM deleted) AS deleted,(SELECT count(*)::int FROM emptied) AS emptied`,limit,ownerIds);
  budget.remaining-=result.deleted;
  return result.deleted;
}

async function cleanupDurableCaptures(client, { pinBudget = { remaining:128 }, retention = true } = {}) {
  const pinsDeleted=await releaseTerminalCapturePins(client,{budget:pinBudget});
  const scoreRowsDeleted = await require("./durableCaptureStageScoring")
    .compactDurableScoreProgress({ client, limit: 128 });
  // Live source writes create journals even without pending captures. Their
  // maintenance deadline is durable, not reset by each summary wake/restart.
  const facts = await require("./durableCaptureFacts").compactFactHistoryIfDue({ client, limit: 128 });
  if (!retention) return { pinsDeleted, scoreRowsDeleted, ...facts };
  const requestsDeleted = await client.$transaction(async (tx) => {
    const owners = await tx.$queryRawUnsafe(`SELECT id FROM durable_global_event_capture_requests
      WHERE status IN ('COMPLETE','EXPIRED','FAILED') AND completed_at<CURRENT_TIMESTAMP-interval '30 days'
      ORDER BY completed_at,id LIMIT 32 FOR UPDATE SKIP LOCKED`);
    if (!owners.length) return 0;
    const ids = owners.map((row) => row.id);
    // Avoid an unbounded delete cascade: collect an owner only after all of
    // its pins have been removed by bounded passes above.
    return tx.$executeRawUnsafe(`DELETE FROM durable_global_event_capture_requests r
      WHERE id=ANY($1::uuid[]) AND NOT EXISTS
        (SELECT 1 FROM durable_capture_fact_pins p WHERE p.owner_id=r.id)
        AND NOT EXISTS (SELECT 1 FROM durable_capture_score_progress s WHERE s.request_id=r.id)
        AND NOT EXISTS (SELECT 1 FROM durable_capture_score_plans s WHERE s.request_id=r.id)
        AND NOT EXISTS (SELECT 1 FROM durable_capture_score_transfers s WHERE s.request_id=r.id)`, ids);
  });
  const answersDeleted = await client.$executeRawUnsafe(`WITH selected AS MATERIALIZED (
    SELECT scope_digest FROM durable_capture_prepared_inputs
      WHERE updated_at<CURRENT_TIMESTAMP-interval '30 days'
      ORDER BY updated_at,scope_digest LIMIT 128 FOR UPDATE SKIP LOCKED
    ) DELETE FROM durable_capture_prepared_inputs p USING selected s WHERE p.scope_digest=s.scope_digest`);
  const progressDeleted = await client.$executeRawUnsafe(`WITH selected AS MATERIALIZED (
    SELECT scope_digest,method_digest FROM durable_capture_method_progress
      WHERE updated_at<CURRENT_TIMESTAMP-interval '30 days'
      ORDER BY updated_at,scope_digest,method_digest LIMIT 128 FOR UPDATE SKIP LOCKED
    ) DELETE FROM durable_capture_method_progress p USING selected s
      WHERE p.scope_digest=s.scope_digest AND p.method_digest=s.method_digest`);
  const projectionsDeleted = await require("./durableCaptureIntervalProjection").compactIntervalProjections({ client, limit: 128 });
  const moreRetention = requestsDeleted >= 32 || answersDeleted >= 128 || progressDeleted >= 128 || projectionsDeleted >= 128;
  return { requestsDeleted, answersDeleted, progressDeleted, projectionsDeleted, scoreRowsDeleted, pinsDeleted, moreRetention, ...facts };
}

module.exports = { cleanupDurableCaptures,releaseTerminalCapturePins };
