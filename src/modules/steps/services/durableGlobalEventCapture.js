const crypto = require("node:crypto");

// The shared work row stays understandable to old HTTP clients and workers.
// Its parked lease is independent of the short, recoverable compute lease.
function parkedToken(id) { return `capture:${id}`; }

async function enqueueDurableCaptures(client, { candidates, impacts, entitlementsByEventId, provenance }) {
  if (!candidates.length) return null;
  const { prepareDurableCaptureContext, digestCanonical, MAX_WORK_BYTES, CAPTURE_EFFECT_TYPES } = require("./globalEventSummaryCapture");
  const { pinFactRoots } = require("./durableCaptureFacts");
  const snapshot = await require("./durableCaptureSnapshot").readDurableCaptureSnapshot(client, {
    raceIds: [...new Set(impacts.map((impact) => impact.raceId))],
    raceWindows: candidates.flatMap((work) => impacts.filter((impact) => impact.eventId === work.eventId)
      .map((impact) => ({ raceId: impact.raceId, userId: work.userId,
        eventEndsAt: entitlementsByEventId.get(work.eventId).endsAt }))),
    effectTypes: CAPTURE_EFFECT_TYPES,
  });
  const pending = [];
  async function reject(work, reason) {
    const updated = await client.globalEventSummaryWork.updateMany({
      where: { id: work.id, status: "WAITING_SYNC", leaseToken: null },
      data: { status: "UNSCORABLE", lastErrorCode: reason, raceReconciledAt: null },
    });
    if (updated.count) await client.jobRun.upsert({
      where: { jobName: `global_event_summary:${work.eventId}:${work.userId}:v2` },
      create: { jobName: `global_event_summary:${work.eventId}:${work.userId}:v2`, lastRanFor: "UNSCORABLE" },
      update: {},
    });
  }
  for (const work of candidates) {
    const workImpacts = impacts.filter((impact) => impact.eventId === work.eventId);
    if (workImpacts.some((impact) => impact.attributionVersion !== 2 || impact.status !== "PENDING")) {
      await reject(work, "DEPENDENCY_INPUT_UNREPLAYABLE");
      continue;
    }
    const prepared = await prepareDurableCaptureContext(client, {
      work, impacts: workImpacts, entitlement: entitlementsByEventId.get(work.eventId), snapshot,
    });
    if (prepared.error) {
      await reject(work, prepared.error);
      continue;
    }
    if (digestCanonical({ captures: prepared.captures, provenance }).bytes.length > MAX_WORK_BYTES) {
      await reject(work, "INPUTS_NOT_RETAINED");
      continue;
    }
    const id = crypto.randomUUID();
    pending.push({ id, work, captures: prepared.captures });
  }
  // All accepted work pins its source revisions in the same statement snapshot.
  const roots = pending.length ? await pinFactRoots({ client, revisionHeads: snapshot.heads, requests: pending.flatMap((item) =>
    item.captures.map((capture) => ({
      ownerId: item.id, userIds: capture.userIds,
      rangeStart: capture.rangeStart, rangeEnd: capture.rangeEnd,
    }))) }) : [];
  const accepted = [];
  for (const item of pending) {
    const context = {
      captures: item.captures,
      roots: roots.filter((root) => root.ownerId === item.id),
      provenance: JSON.parse(JSON.stringify(provenance, (_key, value) =>
        typeof value === "bigint" ? String(value) : value)),
    };
    const { bytes, digest } = digestCanonical(context);
    if (bytes.length > MAX_WORK_BYTES) {
      await client.$executeRawUnsafe("DELETE FROM durable_capture_fact_pins WHERE owner_id=$1::uuid", item.id);
      await reject(item.work, "INPUTS_NOT_RETAINED");
      continue;
    }
    await client.$executeRawUnsafe(
      `INSERT INTO durable_global_event_capture_requests
         (id,work_id,user_id,context,context_digest,expires_at)
       VALUES ($1::uuid,$2,$3,$4::jsonb,$5,$6::timestamp)`,
      item.id, item.work.id, item.work.userId, bytes.toString("utf8"), digest, item.work.expiresAt,
    );
    const claimed = await client.globalEventSummaryWork.updateMany({
      where: { id: item.work.id, status: "WAITING_SYNC", leaseToken: null },
      data: {
        status: "QUEUED", ...provenance, requiredRaceCount: item.captures.length,
        leaseToken: parkedToken(item.id), leaseUntil: item.work.expiresAt,
        nextRecoveryAt: item.work.expiresAt, raceReconciledAt: null,
      },
    });
    if (claimed.count !== 1) {
      const error = new Error("capture work changed while pinning immutable inputs");
      error.code = "SUMMARY_CAPTURE_CLOSURE_CHANGED";
      throw error;
    }
    accepted.push(item);
  }
  return accepted.length ? {
    id: accepted[0].work.id, state: "QUEUED", expiresAt: accepted[0].work.expiresAt,
  } : null;
}

async function claimCapture(client) {
  const token = crypto.randomUUID();
  const rows = await client.$queryRawUnsafe(
    `WITH pending AS MATERIALIZED (
       SELECT id FROM durable_global_event_capture_requests
        WHERE status='PENDING' AND available_at <= clock_timestamp()
        ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
     ), abandoned AS MATERIALIZED (
       SELECT id FROM durable_global_event_capture_requests
        WHERE status='PROCESSING' AND lease_until <= clock_timestamp()
        ORDER BY lease_until,id LIMIT 1 FOR UPDATE SKIP LOCKED
     ), candidate AS (
       SELECT r.id FROM durable_global_event_capture_requests r
         WHERE r.id IN (SELECT id FROM pending UNION ALL SELECT id FROM abandoned)
           AND r.expires_at>clock_timestamp()
         ORDER BY CASE WHEN r.status='PENDING' THEN r.available_at ELSE r.lease_until END,r.id LIMIT 1
     )
     UPDATE durable_global_event_capture_requests r
        SET status='PROCESSING',lease_token=$1::uuid,
            lease_until=clock_timestamp()+interval '15 seconds',attempt_count=attempt_count+1
       FROM candidate WHERE r.id=candidate.id RETURNING r.*`, token,
  );
  return rows[0] || null;
}

async function expireCaptures(client, pinBudget = { remaining:128 }) {
  return client.$transaction(async (tx) => {
    const expired = await tx.$queryRawUnsafe(`WITH due AS (
      SELECT id FROM durable_global_event_capture_requests
      WHERE status IN ('PENDING','PROCESSING') AND expires_at<=clock_timestamp()
      ORDER BY expires_at,id LIMIT 32 FOR UPDATE SKIP LOCKED
    ) UPDATE durable_global_event_capture_requests r SET status='EXPIRED',
      completed_at=clock_timestamp(),lease_token=NULL,lease_until=NULL
      FROM due WHERE r.id=due.id RETURNING r.id,r.work_id`);
    for (const request of expired) {
      // Release only this capture's parked lease. The existing summary worker
      // owns the public expiry transition and notification reconciliation.
      await tx.globalEventSummaryWork.updateMany({
        where: { id: request.work_id, status: "QUEUED", leaseToken: parkedToken(request.id) },
        data: { leaseToken: null, leaseUntil: null, nextRecoveryAt: new Date() },
      });
    }
    if (expired.length) await require("./durableCaptureCleanup").releaseTerminalCapturePins(tx,{
      budget:pinBudget,ownerIds:expired.map((request)=>request.id),
    });
    return expired.length;
  });
}

async function drainDurableCapture(client) {
  const { preparedScoringModels } = require("./durablePreparedScoringInputs");
  const { digestCanonical } = require("./globalEventSummaryCapture");
  const { advanceDurableCaptureScore } = require("./durableCaptureStageScoring");
  const pinBudget={ remaining:128 };
  await require("./durableCaptureCleanup").cleanupDurableCaptures(client,{pinBudget});
  const expired = await expireCaptures(client,pinBudget);
  const request = await claimCapture(client);
  if (!request) return { selected: expired, published: 0 };
  try {
    const context = request.context;
    if (digestCanonical(context).digest !== request.context_digest) {
      const error = new Error("capture context digest mismatch");
      error.code = "INPUTS_NOT_RETAINED";
      throw error;
    }
    // Validate ownership without hydrating facts. Interval projections can
    // prove reuse before a changed day needs any immutable preparation.
    const rootIds = [...new Set(context.roots.map((root) => root.id))];
    const [retained] = await client.$queryRawUnsafe(
      `SELECT count(*)::int AS count FROM durable_capture_fact_roots
        WHERE id=ANY($1::uuid[]) AND NOT evicting`, rootIds,
    );
    if (retained.count !== rootIds.length) {
      const error = new Error("Durable capture input owner was deleted or root is missing");
      error.code = "INPUTS_NOT_RETAINED";
      throw error;
    }
    const artifacts = [];
    const scoringBudget = { pages: 16, operations: 64 };
    for (const capture of context.captures) {
      const prepared = await preparedScoringModels({ client, capture, roots: context.roots, budget: scoringBudget });
      let attributionDeltaSteps;
      try {
        const scored = await advanceDurableCaptureScore({ client, requestId: request.id,
          raceId: capture.raceId, leaseToken: request.lease_token, capture,
          models: prepared.models, budget: scoringBudget });
        if (!scored.done) {
          const error = new Error("Durable scoring yielded its bounded arithmetic budget");
          error.code = "CAPTURE_YIELD";
          throw error;
        }
        attributionDeltaSteps = scored.deltaSteps;
      } finally {
        await prepared.persist();
      }
      const payload = {
        schemaVersion: 1, attributionDeltaSteps,
        durableCaptureId: request.id, durableCaptureDigest: request.context_digest,
      };
      artifacts.push({
        workId: request.work_id, eventId: capture.payload.event.id,
        raceId: capture.raceId, userId: request.user_id,
        ...context.provenance,
        sourceScoringInputGeneration: BigInt(context.provenance.sourceScoringInputGeneration),
        payload, payloadDigest: digestCanonical(payload).digest, schemaVersion: 1,
      });
    }
    const published = await client.$transaction(async (tx) => {
      const live = await tx.$queryRawUnsafe(
        `SELECT id FROM durable_global_event_capture_requests
          WHERE id=$1::uuid AND status='PROCESSING' AND lease_token=$2::uuid
            AND lease_until>clock_timestamp() AND expires_at>clock_timestamp()
          FOR UPDATE`, request.id, request.lease_token,
      );
      if (!live.length) return false;
      const work = await tx.$queryRawUnsafe(
        `SELECT id FROM global_event_summary_work WHERE id=$1 AND status='QUEUED'
           AND lease_token=$2 AND expires_at>clock_timestamp() FOR UPDATE`,
        request.work_id, parkedToken(request.id),
      );
      if (!work.length) return false;
      if (artifacts.length) await tx.globalEventCaptureArtifact.createMany({ data: artifacts });
      await tx.globalEventSummaryWork.update({
        where: { id: request.work_id },
        data: { leaseToken: null, leaseUntil: null, availableAt: new Date(), nextRecoveryAt: new Date() },
      });
      await tx.$executeRawUnsafe(
        `UPDATE durable_global_event_capture_requests SET status='COMPLETE',
          completed_at=clock_timestamp(),lease_token=NULL,lease_until=NULL WHERE id=$1::uuid`, request.id,
      );
      return true;
    });
    return { selected: 1, published: Number(published) };
  } catch (error) {
    if (error.code === "CAPTURE_LEASE_LOST") return { selected: 1, published: 0 };
    if (error.code === "CAPTURE_YIELD") {
      await client.$executeRawUnsafe(`UPDATE durable_global_event_capture_requests SET status='PENDING',
        lease_token=NULL,lease_until=NULL,available_at=clock_timestamp()
        WHERE id=$1::uuid AND lease_token=$2::uuid AND status='PROCESSING'`, request.id, request.lease_token);
      return { selected: 1, published: 0 };
    }
    if (error.code === "INPUTS_NOT_RETAINED") {
      const failed = await client.$transaction(async (tx) => {
        const owned = await tx.$queryRawUnsafe(`UPDATE durable_global_event_capture_requests
          SET status='FAILED',completed_at=clock_timestamp(),lease_token=NULL,lease_until=NULL,
            last_error_code='INPUTS_NOT_RETAINED'
          WHERE id=$1::uuid AND lease_token=$2::uuid AND status='PROCESSING'
            AND lease_until>clock_timestamp() AND expires_at>clock_timestamp()
          RETURNING work_id`, request.id, request.lease_token);
        if (!owned.length) return false;
        const work = await tx.globalEventSummaryWork.findUnique({ where: { id: request.work_id } });
        const terminalized = await tx.globalEventSummaryWork.updateMany({
          where: { id: request.work_id, status: "QUEUED", leaseToken: parkedToken(request.id) },
          data: { status: "UNSCORABLE", leaseToken: null, leaseUntil: null,
            lastErrorCode: "INPUTS_NOT_RETAINED", raceReconciledAt: null },
        });
        if (terminalized.count && work) await tx.jobRun.upsert({
          where: { jobName: `global_event_summary:${work.eventId}:${work.userId}:v2` },
          create: { jobName: `global_event_summary:${work.eventId}:${work.userId}:v2`, lastRanFor: "UNSCORABLE" },
          update: {},
        });
        await require("./durableCaptureCleanup").releaseTerminalCapturePins(tx,{budget:pinBudget,ownerIds:[request.id]});
        return true;
      });
      return { selected: 1, published: 0, failed: Number(failed) };
    }
    await client.$executeRawUnsafe(
      `UPDATE durable_global_event_capture_requests SET status='PENDING',
         lease_token=NULL,lease_until=NULL,available_at=clock_timestamp()+interval '1 second',last_error_code=$3
       WHERE id=$1::uuid AND lease_token=$2::uuid AND status='PROCESSING'`,
      request.id, request.lease_token, String(error.code || "CAPTURE_RETRY").slice(0, 128),
    );
    throw error;
  }
}

module.exports = { enqueueDurableCaptures, parkedToken, drainDurableCapture };
