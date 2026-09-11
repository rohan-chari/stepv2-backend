const crypto = require("node:crypto");
const { prisma: defaultPrisma } = require("../../../db");

const RECOVERY_STATUSES = Object.freeze([
  "QUEUED", "PROCESSING", "SUCCEEDED", "RETRY", "FAILED_TERMINAL",
]);
const MAX_RECOVERY_ATTEMPTS = 8;
const RECOVERY_LEASE_MS = 2 * 60 * 1000;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
const BACKOFF_MS = Object.freeze([60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, MAX_BACKOFF_MS]);
const AUTOMATIC_DISCOVERY_ID = "automatic-v1";
const AUTOMATIC_DISCOVERY_INTERVAL_MS = 1_000;
const DISCOVERY_ACTIVE_LIMIT = 500;
// No due-time predicate: future retries and live leases still consume capacity.
// Each partial index feeds its own LIMIT in the same statement snapshot.
const DISCOVERY_CAPACITY_CTES = `WITH active_due AS MATERIALIZED (
  SELECT id FROM domain_event_receipt_recovery
   WHERE status IN ('QUEUED','RETRY') ORDER BY available_at,id LIMIT 500
), active_leased AS MATERIALIZED (
  SELECT id FROM domain_event_receipt_recovery
   WHERE status='PROCESSING' ORDER BY lease_until,id LIMIT 500
)`;
const DISCOVERY_HAS_CAPACITY = `((SELECT COUNT(*) FROM active_due) +
  (SELECT COUNT(*) FROM active_leased)) < ${DISCOVERY_ACTIVE_LIMIT}`;

function boundedLimit(value, fallback = 100, maximum = 500) {
  return Math.min(maximum, Math.max(1, Number(value) || fallback));
}

function safeErrorCode(value, fallback = "RECOVERY_ERROR") {
  const code = String(value || fallback).toUpperCase().replace(/[^A-Z0-9_.:-]/g, "_");
  return code.slice(0, 128) || fallback;
}

function retryDelayMs(attemptCount, random = Math.random) {
  const index = Math.min(BACKOFF_MS.length - 1, Math.max(0, Number(attemptCount) - 1));
  const base = Math.min(MAX_BACKOFF_MS, BACKOFF_MS[index]);
  // Bounded +/-10% jitter avoids a synchronized historical drain while
  // keeping the retry horizon predictable for operators.
  const jitter = Math.max(0, Math.min(1, Number(random()) || 0)) * 0.2 - 0.1;
  return Math.min(MAX_BACKOFF_MS, Math.max(1_000, Math.round(base * (1 + jitter))));
}

function buildDomainEventReceiptRecoveryModel(prisma = defaultPrisma) {
  async function discoveryTransaction(client, work) {
    const operation = async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout='250ms'");
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout='2s'");
      return work(tx);
    };
    return typeof client.$transaction === "function"
      ? client.$transaction(operation, { timeout: 5_000, maxWait: 2_000 }) : operation(client);
  }

  async function lockAutomaticDiscovery(tx) {
    const lock = () => tx.$queryRawUnsafe(`SELECT * FROM domain_event_receipt_discovery
      WHERE id=$1 FOR UPDATE`, AUTOMATIC_DISCOVERY_ID);
    let [state] = await lock();
    if (state) return state;
    // The new cutoff cannot inherit manual history: that history can predate
    // trigger installation. Verify coverage and indexes before stamping it.
    const [ready] = await tx.$queryRawUnsafe(`SELECT
      EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='domain_event_outbox'::regclass
        AND tgname='domain_event_receipt_recovery_compat_trigger'
        AND tgenabled IN ('O','A') AND tgdeferrable AND tginitdeferred) AND
      EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='domain_event_outbox'::regclass
        AND tgname='domain_event_outbox_legacy_receipt_trigger' AND tgenabled IN ('O','A')) AND
      (SELECT COUNT(*) FROM pg_index WHERE indisvalid AND indisready AND indexrelid IN (
        to_regclass('domain_event_outbox_created_at_id_receipt_recovery_idx'),
        to_regclass('domain_event_receipt_recovery_due_idx'),
        to_regclass('domain_event_receipt_recovery_lease_idx'),
        to_regclass('domain_event_receipt_recovery_fresh_due_idx'),
        to_regclass('domain_event_receipts_domain_event_id_key'))) = 5 AS ready`);
    if (!ready?.ready) throw new Error("Receipt discovery requires all migrations and enabled compatibility triggers");
    await tx.$executeRawUnsafe(`INSERT INTO domain_event_receipt_discovery(id,cutoff)
      VALUES ($1,(clock_timestamp() AT TIME ZONE 'UTC')) ON CONFLICT(id) DO NOTHING`, AUTOMATIC_DISCOVERY_ID);
    [state] = await lock();
    return state;
  }

  async function hasDiscoveryCapacity(tx) {
    const [result] = await tx.$queryRawUnsafe(`${DISCOVERY_CAPACITY_CTES}
      SELECT ${DISCOVERY_HAS_CAPACITY} AS capacity`);
    return result.capacity;
  }

  function emptyPage({ cutoff, cursor = null, deferred = false, exhausted = false }) {
    return { scanned: 0, discovered: 0, nextCursor: cursor, deferred, cutoff, exhausted };
  }

  // Private: every caller holds automatic-v1 and has passed admission. Keep
  // source paging ahead of the receipt lookup even when most receipts are FINAL.
  async function discoverAdmittedPage(tx, { cutoff, cursor = null, limit = 500, reason = "LEGACY_MISSING" }) {
    const pageSize = boundedLimit(limit, 500);
    const rows = await tx.$queryRawUnsafe(
      `WITH source_page AS MATERIALIZED (
         SELECT event.id,event.event_key,event.created_at
           FROM domain_event_outbox event
          WHERE event.created_at <= $1
            AND (event.created_at,event.id) > ($2,$3::uuid)
          ORDER BY event.created_at,event.id LIMIT $4
          FOR UPDATE OF event
       )
       SELECT event.id AS "domainEventId", event.event_key AS "eventKey",
              event.created_at AS "createdAt",receipt.receipt_state AS "receiptState"
         FROM source_page event
         LEFT JOIN LATERAL (
           SELECT receipt_state FROM domain_event_receipts
            WHERE domain_event_id=event.id LIMIT 1
         ) receipt ON true
        ORDER BY event.created_at,event.id`,
      cutoff, cursor?.createdAt || new Date(0), cursor?.id || "00000000-0000-0000-0000-000000000000", pageSize,
    );
    if (!rows.length) return emptyPage({ cutoff, cursor, exhausted: true });
    const candidates = rows.filter((row) => row.receiptState == null || row.receiptState === "PROVISIONAL");
    if (candidates.length) await tx.domainEventReceiptRecovery.createMany({
      data: candidates.map((row) => ({
        domainEventId: row.domainEventId,
        eventKey: row.eventKey,
        reason: safeErrorCode(row.receiptState === "PROVISIONAL" ? "LEGACY_PROVISIONAL" : reason),
        status: "QUEUED",
        attemptCount: 0,
        availableAt: new Date(),
      })),
      skipDuplicates: true,
    });
    const last = rows.at(-1);
    return {
      scanned: rows.length,
      discovered: candidates.length,
      nextCursor: { createdAt: new Date(last.createdAt), id: last.domainEventId },
      deferred: false, cutoff, exhausted: rows.length < pageSize,
    };
  }

  async function discoverCheckpointPage(tx, state, limit) {
    const cursor = state.cursor_id ? { createdAt: state.cursor_created_at, id: state.cursor_id } : null;
    if (state.completed_at) return emptyPage({ cutoff: state.cutoff, cursor, exhausted: true });
    if (!await hasDiscoveryCapacity(tx)) return emptyPage({ cutoff: state.cutoff, cursor, deferred: true });
    const page = await discoverAdmittedPage(tx, { cutoff: state.cutoff, cursor, limit });
    // Candidate inserts and progress have exactly one commit boundary. A failed
    // statement or lock timeout must never skip the source page on retry.
    await tx.$executeRawUnsafe(`UPDATE domain_event_receipt_discovery SET
      cursor_created_at=$1,cursor_id=$2::uuid,scanned=scanned+$3,discovered=discovered+$4,
      completed_at=CASE WHEN $5 THEN (clock_timestamp() AT TIME ZONE 'UTC') ELSE NULL END,
      updated_at=(clock_timestamp() AT TIME ZONE 'UTC') WHERE id=$6`,
    page.nextCursor?.createdAt || null, page.nextCursor?.id || null,
    page.scanned, page.discovered, page.exhausted, state.id);
    return page;
  }

  const model = {
    async enqueue({ domainEventId, eventKey, reason, availableAt = new Date() }, tx = prisma) {
      if (!domainEventId || !eventKey || !reason) throw new TypeError("recovery candidate identity and reason are required");
      await tx.domainEventReceiptRecovery.createMany({
        data: [{
          domainEventId,
          eventKey,
          reason: safeErrorCode(reason),
          status: "QUEUED",
          attemptCount: 0,
          availableAt,
        }],
        skipDuplicates: true,
      });
      return tx.domainEventReceiptRecovery.findUnique({ where: { eventKey } });
    },

    async discoverPage({ cutoff, cursor = null, limit = 500, reason = "LEGACY_MISSING" } = {}, tx = prisma) {
      if (!(cutoff instanceof Date) || Number.isNaN(cutoff.getTime())) throw new TypeError("cutoff is required");
      return discoveryTransaction(tx, async (client) => {
        await lockAutomaticDiscovery(client);
        if (!await hasDiscoveryCapacity(client)) return emptyPage({ cutoff, cursor, deferred: true });
        return discoverAdmittedPage(client, { cutoff, cursor, limit, reason });
      });
    },

    async discoverNextPage({ cutoff, limit = 500 } = {}) {
      if (!(cutoff instanceof Date) || Number.isNaN(cutoff.getTime())) throw new TypeError("cutoff is required");
      return discoveryTransaction(prisma, async (tx) => {
        await lockAutomaticDiscovery(tx);
        await tx.$executeRawUnsafe(`INSERT INTO domain_event_receipt_discovery(id,cutoff)
          VALUES ('historical-v1',$1) ON CONFLICT(id) DO NOTHING`, cutoff);
        const [state] = await tx.$queryRawUnsafe(`SELECT * FROM domain_event_receipt_discovery
          WHERE id='historical-v1' FOR UPDATE`);
        return discoverCheckpointPage(tx, state, limit);
      });
    },

    async discoverAutomaticPage({ limit = 500 } = {}) {
      return discoveryTransaction(prisma, async (tx) => {
        const state = await lockAutomaticDiscovery(tx);
        return discoverCheckpointPage(tx, state, limit);
      });
    },

    async automaticDiscoveryDueAt({ now = new Date() } = {}) {
      return discoveryTransaction(prisma, async (tx) => {
        const [result] = await tx.$queryRawUnsafe(`${DISCOVERY_CAPACITY_CTES}
          SELECT CASE WHEN EXISTS (SELECT 1 FROM domain_event_receipt_discovery
            WHERE id=$1 AND completed_at IS NOT NULL) THEN false
            ELSE ${DISCOVERY_HAS_CAPACITY} END AS capacity`, AUTOMATIC_DISCOVERY_ID);
        return result.capacity ? new Date(now.getTime() + AUTOMATIC_DISCOVERY_INTERVAL_MS) : null;
      });
    },

    async claimPage({ now = new Date(), limit = 100, leaseMs = RECOVERY_LEASE_MS } = {}, client = prisma) {
      const pageSize = boundedLimit(limit, 100);
      const token = crypto.randomUUID();
      const leaseUntil = new Date(now.getTime() + Math.max(1_000, Number(leaseMs) || RECOVERY_LEASE_MS));
      return client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout='2s'");
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout='250ms'");
        const terminalized = await tx.$executeRawUnsafe(
          `WITH expired AS MATERIALIZED (
             SELECT id FROM domain_event_receipt_recovery
             WHERE status='PROCESSING' AND lease_until <= $1 AND attempt_count >= $2
             ORDER BY lease_until,id LIMIT $3 FOR UPDATE SKIP LOCKED
           ) UPDATE domain_event_receipt_recovery
              SET status='FAILED_TERMINAL',last_error_code='MAX_ATTEMPTS',
                  last_error_at=$1,completed_at=$1,lease_until=NULL,lease_token=NULL,updated_at=$1
            WHERE id IN (SELECT id FROM expired)`,
          now, MAX_RECOVERY_ATTEMPTS, pageSize,
        );
        const rows = await tx.$queryRawUnsafe(
          `WITH fresh AS MATERIALIZED (
             SELECT id FROM domain_event_receipt_recovery
              WHERE status IN ('QUEUED','RETRY') AND available_at <= $1
                AND reason NOT LIKE 'LEGACY_%' AND attempt_count < $2
              ORDER BY available_at,id LIMIT GREATEST(1,($3::int+4)/5)
              FOR UPDATE SKIP LOCKED
           ), due AS MATERIALIZED (
             SELECT id,available_at AS due_at
               FROM domain_event_receipt_recovery
              WHERE status IN ('QUEUED','RETRY') AND available_at <= $1
                AND attempt_count < $2
                AND id NOT IN (SELECT id FROM fresh)
              ORDER BY available_at,id
              LIMIT $3
              FOR UPDATE SKIP LOCKED
           ), expired AS MATERIALIZED (
             SELECT id,lease_until AS due_at FROM domain_event_receipt_recovery
              WHERE status='PROCESSING' AND lease_until <= $1 AND attempt_count < $2
              ORDER BY lease_until,id LIMIT $3 FOR UPDATE SKIP LOCKED
           ), remaining AS (
             SELECT id FROM (SELECT * FROM due UNION ALL SELECT * FROM expired) bounded
             ORDER BY due_at,id LIMIT ($3::int-(SELECT COUNT(*) FROM fresh))
           ), candidates AS (
             SELECT id FROM fresh UNION ALL SELECT id FROM remaining
           )
           UPDATE domain_event_receipt_recovery candidate
              SET status='PROCESSING',attempt_count=attempt_count+1,
                  lease_until=$4,lease_token=$5,updated_at=$1
             FROM candidates
            WHERE candidate.id=candidates.id
         RETURNING candidate.id,candidate.domain_event_id AS "domainEventId",
                   candidate.created_at AS "createdAt",
                   candidate.event_key AS "eventKey",candidate.reason,
                   candidate.attempt_count AS "attemptCount",candidate.lease_token AS "leaseToken"`,
          now, MAX_RECOVERY_ATTEMPTS, pageSize, leaseUntil, token,
        );
        return { rows, token, terminalized: Number(terminalized || 0) };
      });
    },

    async completeSuccess({ id, leaseToken, now = new Date() }, client = prisma) {
      const result = await client.domainEventReceiptRecovery.updateMany({
        where: {
          id, status: "PROCESSING", leaseToken,
          leaseUntil: { gt: now },
        },
        data: {
          status: "SUCCEEDED", leaseUntil: null, leaseToken: null,
          lastErrorCode: null, lastErrorAt: null, completedAt: now, updatedAt: now,
        },
      });
      return result.count === 1;
    },

    async completeFailure({ id, leaseToken, errorCode, now = new Date(), retryable = true, random = Math.random }, client = prisma) {
      const code = safeErrorCode(errorCode);
      return client.$transaction(async (tx) => {
        const current = await tx.domainEventReceiptRecovery.findUnique({ where: { id } });
        if (!current || current.status !== "PROCESSING" || current.leaseToken !== leaseToken ||
            !current.leaseUntil || current.leaseUntil <= now) return { applied: false };
        const terminal = !retryable || current.attemptCount >= MAX_RECOVERY_ATTEMPTS;
        const data = terminal ? {
          status: "FAILED_TERMINAL", leaseUntil: null, leaseToken: null,
          lastErrorCode: code, lastErrorAt: now, completedAt: now, updatedAt: now,
        } : {
          status: "RETRY", availableAt: new Date(now.getTime() + retryDelayMs(current.attemptCount, random)),
          leaseUntil: null, leaseToken: null, lastErrorCode: code, lastErrorAt: now, updatedAt: now,
        };
        const result = await tx.domainEventReceiptRecovery.updateMany({
          where: {
            id, status: "PROCESSING", leaseToken,
            leaseUntil: { gt: now },
          },
          data,
        });
        return { applied: result.count === 1, terminal };
      });
    },
  };
  return model;
}

const DomainEventReceiptRecovery = buildDomainEventReceiptRecoveryModel();

module.exports = {
  RECOVERY_STATUSES,
  MAX_RECOVERY_ATTEMPTS,
  RECOVERY_LEASE_MS,
  MAX_BACKOFF_MS,
  BACKOFF_MS,
  AUTOMATIC_DISCOVERY_ID,
  AUTOMATIC_DISCOVERY_INTERVAL_MS,
  DISCOVERY_ACTIVE_LIMIT,
  retryDelayMs,
  safeErrorCode,
  buildDomainEventReceiptRecoveryModel,
  DomainEventReceiptRecovery,
};
