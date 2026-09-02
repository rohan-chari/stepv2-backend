const crypto = require("node:crypto");
const { prisma: defaultPrisma } = require("../../../db");
const { DeviceToken: defaultDeviceToken } = require("../../../shared/push/deviceToken");
const { apnsService: defaultApns } = require("../../../shared/push/apns");
const { fcmService: defaultFcm } = require("../../../shared/push/fcm");
const { appSettings: defaultSettings } = require("../../../shared/config/appSettings");
const { canonicalPushDeliveryKey } = require("../../notifications/pushDeliveryAttribution");
const { notificationIntentService: defaultNotificationIntentService } = require("../../notifications/services/notificationDelivery");
const { invalidateInboxUnreadMany: defaultInvalidateInboxUnreadMany } = require("../services/inbox");
const redisCache = require("../../../shared/cache/redisCache");
const { userFanoutDisabled: defaultUserFanoutDisabled } = require("../../../shared/config/operationalControls");
const {
  ADMISSION_CLASS_GLOBAL_EVENT_STARTED,
  ADMISSION_LEASED,
  ADMISSION_RETRY,
  claimProviderAttemptPage: defaultClaimProviderAttemptPage,
} = require("../../notifications/services/notificationAdmission");
const { eventSurgeTelemetry: defaultEventSurgeTelemetry } = require("../../../shared/observability/eventSurgeTelemetry");

const LEASE_MS = 30_000;
const TICK_INTERVAL_MS = 60_000;
const DEFAULT_BATCH_SIZE = 128;
const DEFAULT_CONCURRENCY = 16;
const DEFAULT_PROVIDER_TIMEOUT_MS = 5_000;
const MAX_TARGETS_PER_RECIPIENT = 10;

async function claimNormalInboxPage({
  prisma = defaultPrisma,
  now = new Date(),
  batchSize = DEFAULT_BATCH_SIZE,
  leaseMs = LEASE_MS,
} = {}) {
  const limit = Math.max(1, Math.min(500, Number(batchSize) || DEFAULT_BATCH_SIZE));
  const leaseToken = crypto.randomUUID();
  const leaseUntil = new Date(now.getTime() + leaseMs);
  const claimed = await prisma.$transaction(async (tx) => tx.$queryRawUnsafe(
    `WITH due_candidates AS MATERIALIZED (
       SELECT id,available_at AS due_at,available_at
         FROM inbox_delivery_outbox
        WHERE status IN ('PENDING','RETRY') AND available_at <= $1
          AND (expires_at IS NULL OR expires_at > $1)
        ORDER BY available_at,id LIMIT $2
     ), recovery_candidates AS MATERIALIZED (
       SELECT id,lease_until AS due_at,available_at
         FROM inbox_delivery_outbox
        WHERE status='LEASED' AND lease_until <= $1
          AND (expires_at IS NULL OR expires_at > $1)
        ORDER BY lease_until,available_at,id LIMIT $2
     ), candidate_ids AS MATERIALIZED (
       SELECT id,due_at,available_at FROM (
         SELECT id,due_at,available_at FROM due_candidates
         UNION ALL
         SELECT id,due_at,available_at FROM recovery_candidates
       ) bounded ORDER BY due_at,available_at,id LIMIT $2
     ), locked AS MATERIALIZED (
       SELECT outbox.id
         FROM inbox_delivery_outbox outbox
         JOIN candidate_ids candidate ON candidate.id=outbox.id
        WHERE (outbox.status IN ('PENDING','RETRY') AND outbox.available_at <= $1
                 AND (outbox.expires_at IS NULL OR outbox.expires_at > $1))
           OR (outbox.status='LEASED' AND outbox.lease_until <= $1
                 AND (outbox.expires_at IS NULL OR outbox.expires_at > $1))
        ORDER BY candidate.due_at,candidate.available_at,outbox.id
        FOR UPDATE OF outbox SKIP LOCKED
     )
     UPDATE inbox_delivery_outbox outbox
        SET status='LEASED',claimed_at=COALESCE(outbox.claimed_at,$1),
            lease_until=$4,lease_token=$3,updated_at=$1
       FROM locked WHERE outbox.id=locked.id
     RETURNING outbox.id`,
    now, limit, leaseToken, leaseUntil,
  ));
  if (!claimed.length) return [];
  const rows = await prisma.inboxDeliveryOutbox.findMany({
    where: { id: { in: claimed.map((row) => row.id) }, status: "LEASED", leaseToken },
    include: { alert: { select: { userId: true, type: true, destination: true, sourceKey: true } } },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return claimed.flatMap((claim) => {
    const row = byId.get(claim.id);
    return row ? [{ ...row, leaseToken }] : [];
  });
}

async function nextInboxDeliveryDueAt(prisma = defaultPrisma) {
  // The outbox row is the durable claim unit and its available_at is updated
  // transactionally to the earliest remaining device-attempt retry. If a
  // worker crashes before that update, the row remains LEASED and lease_until
  // is the only safe recovery boundary. Reading an attempt timestamp without
  // its parent state lets an old retry force a zero-delay loop during that
  // active lease, so exact scheduling intentionally follows the parent lanes.
  const [row = {}] = await prisma.$queryRawUnsafe(
    `SELECT LEAST(
       (SELECT MIN(available_at) FROM inbox_delivery_outbox
         WHERE status IN ('PENDING','RETRY')),
       (SELECT MIN(lease_until) FROM inbox_delivery_outbox
         WHERE status='LEASED'),
       (SELECT MIN(expires_at) FROM inbox_delivery_outbox
         WHERE status IN ('PENDING','RETRY','LEASED') AND expires_at IS NOT NULL),
       (SELECT MIN(available_at) FROM inbox_delivery_outbox
         WHERE admission_class='visible:GLOBAL_EVENT_STARTED' AND status='ADMISSION_FIRST'),
       (SELECT MIN(available_at) FROM inbox_delivery_outbox
         WHERE admission_class='visible:GLOBAL_EVENT_STARTED' AND status='ADMISSION_RETRY'),
       (SELECT MIN(lease_until) FROM inbox_delivery_outbox
         WHERE admission_class='visible:GLOBAL_EVENT_STARTED' AND status='ADMISSION_LEASED'),
       (SELECT MIN(admission_expires_at) FROM inbox_delivery_outbox
         WHERE admission_class='visible:GLOBAL_EVENT_STARTED'
           AND status IN ('ADMISSION_FIRST','ADMISSION_RETRY','ADMISSION_LEASED')
           AND admission_expires_at IS NOT NULL)
     ) AS "dueAt"`,
  );
  return row.dueAt || null;
}
const DEFAULT_PROVIDER_CONCURRENCY = 16;
const DEFAULT_DB_WRITE_CONCURRENCY = 32;

function createSemaphore(limit) {
  let active = 0;
  const waiters = [];
  async function run(work) {
    if (active >= limit) await new Promise((resolve) => waiters.push(resolve));
    active += 1;
    try { return await work(); }
    finally {
      active -= 1;
      waiters.shift()?.();
    }
  }
  return { run, get active() { return active; } };
}

function retryAt(now, attempts, random = Math.random, retryAfterMs = 0) {
  const cap = Math.min(60 * 60_000, 1_000 * 2 ** Math.min(attempts, 10));
  const jitter = Math.floor(Math.max(0, Math.min(1, Number(random()) || 0)) * cap);
  return new Date(now.getTime() + Math.max(0, Number(retryAfterMs) || 0, jitter));
}

// The lane grants one token every 10ms, but opening a database transaction for
// every token creates 100 serialized row locks per second. Let at most 100ms
// accumulate so each durable claim normally carries ten attempts. This keeps
// the exact 100/s provider rate and adds no more than a tenth of a second to
// the two-minute delivery window.
const ADMISSION_MIN_WAKE_MS = 100;

function admissionWakeAt(page, nowMs = Date.now()) {
  if (!page?.hasPending) return null;
  const boundaries = [page.nextTokenAt, page.nextAvailableAt]
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite);
  return boundaries.length
    ? new Date(Math.max(...boundaries, Number(nowMs) + ADMISSION_MIN_WAKE_MS))
    : null;
}

function pushPayload(alert, storedPayload = null) {
  if (storedPayload && typeof storedPayload === "object" && !Array.isArray(storedPayload)) {
    return storedPayload;
  }
  const destination = alert.destination || {};
  if (alert.type === "PRIVATE_RACE_JOIN_APPROVAL" &&
      destination.route === "raceJoinRequest") {
    return {
      type: alert.type,
      destination: "RACE_JOIN_REQUEST",
      raceId: destination.raceId,
      requestId: destination.requestId,
      destinationDetails: destination,
      route: "race_join_request",
      params: {
        raceId: destination.raceId,
        requestId: destination.requestId,
      },
    };
  }
  if (alert.type === "PRIVATE_RACE_JOIN_RESULT" &&
      destination.route === "raceDetail") {
    return {
      type: alert.type,
      destination: "RACE",
      raceId: destination.raceId,
      requestId: destination.requestId,
      status: destination.status,
      destinationDetails: destination,
      route: "race_detail",
      params: {
        raceId: destination.raceId,
        ...(destination.requestId ? { requestId: destination.requestId } : {}),
        ...(destination.status ? { status: destination.status } : {}),
      },
    };
  }
  const payload = { type: alert.type, destination };
  if (destination.route === "raceDetail") {
    payload.route = "race_detail";
    payload.params = {
      raceId: destination.raceId,
      ...(destination.requestId ? { requestId: destination.requestId } : {}),
      ...(destination.status ? { status: destination.status } : {}),
    };
  } else if (destination.route === "raceJoinRequest") {
    payload.route = "race_join_request";
    payload.params = {
      raceId: destination.raceId,
      requestId: destination.requestId,
    };
  } else if (destination.route === "tournamentDetail") {
    payload.route = "tournament_detail";
    payload.params = { tournamentId: destination.tournamentId };
  } else if (destination.route === "friends") payload.route = "friends";
  else if (destination.route === "dailyReward") payload.route = "daily_reward";
  else if (destination.route === "supportThread") {
    payload.route = "support_thread";
    payload.params = { threadId: destination.threadId };
  } else payload.route = "home";
  return payload;
}

function tokenFingerprint(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function targetMatchesCurrentRegistration(target, token, recipientUserId) {
  return Boolean(token) && token.userId === target.recipientUserId &&
    token.userId === recipientUserId &&
    (token.status == null || token.status === "ACTIVE") &&
    token.ownershipGeneration === target.ownershipGeneration &&
    token.installationId === target.installationId &&
    token.platform === target.platform &&
    token.providerEnvironment === target.providerEnvironment &&
    tokenFingerprint(token.token) === target.tokenHash;
}

function eventCollapseId(row) {
  if (row?.alert?.type !== "GLOBAL_EVENT_STARTED") return null;
  return `event:${crypto.createHash("sha256")
    .update(String(row.alert.sourceKey || row.id))
    .digest("hex").slice(0, 40)}`;
}

function runProviderWithDeadline({ semaphore, operation, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let callerSettled = false;
    const settle = (callback, value) => {
      if (callerSettled) return;
      callerSettled = true;
      callback(value);
    };
    // The deadline begins only after this request owns a permit. If it expires,
    // the caller may persist a retry, but semaphore.run deliberately remains
    // pending until the real SDK operation settles, so no hidden request can
    // escape the provider concurrency ceiling.
    let operationResult;
    let operationError;
    semaphore.run(async () => {
      let timer;
      try {
        const providerOperation = Promise.resolve().then(operation);
        timer = setTimeout(() => {
          const error = new Error("notification provider timeout");
          error.code = "PROVIDER_TIMEOUT";
          settle(reject, error);
        }, timeoutMs);
        timer.unref?.();
        try {
          operationResult = await providerOperation;
        } catch (error) {
          operationError = error;
        }
      } finally {
        clearTimeout(timer);
      }
    }).then(
      () => operationError
        ? settle(reject, operationError)
        : settle(resolve, operationResult),
      (error) => settle(reject, error),
    );
  });
}

async function mapWithConcurrency(values, limit, worker) {
  const results = new Array(values.length);
  let cursor = 0;
  async function consume() {
    for (;;) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await worker(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, consume));
  return results;
}

async function persistAdmittedAttemptResultsInTransaction(tx, outcomes) {
  const mutations = outcomes.flatMap((outcome) =>
    outcome?.attemptMutation ? [outcome.attemptMutation] : []);
  const tokenMutations = outcomes.flatMap((outcome) =>
    outcome?.tokenMutation ? [outcome.tokenMutation] : []);
  if (!mutations.length && !tokenMutations.length) return {
    attemptedAttempts: 0, updatedAttempts: 0,
    attemptedTokens: 0, updatedTokens: 0, leaseLost: false,
  };
  const updatedAttempts = mutations.length ? await tx.$executeRawUnsafe(
      `UPDATE inbox_delivery_device_attempts attempt
        SET disposition=input.disposition,
            attempt_count=attempt.attempt_count+input.attempt_increment,
            last_error_code=CASE WHEN input.replace_error THEN input.last_error_code ELSE attempt.last_error_code END,
            accepted_at=COALESCE(input.accepted_at,attempt.accepted_at),
            next_attempt_at=input.next_attempt_at,
            provider_message_id=input.provider_message_id,
            provider_environment=COALESCE(input.provider_environment,attempt.provider_environment),
            provider_responded_at=input.provider_responded_at,
            first_attempted_at=COALESCE(attempt.first_attempted_at,input.first_attempted_at),
            updated_at=input.provider_responded_at
       FROM jsonb_to_recordset($1::jsonb) AS input(
         id text,outbox_id text,lease_token text,disposition text,attempt_increment integer,replace_error boolean,
         last_error_code text,accepted_at timestamp,next_attempt_at timestamp,
         provider_message_id text,provider_environment text,
         provider_responded_at timestamp,first_attempted_at timestamp
       ), inbox_delivery_outbox outbox
      WHERE attempt.id=input.id
        AND attempt.outbox_id=input.outbox_id
        AND outbox.id=input.outbox_id
        AND outbox.status='ADMISSION_LEASED'
        AND outbox.lease_token=input.lease_token
        AND attempt.disposition IN ('PENDING','RETRY','TRANSIENT_FAIL','TIMEOUT')`,
      JSON.stringify(mutations),
    ) : 0;
  let updatedTokens = 0;
  if (tokenMutations.length) {
    updatedTokens = await tx.$executeRawUnsafe(
        `UPDATE device_tokens token
            SET last_provider_accepted_at=CASE WHEN input.invalidate THEN token.last_provider_accepted_at ELSE input.accepted_at END,
                provider_environment=CASE
                  WHEN NOT input.invalidate AND token.provider_environment IS NULL
                    THEN COALESCE(input.provider_environment,token.provider_environment)
                  ELSE token.provider_environment
                END,
                status=CASE WHEN input.invalidate THEN 'INVALIDATED' ELSE token.status END,
                status_reason=CASE WHEN input.invalidate THEN 'PROVIDER_INVALID_TOKEN' ELSE token.status_reason END,
                status_changed_at=CASE WHEN input.invalidate THEN input.mutated_at ELSE token.status_changed_at END,
                updated_at=input.mutated_at
           FROM jsonb_to_recordset($1::jsonb) AS input(
             id text,outbox_id text,attempt_id text,lease_token text,
             ownership_generation integer,accepted_at timestamp,
             provider_environment text,invalidate boolean,mutated_at timestamp
           ), inbox_delivery_device_attempts attempt,
              inbox_delivery_outbox outbox
          WHERE token.id=input.id
            AND token.ownership_generation=input.ownership_generation
            AND attempt.id=input.attempt_id
            AND attempt.outbox_id=input.outbox_id
            AND attempt.device_token_id=token.id
            AND outbox.id=input.outbox_id
            AND outbox.status='ADMISSION_LEASED'
            AND outbox.lease_token=input.lease_token`,
        JSON.stringify(tokenMutations),
      );
  }
  return {
    attemptedAttempts: mutations.length,
    updatedAttempts: Number(updatedAttempts),
    attemptedTokens: tokenMutations.length,
    updatedTokens: Number(updatedTokens),
    leaseLost: Number(updatedAttempts) !== mutations.length ||
      Number(updatedTokens) !== tokenMutations.length,
  };
}

async function persistAdmittedAttemptResults(prisma, outcomes) {
  return prisma.$transaction((tx) =>
    persistAdmittedAttemptResultsInTransaction(tx, outcomes));
}

async function persistAdmittedPageResults(prisma, pageResults, current = new Date()) {
  if (!pageResults.length) return { delivered: 0, retried: 0, leaseLost: 0 };
  return prisma.$transaction(async (tx) => {
    const outcomes = pageResults.flatMap((result) => result.outcomes || []);
    const attempts = await persistAdmittedAttemptResultsInTransaction(tx, outcomes);
    const page = pageResults.map((result) => ({
      outbox_id: result.row.id,
      lease_token: result.row.leaseToken,
      provider_accepted_at: result.providerAccepted
        ? (result.row.providerAcceptedAt || current).toISOString()
        : null,
      accepted_tokens: result.acceptedTokens || [],
      attempted: (result.outcomes || []).length > 0,
      transient_error: (result.outcomes || []).find((outcome) => outcome?.error)?.error?.code || null,
      attribution_delivery_id: result.attributionDeliveryId || null,
      attribution_accepted: result.attributionAccepted === true,
      completed_at: current.toISOString(),
    }));
    const attributable = page.filter((row) => row.attribution_delivery_id && row.attribution_accepted);
    if (attributable.length) {
      await tx.$executeRawUnsafe(
        `UPDATE push_deliveries delivery
            SET open_capable=true,provider_accepted_at=input.completed_at
           FROM jsonb_to_recordset($1::jsonb) AS input(
             outbox_id text,lease_token text,attribution_delivery_id text,
             attribution_accepted boolean,completed_at timestamp
           ), inbox_delivery_outbox outbox
          WHERE delivery.id=input.attribution_delivery_id
            AND delivery.provider_accepted_at IS NULL
            AND input.attribution_accepted=true
            AND outbox.id=input.outbox_id
            AND outbox.status='ADMISSION_LEASED'
            AND outbox.lease_token=input.lease_token`,
        JSON.stringify(attributable),
      );
    }
    const finalized = await tx.$queryRawUnsafe(
      `WITH input AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS value(
           outbox_id text,lease_token text,provider_accepted_at timestamp,
           accepted_tokens jsonb,attempted boolean,transient_error text,
           attribution_delivery_id text,attribution_accepted boolean,completed_at timestamp
         )
       ), remaining AS (
         SELECT input.outbox_id,input.lease_token,input.provider_accepted_at,
                input.accepted_tokens,input.attempted,input.transient_error,input.completed_at,
                MIN(attempt.next_attempt_at) FILTER (
                  WHERE attempt.disposition IN ('PENDING','RETRY','TRANSIENT_FAIL','TIMEOUT')
                ) AS next_attempt_at,
                COUNT(attempt.id) FILTER (
                  WHERE attempt.disposition IN ('PENDING','RETRY','TRANSIENT_FAIL','TIMEOUT')
                )::int AS remaining_count
           FROM input
           LEFT JOIN inbox_delivery_device_attempts attempt
             ON attempt.outbox_id=input.outbox_id
          GROUP BY input.outbox_id,input.lease_token,input.provider_accepted_at,
                   input.accepted_tokens,input.attempted,input.transient_error,input.completed_at
       )
       UPDATE inbox_delivery_outbox outbox
          SET status=CASE WHEN remaining.remaining_count > 0 THEN 'ADMISSION_RETRY' ELSE 'DELIVERED' END,
              delivered_at=CASE WHEN remaining.remaining_count = 0 THEN remaining.completed_at ELSE outbox.delivered_at END,
              provider_accepted_at=COALESCE(outbox.provider_accepted_at,remaining.provider_accepted_at),
              accepted_tokens=CASE WHEN remaining.provider_accepted_at IS NULL THEN outbox.accepted_tokens
                ELSE remaining.accepted_tokens END,
              attempt_count=outbox.attempt_count+CASE WHEN remaining.attempted THEN 1 ELSE 0 END,
              available_at=CASE WHEN remaining.remaining_count > 0
                THEN COALESCE(remaining.next_attempt_at,remaining.completed_at + interval '250 milliseconds')
                ELSE outbox.available_at END,
              retry_at=CASE WHEN remaining.remaining_count > 0
                THEN COALESCE(remaining.next_attempt_at,remaining.completed_at + interval '250 milliseconds')
                ELSE NULL END,
              last_error_code=CASE WHEN remaining.remaining_count > 0
                THEN COALESCE(remaining.transient_error,'PROVIDER_RETRYABLE_TARGET') ELSE outbox.last_error_code END,
              lease_until=NULL,lease_token=NULL,updated_at=remaining.completed_at
         FROM remaining
        WHERE outbox.id=remaining.outbox_id
          AND outbox.status='ADMISSION_LEASED'
          AND outbox.lease_token=remaining.lease_token
       RETURNING outbox.id,outbox.status`,
      JSON.stringify(page),
    );
    const rows = Array.isArray(finalized) ? finalized : [];
    return {
      delivered: rows.filter((row) => row.status === "DELIVERED").length,
      retried: rows.filter((row) => row.status === ADMISSION_RETRY).length,
      leaseLost: page.length - rows.length + (attempts.leaseLost ? 1 : 0),
    };
  });
}

async function upsertAdmittedPushDelivery(prisma, {
  outboxId,
  leaseToken,
  deliveryKey,
  userId,
  notificationType,
  createdAt,
}) {
  const [delivery] = await prisma.$queryRawUnsafe(
    `WITH owned AS (
       SELECT id FROM inbox_delivery_outbox
        WHERE id=$1 AND status='ADMISSION_LEASED' AND lease_token=$2
        FOR UPDATE
     ), saved AS (
       INSERT INTO push_deliveries (
         id,public_id,delivery_key,user_id,notification_type,open_capable,created_at
       )
       SELECT $4,$5,$3,$6,$7,false,$8 FROM owned
       ON CONFLICT (delivery_key) DO UPDATE
         SET delivery_key=EXCLUDED.delivery_key
       RETURNING id,public_id AS "publicId",delivery_key AS "deliveryKey",
                 user_id AS "userId",notification_type AS "notificationType",
                 open_capable AS "openCapable",created_at AS "createdAt",
                 provider_accepted_at AS "providerAcceptedAt",opened_at AS "openedAt"
     )
     SELECT * FROM saved`,
    outboxId, leaseToken, deliveryKey, crypto.randomUUID(), crypto.randomUUID(),
    userId, notificationType, createdAt,
  );
  return delivery || null;
}

function buildInboxDelivery(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const deviceTokens = dependencies.DeviceToken || defaultDeviceToken;
  const apns = dependencies.apnsService || defaultApns;
  const fcm = dependencies.fcmService || defaultFcm;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;
  const random = dependencies.random || Math.random;
  const batchSize = Math.max(1, Number(dependencies.batchSize) || DEFAULT_BATCH_SIZE);
  const concurrency = Math.max(1, Math.min(DEFAULT_CONCURRENCY, Number(dependencies.concurrency) || DEFAULT_CONCURRENCY));
  const providerTimeoutMs = Math.max(1, Number(dependencies.providerTimeoutMs) || DEFAULT_PROVIDER_TIMEOUT_MS);
  const settings = dependencies.appSettings || defaultSettings;
  const userFanoutDisabled = dependencies.userFanoutDisabled || defaultUserFanoutDisabled;
  const apnsSemaphore = dependencies.apnsSemaphore || createSemaphore(DEFAULT_PROVIDER_CONCURRENCY);
  const fcmSemaphore = dependencies.fcmSemaphore || createSemaphore(DEFAULT_PROVIDER_CONCURRENCY);
  const dbWriteSemaphore = dependencies.dbWriteSemaphore || createSemaphore(DEFAULT_DB_WRITE_CONCURRENCY);
  const claimProviderAttemptPage = dependencies.claimProviderAttemptPage || defaultClaimProviderAttemptPage;
  const eventSurgeTelemetry = dependencies.eventSurgeTelemetry || defaultEventSurgeTelemetry;
  const invalidateInboxUnreadMany = dependencies.invalidateInboxUnreadMany || defaultInvalidateInboxUnreadMany;
  const beforePushAttribution = dependencies.beforePushAttribution || null;
  let activeMetricsEpochPromise = null;

  function activeMetricsEpochForTick() {
    if (!activeMetricsEpochPromise) {
      activeMetricsEpochPromise = Promise.resolve()
        .then(() => settings.getFlag("adminMetricsV2TelemetryEnabled"))
        .then((enabled) => enabled === true
          ? prisma.adminMetricsCollectionEpoch.findFirst({
              where: { endedAt: null },
              orderBy: { startedAt: "desc" },
            })
          : null);
    }
    return activeMetricsEpochPromise;
  }

  async function renewLease(rowId, leaseToken, leaseUntil, leaseStatus = "LEASED") {
    const renewed = await prisma.inboxDeliveryOutbox.updateMany({
      where: { id: rowId, status: leaseStatus, leaseToken },
      data: { leaseUntil },
    });
    return renewed.count === 1;
  }

  async function deliverRow(row, leaseToken, current, { deferAdmittedPersistence = false } = {}) {
    const admitted = row.admissionClass === ADMISSION_CLASS_GLOBAL_EVENT_STARTED;
    const leaseStatus = admitted ? ADMISSION_LEASED : "LEASED";
    const retryStatus = admitted ? ADMISSION_RETRY : "RETRY";
    let leaseLost = false;
    // Admitted rows are already bounded by the provider deadline and claimed
    // in a page with a 30-second lease. A timer per recipient turns database
    // pressure into a positive feedback loop: delayed finalizers all wake at
    // once, update the same outboxes being finalized, and can deadlock. Legacy
    // rows retain renewal because their provider path is not admission-bounded.
    const renewal = admitted ? null : setInterval(async () => {
      try {
        const renewed = await renewLease(row.id, leaseToken, new Date(now().getTime() + LEASE_MS), leaseStatus);
        if (!renewed) leaseLost = true;
      } catch (error) {
        logger.error("inbox delivery lease renewal failed", { outboxId: row.id, error: error?.message || String(error) });
      }
    }, Math.max(1_000, Math.floor(LEASE_MS / 3)));
    renewal?.unref?.();

    try {
      const targetAware = typeof prisma.inboxDeliveryDeviceAttempt?.findMany === "function";
      const targets = targetAware
        ? Array.isArray(row.deviceAttempts)
          ? row.deviceAttempts
          : await prisma.inboxDeliveryDeviceAttempt.findMany({
            where: {
              outboxId: row.id,
              disposition: { in: ["PENDING", "RETRY", "TRANSIENT_FAIL", "TIMEOUT"] },
              OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: current } }],
            },
            orderBy: { id: "asc" },
          })
        : [];
      const tokens = targetAware
        ? []
        : await deviceTokens.findByUserId(row.alert.userId);
      const hydratedTargetTokens = targets
        .map((target) => target.deviceToken)
        .filter(Boolean);
      const targetTokenRows = targetAware && targets.length
        ? hydratedTargetTokens.length === targets.filter((target) => target.deviceTokenId).length
          ? hydratedTargetTokens
          : await prisma.deviceToken.findMany({
            where: { id: { in: targets.map((target) => target.deviceTokenId).filter(Boolean) } },
          })
        : [];
      const targetTokenById = new Map(targetTokenRows.map((token) => [token.id, token]));
      const attributionTokens = targetAware
        ? targets.flatMap((target) => {
            const token = targetTokenById.get(target.deviceTokenId);
            return targetMatchesCurrentRegistration(target, token, row.alert.userId)
              ? [token]
              : [];
          })
        : tokens;
      const accepted = new Set(Array.isArray(row.acceptedTokens) ? row.acceptedTokens : []);
      const payload = pushPayload(row.alert, row.payload?.payload);
      let transientFailure = false;
      let providerAccepted = false;

      if (!targetAware && (!tokens || tokens.length === 0)) {
        if (prisma.inboxDeliveryDeviceAttempt) {
          await prisma.inboxDeliveryDeviceAttempt.upsert({
            where: { outboxId_tokenHash: { outboxId: row.id, tokenHash: "__NO_DEVICE__" } },
            update: { disposition: "NO_DEVICE", attemptCount: { increment: 1 } },
            create: { outboxId: row.id, tokenHash: "__NO_DEVICE__", disposition: "NO_DEVICE", attemptCount: 1 },
          });
        }
      }

      let attribution = null;
      let deliveryEpochId = null;
      {
        const epoch = await activeMetricsEpochForTick();
        const user = row.alert.user ||
          (epoch ? await prisma.user.findUnique({ where: { id: row.alert.userId } }) : null);
        if (epoch && user && user.isReviewAccount !== true && (attributionTokens || []).some((token) =>
          token.platform === "ios" && token.adminMetricsOpenCapable === true && token.adminMetricsOpenEpochId === epoch.id)) {
          const deliveryKey = row.alert.sourceKey?.startsWith("visible:")
            ? row.alert.sourceKey
            : canonicalPushDeliveryKey(row.alert.type, row.alert.userId, row.alert.sourceKey || row.id);
          await beforePushAttribution?.({ outboxId: row.id, leaseToken, admitted });
          const delivery = admitted
            ? await upsertAdmittedPushDelivery(prisma, {
                outboxId: row.id,
                leaseToken,
                deliveryKey,
                userId: row.alert.userId,
                notificationType: row.alert.type,
                createdAt: now(),
              })
            : await prisma.pushDelivery.upsert({
                where: { deliveryKey }, update: {},
                create: { publicId: crypto.randomUUID(), deliveryKey, userId: row.alert.userId, notificationType: row.alert.type, openCapable: false },
              });
          if (!delivery) leaseLost = true;
          deliveryEpochId = epoch.id;
          if (delivery) {
            attribution = { delivery, payload: { ...payload, notificationId: delivery.publicId }, epochId: epoch.id };
          }
        }
      }
      if (leaseLost) return { state: "LOST_LEASE" };
      const sendPayload = attribution?.payload || payload;

      const deliveryItems = targetAware ? targets : (tokens || []);
      const outcomes = await mapWithConcurrency(deliveryItems, Math.min(concurrency, MAX_TARGETS_PER_RECIPIENT), async (item) => {
        let token = item;
        if (targetAware) {
          token = item.deviceTokenId ? targetTokenById.get(item.deviceTokenId) : null;
          let terminal = null;
          if (!token) terminal = "SUPERSEDED";
          else if (token.userId !== item.recipientUserId || token.userId !== row.alert.userId) terminal = "OWNERSHIP_CHANGED";
          else if (token.status === "INVALIDATED") terminal = "INVALID";
          else if (token.status === "QUARANTINED") terminal = "QUARANTINED";
          else if (token.status === "SUPERSEDED") terminal = "SUPERSEDED";
          else if (token.status != null && token.status !== "ACTIVE") terminal = "SUPERSEDED";
          else if (token.ownershipGeneration !== item.ownershipGeneration ||
              token.installationId !== item.installationId ||
              token.platform !== item.platform ||
              token.providerEnvironment !== item.providerEnvironment ||
              tokenFingerprint(token.token) !== item.tokenHash) terminal = "SUPERSEDED";
          if (terminal) {
            if (admitted) {
              const respondedAt = now();
              return {
                terminal: true,
                disposition: terminal,
                attemptMutation: {
                  id: item.id,
                  outbox_id: row.id,
                  lease_token: leaseToken,
                  disposition: terminal,
                  attempt_increment: 0,
                  replace_error: false,
                  last_error_code: null,
                  accepted_at: null,
                  next_attempt_at: null,
                  provider_message_id: null,
                  provider_environment: item.providerEnvironment,
                  provider_responded_at: respondedAt.toISOString(),
                  first_attempted_at: null,
                },
              };
            }
            await prisma.inboxDeliveryDeviceAttempt.updateMany({
              where: { id: item.id, disposition: { in: ["PENDING", "RETRY", "TRANSIENT_FAIL", "TIMEOUT"] } },
              data: { disposition: terminal, nextAttemptAt: null, providerRespondedAt: now() },
            });
            return { terminal: true, disposition: terminal };
          }
        }
        const fingerprint = targetAware ? item.tokenHash : tokenFingerprint(token.token);
        if (accepted.has(fingerprint)) return { accepted: true, skipped: true };
        const record = async (disposition, lastErrorCode = null, providerResult = null, attemptedAt = null) => {
          if (!prisma.inboxDeliveryDeviceAttempt) return null;
          if (targetAware) {
            const retryable = ["TRANSIENT_FAIL", "TIMEOUT"].includes(disposition);
            const proposedRetry = retryable
              ? retryAt(now(), item.attemptCount + 1, random, providerResult?.retryAfterMs)
              : null;
            const expired = proposedRetry && row.expiresAt && proposedRetry >= new Date(row.expiresAt);
            const attemptsExhausted = retryable && item.attemptCount + 1 >= 8;
            const effectiveDisposition = expired || attemptsExhausted ? "EXHAUSTED" : disposition;
            if (admitted) {
              const respondedAt = now();
              return {
                id: item.id,
                disposition: effectiveDisposition,
                attemptCount: item.attemptCount + 1,
                attemptMutation: {
                  id: item.id,
                  outbox_id: row.id,
                  lease_token: leaseToken,
                  disposition: effectiveDisposition,
                  attempt_increment: 1,
                  replace_error: true,
                  last_error_code: lastErrorCode,
                  accepted_at: effectiveDisposition === "ACCEPTED" ? respondedAt.toISOString() : null,
                  next_attempt_at: retryable && !expired && !attemptsExhausted
                    ? proposedRetry.toISOString()
                    : null,
                  provider_message_id: providerResult?.providerMessageId || null,
                  provider_environment: providerResult?.environment ?? item.providerEnvironment,
                  provider_responded_at: respondedAt.toISOString(),
                  first_attempted_at: item.firstAttemptedAt == null
                    ? (attemptedAt || respondedAt).toISOString()
                    : null,
                },
              };
            }
            return dbWriteSemaphore.run(() => prisma.inboxDeliveryDeviceAttempt.update({
              where: { id: item.id },
              data: {
                disposition: effectiveDisposition,
                attemptCount: { increment: 1 },
                lastErrorCode,
                acceptedAt: effectiveDisposition === "ACCEPTED" ? now() : undefined,
                nextAttemptAt: retryable && !expired ? proposedRetry : null,
                providerMessageId: providerResult?.providerMessageId || null,
                providerEnvironment: providerResult?.environment ?? item.providerEnvironment,
                providerRespondedAt: now(),
              },
            }));
          }
          return prisma.inboxDeliveryDeviceAttempt.upsert({
            where: { outboxId_tokenHash: { outboxId: row.id, tokenHash: fingerprint } },
            update: {
              disposition,
              attemptCount: { increment: 1 },
              lastErrorCode,
              acceptedAt: disposition === "ACCEPTED" ? now() : undefined,
            },
            create: {
              outboxId: row.id,
              tokenHash: fingerprint,
              disposition,
              lastErrorCode,
              acceptedAt: disposition === "ACCEPTED" ? now() : null,
            },
          });
        };
        const firstAttemptedAt = now();
        try {
          const provider = token.platform === "android" ? fcm : apns;
          const providerSemaphore = token.platform === "android" ? fcmSemaphore : apnsSemaphore;
          const providerOperation = runProviderWithDeadline({
            semaphore: providerSemaphore,
            timeoutMs: providerTimeoutMs,
            operation: () => provider.sendNotification({
              deviceToken: token.token,
              title: row.payload.title,
              body: row.payload.body,
              payload: sendPayload,
              expiresAt: row.expiresAt,
              expectedEnvironment: token.providerEnvironment || null,
              ...((sendPayload.collapseId || eventCollapseId(row))
                ? { collapseId: sendPayload.collapseId || eventCollapseId(row) }
                : {}),
              ...(sendPayload.threadId ? { threadId: sendPayload.threadId } : {}),
            }),
          });
          const result = targetAware && !admitted && item.firstAttemptedAt == null
            ? await Promise.all([
                providerOperation,
                dbWriteSemaphore.run(() =>
                  prisma.inboxDeliveryDeviceAttempt.updateMany({
                    where: { id: item.id, firstAttemptedAt: null },
                    data: { firstAttemptedAt },
                  })),
              ]).then(([providerResult]) => providerResult)
            : await providerOperation;
          if (result?.success) {
            accepted.add(fingerprint);
            providerAccepted = true;
            const attempt = await record("ACCEPTED", null, result, firstAttemptedAt);
            if (targetAware && !admitted) {
              await prisma.deviceToken.updateMany({
                where: { id: token.id, ownershipGeneration: item.ownershipGeneration },
                data: {
                  lastProviderAcceptedAt: now(),
                  ...(!token.providerEnvironment && result.environment
                    ? { providerEnvironment: result.environment }
                    : {}),
                },
              });
            }
            return {
              accepted: true,
              attributionAccepted: Boolean(attribution?.delivery && token.platform === "ios" &&
                token.adminMetricsOpenCapable === true && token.adminMetricsOpenEpochId === deliveryEpochId),
              attemptMutation: attempt?.attemptMutation,
              tokenMutation: admitted ? {
                id: token.id,
                outbox_id: row.id,
                attempt_id: item.id,
                lease_token: leaseToken,
                ownership_generation: item.ownershipGeneration,
                accepted_at: now().toISOString(),
                provider_environment: result.environment || null,
                invalidate: false,
                mutated_at: now().toISOString(),
              } : null,
            };
          }
          if (result?.unregistered || result?.invalidToken) {
            if (targetAware) {
              if (!admitted) {
                await prisma.deviceToken.updateMany({
                  where: { id: token.id, ownershipGeneration: item.ownershipGeneration },
                  data: {
                    status: "INVALIDATED",
                    statusReason: "PROVIDER_INVALID_TOKEN",
                    statusChangedAt: now(),
                  },
                });
              }
            } else await deviceTokens.deleteToken({ userId: row.alert.userId, token: token.token });
            const attempt = await record(targetAware ? "INVALID" : "UNREGISTERED", result?.reason || null, result, firstAttemptedAt);
            return {
              unregistered: true,
              terminal: true,
              attemptMutation: attempt?.attemptMutation,
              tokenMutation: admitted ? {
                id: token.id,
                outbox_id: row.id,
                attempt_id: item.id,
                lease_token: leaseToken,
                ownership_generation: item.ownershipGeneration,
                accepted_at: null,
                provider_environment: null,
                invalidate: true,
                mutated_at: now().toISOString(),
              } : null,
            };
          }
          const permanent = result?.permanent === true;
          const attempt = await record(permanent ? "PERMANENT_FAIL" : "TRANSIENT_FAIL", result?.reason || null, result, firstAttemptedAt);
          const exhausted = !permanent && attempt &&
            (attempt.disposition === "EXHAUSTED" || attempt.attemptCount >= 8);
          if (exhausted && attempt.disposition !== "EXHAUSTED") {
            await prisma.inboxDeliveryDeviceAttempt.update({
              where: { id: attempt.id },
              data: { disposition: "EXHAUSTED", nextAttemptAt: null, lastErrorCode: result?.reason || "RETRY_EXHAUSTED" },
            });
          }
          return {
            failed: !permanent && !exhausted,
            terminal: permanent || exhausted,
            attemptMutation: attempt?.attemptMutation,
          };
        } catch (error) {
          const attempt = await record(error?.code === "PROVIDER_TIMEOUT" ? "TIMEOUT" : "TRANSIENT_FAIL", error?.code || null, null, firstAttemptedAt);
          const exhausted = attempt &&
            (attempt.disposition === "EXHAUSTED" || attempt.attemptCount >= 8);
          if (exhausted && attempt.disposition !== "EXHAUSTED") {
            await prisma.inboxDeliveryDeviceAttempt.update({
              where: { id: attempt.id },
              data: { disposition: "EXHAUSTED", nextAttemptAt: null, lastErrorCode: error?.code || "RETRY_EXHAUSTED" },
            });
          }
          return { failed: !exhausted, error, attemptMutation: attempt?.attemptMutation };
        }
      });
      if (admitted && targetAware && !deferAdmittedPersistence) {
        const persisted = await persistAdmittedAttemptResults(prisma, outcomes);
        if (persisted.leaseLost) leaseLost = true;
      }
      transientFailure = outcomes.some((outcome) => outcome?.failed);

      if (admitted && targetAware && deferAdmittedPersistence) {
        return {
          state: "PENDING_BATCH",
          row,
          outcomes,
          acceptedTokens: [...accepted],
          providerAccepted,
          attributionDeliveryId: attribution?.delivery?.id || null,
          attributionAccepted: Boolean(
            attribution?.delivery && outcomes.some((outcome) => outcome?.attributionAccepted),
          ),
        };
      }

      if (providerAccepted) {
        const acceptedUpdate = await prisma.inboxDeliveryOutbox.updateMany({
          where: { id: row.id, status: leaseStatus, leaseToken },
          data: { providerAcceptedAt: row.providerAcceptedAt || now(), acceptedTokens: [...accepted] },
        });
        if (acceptedUpdate.count !== 1) leaseLost = true;
      }
      if (!leaseLost && attribution?.delivery && outcomes.some((outcome) => outcome?.attributionAccepted)) {
        if (admitted) {
          await prisma.$executeRawUnsafe(
            `UPDATE push_deliveries delivery
                SET open_capable=true,provider_accepted_at=$4
              WHERE delivery.id=$1 AND delivery.provider_accepted_at IS NULL
                AND EXISTS (
                  SELECT 1 FROM inbox_delivery_outbox outbox
                   WHERE outbox.id=$2 AND outbox.status='ADMISSION_LEASED'
                     AND outbox.lease_token=$3
                )`,
            attribution.delivery.id, row.id, leaseToken, now(),
          );
        } else {
          await prisma.pushDelivery.updateMany({
            where: { id: attribution.delivery.id, providerAcceptedAt: null },
            data: { openCapable: true, providerAcceptedAt: now() },
          });
        }
      }
      if (leaseLost) return { state: "LOST_LEASE" };
      const remainingTarget = targetAware
        ? await prisma.inboxDeliveryDeviceAttempt.findFirst({
            where: { outboxId: row.id, disposition: { in: ["PENDING", "RETRY", "TRANSIENT_FAIL", "TIMEOUT"] } },
            orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
            select: { nextAttemptAt: true },
          })
        : null;
      if (remainingTarget) {
        const nextAttemptAt = remainingTarget.nextAttemptAt || new Date(current.getTime() + 250);
        const deferred = await prisma.inboxDeliveryOutbox.updateMany({
          where: { id: row.id, status: leaseStatus, leaseToken },
          data: {
            status: retryStatus,
            ...(deliveryItems.length ? { attemptCount: { increment: 1 } } : {}),
            availableAt: nextAttemptAt,
            retryAt: nextAttemptAt,
            leaseUntil: null,
            leaseToken: null,
            lastErrorCode: transientFailure
              ? outcomes.find((outcome) => outcome?.error)?.error?.code || "PROVIDER_REJECTED"
              : "PROVIDER_RETRYABLE_TARGET",
          },
        });
        return deferred.count === 1 ? { state: "RETRY", nextAttemptAt } : { state: "LOST_LEASE" };
      }
      const completed = await prisma.inboxDeliveryOutbox.updateMany({
        where: { id: row.id, status: leaseStatus, leaseToken },
        data: { status: "DELIVERED", deliveredAt: now(), leaseUntil: null, leaseToken: null },
      });
      return completed.count === 1 ? { state: "DELIVERED" } : { state: "LOST_LEASE" };
    } finally {
      if (renewal) clearInterval(renewal);
    }
  }

  return async function deliverInbox() {
    if (userFanoutDisabled("INBOX_DELIVERY_DISABLED")) return null;
    activeMetricsEpochPromise = null;
    const current = now();
    const admittedPage = typeof prisma.$transaction === "function"
      ? await claimProviderAttemptPage({
          prisma,
          admissionClass: ADMISSION_CLASS_GLOBAL_EVENT_STARTED,
          now: current,
          maximumRows: batchSize,
          telemetry: eventSurgeTelemetry,
          invalidateUnreadBatch: invalidateInboxUnreadMany,
        })
      : { claimed: [], nextTokenAt: null };
    const expiredIds = typeof prisma.$queryRawUnsafe === "function"
      ? await prisma.$queryRawUnsafe(
          `SELECT id FROM inbox_delivery_outbox
            WHERE expires_at IS NOT NULL AND expires_at <= $1
              AND status IN ('PENDING','RETRY','LEASED')
            ORDER BY expires_at,id LIMIT $2`,
          current, batchSize,
        )
      : [];
    if (expiredIds.length) {
      const ids = expiredIds.map((row) => row.id);
      await prisma.$transaction([
        prisma.inboxDeliveryDeviceAttempt.updateMany({
          where: { outboxId: { in: ids }, disposition: { in: ["PENDING", "RETRY", "TRANSIENT_FAIL", "TIMEOUT"] } },
          data: { disposition: "EXHAUSTED", nextAttemptAt: null, lastErrorCode: "NOTIFICATION_EXPIRED" },
        }),
        prisma.inboxDeliveryOutbox.updateMany({
          where: { id: { in: ids }, status: { in: ["PENDING", "RETRY", "LEASED"] } },
          data: { status: "EXPIRED", leaseUntil: null, leaseToken: null, lastErrorCode: "NOTIFICATION_EXPIRED" },
        }),
      ]);
    }
    const candidates = await claimNormalInboxPage({ prisma, now: current, batchSize });
    let delivered = 0;
    let claimed = 0;
    await mapWithConcurrency(candidates, concurrency, async (row) => {
      const leaseToken = row.leaseToken;
      const leased = typeof prisma.$transaction === "function"
        ? await prisma.$transaction(async (tx) => {
            const owned = await tx.inboxDeliveryOutbox.findFirst({
              where: { id: row.id, status: "LEASED", leaseToken },
              select: { id: true },
            });
            if (!owned || !tx.inboxDeliveryDeviceAttempt || !tx.deviceToken) {
              return { count: owned ? 1 : 0 };
            }
            const existingTargets = await tx.inboxDeliveryDeviceAttempt.findMany({
              where: { outboxId: row.id },
              orderBy: { id: "asc" },
            });
            const targetSnapshotExists = existingTargets.some(
              (target) => target.recipientUserId != null,
            );
            if (!targetSnapshotExists) {
              const generationState = await tx.globalStepEventGenerationState.findUnique({
                where: { id: 1 },
                select: { quarantineStartedAt: true },
              });
              const statusFilter = generationState?.quarantineStartedAt
                ? { status: "ACTIVE" }
                : { OR: [{ status: "ACTIVE" }, { status: null }] };
              const activeTokens = await tx.deviceToken.findMany({
                where: { userId: row.alert.userId, ...statusFilter },
                orderBy: [{ lastRegisteredAt: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
                take: MAX_TARGETS_PER_RECIPIENT,
              });
              const tokenByHash = new Map(activeTokens.map((token) => [
                tokenFingerprint(token.token),
                token,
              ]));
              const existingHashes = new Set(existingTargets.map((target) => target.tokenHash));
              for (const target of existingTargets) {
                const token = tokenByHash.get(target.tokenHash);
                await tx.inboxDeliveryDeviceAttempt.update({
                  where: { id: target.id },
                  data: token ? {
                    deviceTokenId: token.id,
                    recipientUserId: row.alert.userId,
                    installationId: token.installationId,
                    ownershipGeneration: token.ownershipGeneration,
                    platform: token.platform,
                    providerEnvironment: token.providerEnvironment,
                  } : {
                    recipientUserId: row.alert.userId,
                    ...(["PENDING", "RETRY", "TRANSIENT_FAIL", "TIMEOUT"].includes(target.disposition)
                      ? {
                          disposition: "SUPERSEDED",
                          nextAttemptAt: null,
                          providerRespondedAt: current,
                        }
                      : {}),
                  },
                });
              }
              const missingTokens = activeTokens.filter(
                (token) => !existingHashes.has(tokenFingerprint(token.token)),
              );
              await tx.inboxDeliveryDeviceAttempt.createMany({
                data: missingTokens.length ? missingTokens.map((token) => ({
                  outboxId: row.id,
                  tokenHash: tokenFingerprint(token.token),
                  disposition: "PENDING",
                  attemptCount: 0,
                  deviceTokenId: token.id,
                  recipientUserId: row.alert.userId,
                  installationId: token.installationId,
                  ownershipGeneration: token.ownershipGeneration,
                  platform: token.platform,
                  providerEnvironment: token.providerEnvironment,
                })) : existingTargets.length === 0 ? [{
                  outboxId: row.id,
                  tokenHash: "__NO_DEVICE__",
                  disposition: "NO_DEVICE",
                  attemptCount: 0,
                  recipientUserId: row.alert.userId,
                }] : [],
                skipDuplicates: true,
              });
            }
            return { count: 1 };
          })
        : { count: 1 };
      if (leased.count !== 1) return;
      claimed += 1;
      try {
        const result = await deliverRow({ ...row, leaseToken }, leaseToken, current);
        if (result.state === "DELIVERED") delivered += 1;
        if (result.state === "LOST_LEASE") return;
      } catch (error) {
        const attempts = row.attemptCount + 1;
        let nextRetry = retryAt(current, attempts, random);
        const expired = row.expiresAt && nextRetry >= new Date(row.expiresAt);
        if (expired) nextRetry = new Date(row.expiresAt);
        await prisma.inboxDeliveryOutbox.updateMany({
          where: { id: row.id, status: "LEASED", leaseToken },
          data: { status: expired ? "EXPIRED" : attempts >= 8 ? "EXHAUSTED" : "RETRY", attemptCount: attempts, leaseUntil: null, leaseToken: null, availableAt: nextRetry, retryAt: expired ? null : nextRetry, lastErrorCode: expired ? "NOTIFICATION_EXPIRED" : error?.code || "PROVIDER_REJECTED" },
        });
        logger.error("[CRON] inbox delivery failed", { outboxId: row.id, error: error?.message || String(error) });
      }
    });
    const admittedResults = await mapWithConcurrency(admittedPage.claimed, concurrency, async (row) => {
      claimed += 1;
      try {
        const result = await deliverRow(
          row, row.leaseToken, current, { deferAdmittedPersistence: true },
        );
        if (result.state === "DELIVERED") delivered += 1;
        return result;
      } catch (error) {
        const attempts = row.attemptCount + 1;
        let nextRetry = retryAt(current, attempts, random);
        const expiry = row.admissionExpiresAt || row.expiresAt;
        const expired = expiry && nextRetry >= new Date(expiry);
        if (expired) nextRetry = new Date(expiry);
        await prisma.inboxDeliveryOutbox.updateMany({
          where: { id: row.id, status: ADMISSION_LEASED, leaseToken: row.leaseToken },
          data: {
            status: expired ? "EXPIRED" : attempts >= 8 ? "EXHAUSTED" : ADMISSION_RETRY,
            attemptCount: attempts, leaseUntil: null, leaseToken: null,
            availableAt: nextRetry, retryAt: expired ? null : nextRetry,
            lastErrorCode: expired ? "NOTIFICATION_EXPIRED" : error?.code || "PROVIDER_REJECTED",
          },
        });
        logger.error("[CRON] admitted inbox delivery failed", { outboxId: row.id, error: error?.message || String(error) });
        return null;
      }
    });
    const admittedBatch = admittedResults.filter((result) => result?.state === "PENDING_BATCH");
    if (admittedBatch.length) {
      const persisted = await persistAdmittedPageResults(prisma, admittedBatch, now());
      delivered += persisted.delivered;
      if (persisted.leaseLost) {
        logger.warn?.("[CRON] admitted inbox delivery page lost leases", {
          claimed: admittedBatch.length,
          leaseLost: persisted.leaseLost,
        });
      }
    }
    const summary = { claimed, delivered, expired: expiredIds.length };
    const nextAdmissionAt = admissionWakeAt(admittedPage);
    if (nextAdmissionAt) summary.nextAdmissionAt = nextAdmissionAt;
    return summary;
  };
}

function scheduleInboxDelivery(dependencies = {}) {
  const run = dependencies.run || buildInboxDelivery(dependencies);
  // Compatibility seam for existing injected callers. Production starts the
  // dedicated schedule-release worker separately, so it deliberately leaves
  // this unset and avoids coupling visible delivery back to schedule release.
  const releaseDue = dependencies.releaseDue || null;
  const subscribeWakeup = dependencies.subscribeNotificationWakeup ||
    redisCache.subscribeNotificationWakeup;
  const nextDueAt = dependencies.nextDueAt || (() =>
    nextInboxDeliveryDueAt(dependencies.prisma || defaultPrisma));
  const logger = dependencies.logger || console;
  const nowMs = dependencies.nowMs || Date.now;
  const setDueTimer = dependencies.setDueTimer || setTimeout;
  const clearDueTimer = dependencies.clearDueTimer || clearTimeout;
  let running = null;
  let rerun = false;
  let dueTimer = null;
  let stopped = false;
  let unsubscribe = null;
  const tick = () => {
    if (stopped) return running;
    if (running) { rerun = true; return running; }
    running = Promise.resolve()
      .then(() => dependencies.startupBarrier?.())
      .then(() => releaseDue?.({ now: dependencies.now?.() }))
      .then(() => run())
      .then(async (result) => {
        if (result?.claimed >= (dependencies.batchSize || DEFAULT_BATCH_SIZE)) {
          setImmediate(tick);
        }
        if (typeof nextDueAt !== "function") return;
        const scheduleDueAt = await nextDueAt();
        const dueAt = [scheduleDueAt, result?.nextAdmissionAt]
          .filter(Boolean)
          .map((value) => new Date(value))
          .sort((left, right) => left - right)[0];
        if (!dueAt) return;
        const delay = Math.max(0, Math.min(60_000, new Date(dueAt).getTime() - nowMs()));
        if (dueTimer) clearDueTimer(dueTimer);
        dueTimer = setDueTimer(tick, delay);
        dueTimer.unref?.();
      })
      .catch((error) => {
        logger.error("[CRON] inboxDelivery tick error:", error);
        if (!stopped) {
          if (dueTimer) clearDueTimer(dueTimer);
          dueTimer = setDueTimer(tick, 1_000);
          dueTimer.unref?.();
        }
      })
      .finally(() => {
        running = null;
        if (rerun && !stopped) {
          rerun = false;
          setImmediate(tick);
        }
      });
    return running;
  };
  tick();
  const interval = setInterval(tick, dependencies.intervalMs || TICK_INTERVAL_MS);
  interval.unref?.();
  Promise.resolve(subscribeWakeup(() => tick()))
    .then((stop) => { unsubscribe = stop; })
    .catch((error) => {
      logger.error("[CRON] notification wake subscription failed:", error);
    });
  logger.log("[CRON] Inbox delivery scheduled");
  return {
    tick,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      if (dueTimer) clearDueTimer(dueTimer);
      await unsubscribe?.();
      await running;
    },
  };
}

module.exports = {
  buildInboxDelivery,
  scheduleInboxDelivery,
  retryAt,
  runProviderWithDeadline,
  pushPayload,
  mapWithConcurrency,
  createSemaphore,
  DEFAULT_BATCH_SIZE,
  DEFAULT_CONCURRENCY,
  DEFAULT_PROVIDER_CONCURRENCY,
  DEFAULT_DB_WRITE_CONCURRENCY,
  eventCollapseId,
  admissionWakeAt,
  persistAdmittedAttemptResults,
  persistAdmittedPageResults,
  nextInboxDeliveryDueAt,
  claimNormalInboxPage,
  LEASE_MS,
};
