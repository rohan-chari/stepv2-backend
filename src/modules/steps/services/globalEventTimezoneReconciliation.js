const { entitlementsChanged } = require('./eventDisplayCacheInvalidation');
const {
  prisma: defaultPrisma,
  deferUntilAfterCommit,
  isInPrismaTransactionScope,
} = require("../../../db");
const timezoneCache = require("../../users/services/timezoneStateCache");
const redisCache = require("../../../shared/cache/redisCache");
const { DomainEventReceipt } = require("../../domainEvents/models/domainEventReceipt");
const {
  canonicalIanaTimeZone,
  immediateGlobalEventTimezoneMutation,
} = require("../../users/services/globalEventTimezone");
const { localEventWindowForZone } = require("../globalStepEvent");
const { acquireRaceWriteFencesSetBased } = require("../../races/services/raceWriteFence");
const {
  EXPECTED_LOGICAL_OWNERS,
  GENERATION_CAPABILITIES,
  REQUIRED_GENERATION,
  READY_WINDOW_MS,
} = require("../models/globalStepEventGeneration");

function buildGlobalEventTimezoneReconciliation(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const now = dependencies.now || (() => new Date());
  const observeStatement = dependencies.timezoneStatementObserver || (() => {});
  const afterUserUpdate = dependencies.timezoneAfterUserUpdate || (() => {});
  const afterRaceFences = dependencies.timezoneAfterRaceFences || (() => {});
  const statement = async (name, operation) => {
    observeStatement(name);
    return operation();
  };
  return async function reconcileGlobalEventTimezone({ user, observedTimezone, repairPending = false }) {
    const canonicalTimezone = canonicalIanaTimeZone(observedTimezone);
    if (!user?.id || !canonicalTimezone) return null;
    // Reuse the already authenticated row on unchanged requests. Redis is
    // consulted only for a mismatch/candidate repair, never per step upload.
    if (!repairPending && (user.timezone !== canonicalTimezone ||
        immediateGlobalEventTimezoneMutation({ user, observedTimezone: canonicalTimezone }))) {
      if (redisCache.isEnabled()) {
        const state = await timezoneCache.read(user.id, () => prisma.user.findUnique({
          where: { id: user.id }, select: { timezone: true, globalEventTimezone: true,
            globalEventTimezoneCandidate: true, globalEventTimezoneCandidateSince: true },
        }));
        if (state) user = { ...user, ...state };
      }
    }
    let current = now();
    let stableMutation = immediateGlobalEventTimezoneMutation({
      user,
      observedTimezone: canonicalTimezone,
      now: current,
    });
    let timezoneChanged = user.timezone !== canonicalTimezone;
    // Explicit operator repair for already-promoted accounts; never supplied by
    // HTTP callers. Only the current, confirmed stable zone may be repaired.
    if (repairPending && (timezoneChanged ||
        canonicalIanaTimeZone(user.globalEventTimezone) !== canonicalTimezone)) {
      throw new Error("Pending timezone repair requires matching device and stable zones");
    }
    if (!timezoneChanged && !stableMutation && !repairPending) return null;

    // Synchronize legacy metadata and repair schedules from the former policy
    // in the same transaction. An unchanged request needs no timezone SQL.
    const reconcilePending = repairPending || timezoneChanged || Boolean(stableMutation?.globalEventTimezone);
    const discovery = reconcilePending
      ? (await statement("readiness-candidates-races", () => prisma.$queryRawUnsafe(
          `WITH live AS (
             SELECT logical_owner_id,generation,capabilities
               FROM global_step_event_cron_owners
              WHERE expires_at > $2
           ), census AS (
             SELECT state.ready_since IS NOT NULL
                    AND state.ready_since <= $2 - ($5::int * interval '1 millisecond')
                    AND count(live.*) = cardinality($4::text[])
                    AND count(DISTINCT live.logical_owner_id) = cardinality($4::text[])
                    AND array_agg(live.logical_owner_id ORDER BY live.logical_owner_id) = $4::text[]
                    AND bool_and(live.generation >= $3 AND live.capabilities @> $1::jsonb)
                    AS ready
               FROM global_step_event_generation_state state
               LEFT JOIN live ON true
              WHERE state.id=1
              GROUP BY state.ready_since
           ), candidates AS (
             SELECT entitlement.id,parent.event_day AS "eventDay",
                    parent.local_start_minute AS "localStartMinute",
                    parent.duration_minutes AS "durationMinutes",
                    entitlement.starts_at AS "startsAt"
              FROM global_step_event_entitlements entitlement
              JOIN global_step_events parent ON parent.id=entitlement.event_id
             WHERE entitlement.user_id=$6
                AND entitlement.start_processed_at IS NULL
                AND entitlement.starts_at > $2
                AND entitlement.timezone <> $7
                AND parent.schedule_mode='LOCAL_ENTITLEMENTS'
              ORDER BY entitlement.starts_at,entitlement.id
              LIMIT 4
           ), races AS (
             SELECT array_agg(DISTINCT participant.race_id ORDER BY participant.race_id) AS ids
               FROM race_participants participant
               JOIN races race ON race.id=participant.race_id
              WHERE participant.user_id=$6 AND participant.status='accepted'
                AND race.status='active'
           )
           SELECT COALESCE((SELECT ready FROM census),false) AS "generationReady",
                  COALESCE((SELECT jsonb_agg(to_jsonb(candidates) ORDER BY "startsAt",id) FROM candidates),'[]'::jsonb) AS candidates,
                  COALESCE((SELECT ids FROM races),ARRAY[]::text[]) AS "raceIds"`,
          JSON.stringify(GENERATION_CAPABILITIES), current, REQUIRED_GENERATION,
          [...EXPECTED_LOGICAL_OWNERS].sort(), READY_WINDOW_MS, user.id, canonicalTimezone,
        )))[0]
      : { generationReady: true, candidates: [], raceIds: [] };
    const candidates = Array.isArray(discovery?.candidates) ? discovery.candidates : [];
    const generationReady = candidates.length === 0 || discovery?.generationReady === true;
    // Keep users.timezone as the durable retry marker while an entitlement
    // requires generation-2 relocation but the rolling census is not ready.
    if (!generationReady) return { deferred: true, timezone: user.timezone };

    const raceIds = [...new Set((discovery?.raceIds || []).filter(Boolean))].sort();
    const result = await prisma.$transaction(async (tx) => {
      await statement("transaction-timeouts", () => tx.$queryRawUnsafe(
        "SELECT set_config('lock_timeout','100ms',true), set_config('statement_timeout','400ms',true)",
      ));
      if (raceIds.length) {
        observeStatement("race-fence-upsert");
        observeStatement("race-fence-lock");
      }
      await acquireRaceWriteFencesSetBased(tx, raceIds, current);
      await afterRaceFences({ tx, raceIds });
      const { acquireGlobalEnrollmentLock } = require('./globalEventEnrollment');
      await acquireGlobalEnrollmentLock(tx);
      const closureRows = await statement("global-lock-race-closure", () => tx.$queryRawUnsafe(
        `WITH global_lock AS MATERIALIZED (
           SELECT 1
         ), person AS MATERIALIZED (
           SELECT users.* FROM users CROSS JOIN global_lock WHERE users.id=$1 FOR UPDATE OF users
         )
         SELECT (SELECT to_jsonb(person) FROM person) AS person,
           COALESCE((SELECT jsonb_agg(value) FROM (
             SELECT entitlement.id,parent.event_day AS "eventDay",parent.local_start_minute AS "localStartMinute",
               parent.duration_minutes AS "durationMinutes", entitlement.starts_at AS "startsAt"
             FROM global_step_event_entitlements entitlement JOIN global_step_events parent ON parent.id=entitlement.event_id
             WHERE entitlement.user_id=$1 AND entitlement.start_processed_at IS NULL
               AND entitlement.end_processed_at IS NULL AND entitlement.timezone<>$2 AND entitlement.starts_at>$3
               AND parent.schedule_mode='LOCAL_ENTITLEMENTS'
             ORDER BY entitlement.starts_at,entitlement.id LIMIT 100
           ) value),'[]'::jsonb) AS candidates,
           COALESCE((SELECT array_agg(DISTINCT participant.race_id ORDER BY participant.race_id)
             FROM race_participants participant JOIN races race ON race.id=participant.race_id
             WHERE participant.user_id=$1 AND participant.status='accepted' AND race.status='active'),ARRAY[]::text[]) AS ids
           FROM global_lock`, user.id, canonicalTimezone, now(),
      ));
      current = now(); // Eligibility is decided after waiting for serialization.
      const stored = closureRows[0]?.person;
      if (!stored) return null;
      const lockedUser = { ...user, timezone: stored.timezone,
        globalEventTimezone: stored.global_event_timezone,
        globalEventTimezoneCandidate: stored.global_event_timezone_candidate,
        globalEventTimezoneCandidateSince: stored.global_event_timezone_candidate_since };
      if (repairPending && (stored.timezone !== canonicalTimezone || stored.global_event_timezone !== canonicalTimezone)) {
        throw new Error("User timezone changed during pending schedule repair; retry preview");
      }
      timezoneChanged = stored.timezone !== canonicalTimezone;
      stableMutation = immediateGlobalEventTimezoneMutation({ user: lockedUser, observedTimezone: canonicalTimezone });
      const lockedCandidates = closureRows[0]?.candidates || [];
      if (lockedCandidates.length && discovery?.generationReady !== true) {
        return { deferred: true, timezone: stored.timezone };
      }
      const closedRaceIds = [...new Set((closureRows[0]?.ids || []).filter(Boolean))].sort();
      if (closedRaceIds.some((id) => !raceIds.includes(id))) {
        const error = new Error("global-event race lock set expanded during timezone reconciliation");
        error.code = "GLOBAL_EVENT_LOCK_SET_CHANGED";
        error.retryable = true;
        throw error;
      }
      let updatedUser = null;
      async function relocatePage(page) {
      const relocationInputs = page.map(candidate => {
        const window = localEventWindowForZone({ ...candidate, timeZone: canonicalTimezone });
        return { id: candidate.id, startsAt: window.startsAt.toISOString(), endsAt: window.endsAt.toISOString(), localDate: window.localDate };
      });
      if (relocationInputs.length) {
        // Delivery takes these same schedule row locks. Recheck terminal status
        // in the following statement after any concurrent admission commits.
        await tx.$queryRawUnsafe(`SELECT id FROM notification_schedules
          WHERE recipient_user_id=$2 AND source_ref=ANY($1::text[]) ORDER BY id FOR UPDATE`, relocationInputs.map(row=>row.id), user.id);
        current = now();
      }
      const eligibleRows = relocationInputs.length ? await statement("eligibility-lock", () => tx.$queryRawUnsafe(
        `WITH input AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS value(
             id text, "startsAt" timestamp, "endsAt" timestamp, "localDate" text
           )
         ), locked AS MATERIALIZED (
           SELECT entitlement.id, entitlement.event_id AS "eventId",
                  entitlement.user_id AS "userId", entitlement.timezone,
                  entitlement.starts_at AS "oldStartsAt",
                  entitlement.ends_at AS "oldEndsAt",
                  entitlement.schedule_revision AS "scheduleRevision",
                  parent.multiplier, input."startsAt", input."endsAt", input."localDate"
             FROM input
             JOIN global_step_event_entitlements entitlement ON entitlement.id=input.id
            JOIN global_step_events parent ON parent.id=entitlement.event_id
           WHERE entitlement.user_id=$2
              AND entitlement.start_processed_at IS NULL
              AND entitlement.starts_at > $3
              AND input."startsAt" > $3
              AND parent.schedule_mode='LOCAL_ENTITLEMENTS'
              AND entitlement.end_processed_at IS NULL
              AND entitlement.timezone<>$4
            ORDER BY entitlement.starts_at, entitlement.id
            FOR UPDATE OF entitlement
         )
         SELECT locked.*
           FROM locked
          WHERE NOT EXISTS (
                  SELECT 1 FROM domain_event_outbox event
                   WHERE event.event_key='GLOBAL_STEP_EVENT_ACTIVATED_V1:' || locked.id
                )
            AND NOT EXISTS (
                  SELECT 1 FROM notification_schedules schedule
                   WHERE schedule.recipient_user_id=$2 AND schedule.source_ref=locked.id AND schedule.status NOT IN ('PENDING','ADMISSION_PENDING')
                )
            AND NOT EXISTS (
                  SELECT 1 FROM notification_schedule_receipts receipt
                   WHERE receipt.recipient_user_id=$2 AND receipt.source_id=locked.id
                     AND receipt.terminal_status IS NOT NULL
                )
            AND NOT EXISTS (
                  SELECT 1 FROM global_event_race_impacts impact
                   WHERE impact.event_id=locked."eventId" AND impact.user_id=$2
                )
            AND NOT EXISTS (
                  SELECT 1 FROM global_event_user_summaries summary
                   WHERE summary.event_id=locked."eventId" AND summary.user_id=$2
                )
            AND NOT EXISTS (
                  SELECT 1 FROM global_step_event_entitlements neighbor
                   WHERE neighbor.user_id=$2 AND neighbor.id<>locked.id
                     AND neighbor.starts_at < locked."endsAt"
                     AND neighbor.ends_at > locked."startsAt"
                )
          ORDER BY locked."oldStartsAt", locked.id`,
        JSON.stringify(relocationInputs), user.id, current, canonicalTimezone,
      )) : [];
      if (!updatedUser) {
        const userData = {
          ...(timezoneChanged ? { timezone: canonicalTimezone } : {}),
          ...(stableMutation || {}),
        };
        updatedUser = Object.keys(userData).length
          ? await statement("user-update", () => tx.user.update({ where: { id: user.id }, data: userData }))
          : lockedUser;
        await afterUserUpdate({ tx, user: updatedUser, eligibleRows });
      }
      const relocated = eligibleRows.length ? await statement("entitlement-update", () => tx.$queryRawUnsafe(
        `WITH input AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS value(
             id text, "startsAt" timestamp, "endsAt" timestamp, "localDate" text
           )
         )
         UPDATE global_step_event_entitlements entitlement
            SET timezone=$2, local_date=input."localDate",
                starts_at=input."startsAt", ends_at=input."endsAt",
                timezone_relocated_at=$3,
                timezone_relocated_from=entitlement.timezone,
                schedule_revision=entitlement.schedule_revision+1,
                updated_at=$3
          FROM input
         WHERE entitlement.id=input.id
            AND entitlement.start_processed_at IS NULL
          RETURNING entitlement.id, entitlement.event_id AS "eventId",
                    entitlement.user_id AS "userId", entitlement.timezone,
                    entitlement.starts_at AS "startsAt", entitlement.ends_at AS "endsAt",
                    entitlement.schedule_revision AS "scheduleRevision"`,
        JSON.stringify(eligibleRows.map((row) => ({
          id: row.id,
          startsAt: new Date(row.startsAt).toISOString(),
          endsAt: new Date(row.endsAt).toISOString(),
          localDate: row.localDate,
        }))), canonicalTimezone, current,
      )) : [];
      if (relocated.length) {
        // Relocation and the existing pending notification revision commit as
        // one fact. A delayed/replayed projection cannot expire the old window.
        await tx.$executeRawUnsafe(`UPDATE notification_schedules schedule
          SET available_at=entitlement.starts_at, expires_at=CASE WHEN schedule.admission_class IS NOT NULL THEN entitlement.ends_at-interval '60 seconds' ELSE entitlement.ends_at END,
              source_revision=entitlement.schedule_revision,
              payload=schedule.payload || jsonb_build_object('startsAt',entitlement.starts_at,'endsAt',entitlement.ends_at),
              updated_at=$2
          FROM global_step_event_entitlements entitlement
          WHERE schedule.recipient_user_id=$3 AND schedule.source_ref=entitlement.id AND entitlement.id=ANY($1::text[])
            AND schedule.status IN ('PENDING','ADMISSION_PENDING')
            AND schedule.source_revision < entitlement.schedule_revision`, relocated.map(row => row.id), current, user.id);

        const eventInputs = relocated.map((entitlement) => {
          const source = eligibleRows.find((row) => row.id === entitlement.id);
          return {
            eventKey: `GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1:${entitlement.id}:${entitlement.scheduleRevision}`,
            aggregateId: entitlement.id,
            recipientId: entitlement.userId,
            payload: {
              eventId: entitlement.eventId,
              entitlementId: entitlement.id,
              userId: entitlement.userId,
              multiplier: Number(source.multiplier),
              startsAt: entitlement.startsAt,
              endsAt: entitlement.endsAt,
              scheduleRevision: entitlement.scheduleRevision,
              timezone: entitlement.timezone,
            },
          };
        });
        await statement("schedule-event-append", () => tx.$executeRawUnsafe(
          `WITH input AS (
             SELECT * FROM jsonb_to_recordset($1::jsonb) AS value(
               "eventKey" text, "aggregateId" text, "recipientId" text, payload jsonb
             )
           ), inserted AS (
             INSERT INTO domain_event_outbox (
               id,event_key,event_type,schema_version,aggregate_type,aggregate_id,
               payload,occurred_at,available_at,status,
               projection_count,terminal_projection_count,failed_projection_count,
               projection_counts_valid_at,created_at,updated_at
             )
             SELECT gen_random_uuid(),input."eventKey",
                    'GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1',1,
                    'GLOBAL_STEP_EVENT_ENTITLEMENT',input."aggregateId",input.payload,
                    $2,$2,'PENDING',0,0,0,$2,$2,$2
               FROM input ON CONFLICT (event_key) DO NOTHING
             RETURNING id,event_key
           )
           INSERT INTO domain_event_audiences (
             id,domain_event_id,recipient_id,ordinal,facts,created_at
           )
           SELECT gen_random_uuid(),inserted.id,input."recipientId",0,'{}'::jsonb,$2
             FROM inserted JOIN input ON input."eventKey"=inserted.event_key`,
          JSON.stringify(eventInputs), current,
        ));
        const stored = await tx.domainEventOutbox.findMany({
          where: { eventKey: { in: eventInputs.map((row) => row.eventKey) } },
          include: { audience: { orderBy: { ordinal: "asc" } } },
        });
        if (stored.length !== eventInputs.length || stored.some((row) => row.audience.length !== 1)) {
          throw new Error("timezone reconciliation receipt finalization lost selected events");
        }
        await DomainEventReceipt.finalizeMany({
          items: stored.map((record) => ({
            envelope: {
              ...record,
              audience: record.audience.map((row) => ({
                recipientId: row.recipientId, ordinal: row.ordinal, facts: row.facts,
              })),
            },
            domainEventId: record.id,
            replaySourceType: record.aggregateType,
            replaySourceId: record.aggregateId,
          })),
        }, tx);
        if (isInPrismaTransactionScope()) {
          await deferUntilAfterCommit(() =>
            redisCache.publishDurableQueueWakeup("domain-event"));
        }
      }
        return relocated;
      }
      const relocated = [];
      let page = lockedCandidates;
      for (;;) {
        relocated.push(...await relocatePage(page));
        if (page.length < 100) break;
        const cursor = page[page.length - 1];
        // Original startsAt/id is a stable keyset even when eligible rows move;
        // ineligible rows left in their former zone cannot stall the next page.
        page = await tx.$queryRawUnsafe(`SELECT entitlement.id,
            entitlement.starts_at AS "startsAt",parent.event_day AS "eventDay",
            parent.local_start_minute AS "localStartMinute",parent.duration_minutes AS "durationMinutes"
          FROM global_step_event_entitlements entitlement
          JOIN global_step_events parent ON parent.id=entitlement.event_id
          WHERE entitlement.user_id=$1 AND entitlement.start_processed_at IS NULL
            AND entitlement.end_processed_at IS NULL AND entitlement.timezone<>$2
            AND entitlement.starts_at>$3 AND parent.schedule_mode='LOCAL_ENTITLEMENTS'
            AND (entitlement.starts_at,entitlement.id)>($4::timestamp,$5::text)
          ORDER BY entitlement.starts_at,entitlement.id LIMIT 100`,
          user.id,canonicalTimezone,now(),new Date(cursor.startsAt),cursor.id);
      }
      // Fence all race/timezone variants only after this transaction commits.
      if (updatedUser !== lockedUser || relocated.length) await entitlementsChanged([user.id]);
      return {
        timezone: updatedUser.timezone,
        user: updatedUser,
        relocated: relocated.map((row) => row.id),
      };
    }, { timeout: 1500, maxWait: 100 });
    if (result?.user) await timezoneCache.invalidate(user.id);
    return result;
  };
}

module.exports = { buildGlobalEventTimezoneReconciliation };
