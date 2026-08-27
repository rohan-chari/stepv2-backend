const { prisma: defaultPrisma } = require("../../../db");
const {
  canonicalIanaTimeZone,
  globalEventTimezoneMutation,
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
  return async function reconcileGlobalEventTimezone({ user, observedTimezone }) {
    const canonicalTimezone = canonicalIanaTimeZone(observedTimezone);
    if (!user?.id || !canonicalTimezone) return null;
    const current = now();
    const stableMutation = globalEventTimezoneMutation({
      user,
      observedTimezone: canonicalTimezone,
      now: current,
    });
    const timezoneChanged = user.timezone !== canonicalTimezone;
    if (!timezoneChanged && !stableMutation) return null;

    const discovery = timezoneChanged
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
                AND parent.schedule_mode='LOCAL_ENTITLEMENTS'
                AND parent.starts_at > $2
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
          [...EXPECTED_LOGICAL_OWNERS].sort(), READY_WINDOW_MS, user.id,
        )))[0]
      : { generationReady: true, candidates: [], raceIds: [] };
    const candidates = Array.isArray(discovery?.candidates) ? discovery.candidates : [];
    const generationReady = candidates.length === 0 || discovery?.generationReady === true;
    // Keep users.timezone as the durable retry marker while an entitlement
    // requires generation-2 relocation but the rolling census is not ready.
    if (!generationReady) return { deferred: true, timezone: user.timezone };

    const raceIds = candidates.length
      ? [...new Set((discovery?.raceIds || []).filter(Boolean))].sort()
      : [];
    const relocationInputs = candidates.map((candidate) => {
      const window = localEventWindowForZone({
        eventDay: candidate.eventDay,
        localStartMinute: candidate.localStartMinute,
        durationMinutes: candidate.durationMinutes,
        timeZone: canonicalTimezone,
      });
      return {
        id: candidate.id,
        startsAt: window.startsAt.toISOString(),
        endsAt: window.endsAt.toISOString(),
        localDate: window.localDate,
      };
    });
    return prisma.$transaction(async (tx) => {
      await statement("transaction-timeouts", () => tx.$queryRawUnsafe(
        "SELECT set_config('lock_timeout','100ms',true), set_config('statement_timeout','400ms',true)",
      ));
      if (raceIds.length) {
        observeStatement("race-fence-upsert");
        observeStatement("race-fence-lock");
      }
      await acquireRaceWriteFencesSetBased(tx, raceIds, current);
      await afterRaceFences({ tx, raceIds });
      const closureRows = candidates.length ? await statement("global-lock-race-closure", () => tx.$queryRawUnsafe(
        `WITH global_lock AS MATERIALIZED (
           SELECT pg_advisory_xact_lock(hashtextextended('global-event-enrollment',0))
         )
         SELECT COALESCE(array_agg(DISTINCT participant.race_id ORDER BY participant.race_id),ARRAY[]::text[]) AS ids
           FROM race_participants participant
           JOIN races race ON race.id=participant.race_id
           CROSS JOIN global_lock
          WHERE participant.user_id=$1 AND participant.status='accepted'
            AND race.status='active'`,
        user.id,
      )) : [{ ids: [] }];
      const closedRaceIds = [...new Set((closureRows[0]?.ids || []).filter(Boolean))].sort();
      if (closedRaceIds.some((id) => !raceIds.includes(id))) {
        const error = new Error("global-event race lock set expanded during timezone reconciliation");
        error.code = "GLOBAL_EVENT_LOCK_SET_CHANGED";
        error.retryable = true;
        throw error;
      }
      const eligibleRows = candidates.length ? await statement("eligibility-lock", () => tx.$queryRawUnsafe(
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
              AND parent.starts_at > $3
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
        JSON.stringify(relocationInputs), user.id, current,
      )) : [];
      const userData = {
        ...(timezoneChanged ? { timezone: canonicalTimezone } : {}),
        ...(stableMutation || {}),
      };
      const updatedUser = Object.keys(userData).length
        ? await statement("user-update", () => tx.user.update({ where: { id: user.id }, data: userData }))
        : user;
      await afterUserUpdate({ tx, user: updatedUser, eligibleRows });
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
               payload,occurred_at,available_at,status,created_at,updated_at
             )
             SELECT gen_random_uuid(),input."eventKey",
                    'GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1',1,
                    'GLOBAL_STEP_EVENT_ENTITLEMENT',input."aggregateId",input.payload,
                    $2,$2,'PENDING',$2,$2
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
      }
      return {
        timezone: updatedUser.timezone,
        user: updatedUser,
        relocated: relocated.map((row) => row.id),
      };
    }, { timeout: 500, maxWait: 100 });
  };
}

module.exports = { buildGlobalEventTimezoneReconciliation };
