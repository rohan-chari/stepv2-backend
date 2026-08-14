const { prisma: defaultPrisma } = require("../../../db");
const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { RaceActiveEffect } = require("../../powerups/models/raceActiveEffect");
const { RacePowerupEvent } = require("../../powerups/models/racePowerupEvent");
const {
  RaceResolutionJobV2: defaultJobModel,
  newLeaseToken,
  LEASE_MS,
} = require("../models/raceResolutionJobV2");
const {
  buildResolveRaceState,
} = require("../services/raceStateResolution");
const { createWriteCapture } = require("../services/computeRaceState");
const {
  syncRacePowerupState: defaultSyncRacePowerupState,
} = require("../services/racePowerupStateSync");
const {
  recentBoxMints: defaultRecentBoxMints,
} = require("../services/recentBoxMints");
const { nudgeOvertakenRivals } = require("../../steps/commands/recordSteps");
const { stepSyncPushService } = require("../../../shared/push/stepSyncPush");
const { appSettings: defaultAppSettings } = require("../../../shared/config/appSettings");
const { isStrictFlagEnabled } = require("../../../shared/config/isStrictFlagEnabled");
const {
  StepSyncRequest: defaultStepSyncRequestModel,
} = require("../../steps/models/stepSyncRequest");
const {
  raceResolutionWorkBudget: defaultWorkBudget,
} = require("../services/raceResolutionWorkBudget");
const {
  raceResolutionPostTaskHandoff: defaultPostTaskHandoff,
} = require("../services/raceResolutionPostTaskHandoff");
const {
  raceResolutionDisplayArtifact: defaultDisplayArtifactStore,
  artifactMatchesClaim,
} = require("../services/raceResolutionDisplayArtifact");
const {
  buildRaceResolutionInputFingerprint: defaultBuildInputFingerprint,
} = require("../services/raceResolutionInputFingerprint");
const { balanceConfig: defaultBalanceConfig } = require("../../economy/balanceConfig");
const {
  buildRaceResolutionStepSyncScope: defaultBuildStepSyncScope,
  stepSyncScopeMatchesFence: defaultStepSyncScopeMatchesFence,
  isClosureEligibleReasonSet,
} = require("../services/raceResolutionStepSyncScope");
const {
  buildRaceScoringDependencyClosure: defaultBuildDependencyClosure,
  wouldTrailMineEscalate: defaultWouldTrailMineEscalate,
  TRAIL_MINE_ESCALATION_UNKNOWN,
  CLOSURE_FALLBACK_REASON_VALUES,
} = require("../services/raceScoringDependencyClosure");
const {
  raceResolutionDeliveryIntents: defaultDeliveryIntents,
} = require("../services/raceResolutionDeliveryIntents");

const POLL_INTERVAL_MS = 250;
const QUEUE_LAG_LOG_INTERVAL_MS = 60 * 1000;
const QUEUE_LAG_ALARM_MS = 30 * 1000;
// Best-effort reservation cleanup cadence (never affects correctness). Carried
// over from the v1 scheduler, which src/index.js no longer starts.
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

// Starts a bounded number of independently-claimed jobs at once. Every
// [processOne] claim uses `FOR UPDATE SKIP LOCKED` and the later fenced write is
// race-keyed, so separate lanes can never write the same race concurrently.
// Keeping this helper small and pure makes the scheduler's actual parallelism
// directly testable without mocking the worker's settlement machinery.
async function runBoundedRaceResolutionJobs(concurrency, processOne) {
  const lanes = Math.min(3, Math.max(1, Number(concurrency) || 1));
  // Do not reject early: the scheduler clears its in-flight guard when tick()
  // settles. An early rejection while a sibling is still resolving would let
  // the next 250ms tick exceed the lane cap. Surface the error only once every
  // lane has settled, so the scheduler stays closed over all active work.
  const settled = await Promise.allSettled(
    Array.from({ length: lanes }, () => processOne())
  );
  const failure = settled.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  return settled.filter(
    (result) => result.status === "fulfilled" && result.value
  ).length;
}

// §5a item 1 "worker handoff": the v2 worker must not claim while an OLD-binary
// worker could still be draining the per-user table during a `pm2 reload`
// overlap. 60s > the old worker's 30s lease + the reload window. Env-tunable so
// tests can shrink it (they assert the gate, not the wall-clock).
function quietPeriodMs() {
  const parsed = Number(process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60 * 1000;
}

// Thrown by the fenced write transaction when the job row no longer matches our
// lease token. It means the lease expired and someone else re-claimed the race,
// so we must roll back HAVING WRITTEN NOTHING and walk away without touching the
// job row (it belongs to the new owner now).
class FenceLostError extends Error {
  constructor() {
    super("Race resolution lease token no longer valid");
    this.name = "FenceLostError";
  }
}

function participantTotalWriteChangesRow(write, current) {
  if (write.kind !== "participantTotal") return true;
  // Compare against the same normalization the writer applies
  // (normalizeParticipantWrites rounds; the model clamps rawSteps): a fractional
  // capture (e.g. 2150.5 under a 0.5x effect) compared raw against the stored
  // integer would classify the row as changed on every resolution forever.
  if (!current || current.totalSteps !== Math.round(write.totalSteps)) return true;
  return (
    typeof write.rawSteps === "number" &&
    Number.isFinite(write.rawSteps) &&
    current.rawSteps !== Math.max(0, Math.round(write.rawSteps))
  );
}

function retainTeamAsOfHeartbeat(candidateWrites, changedWrites, isTeamRace) {
  if (!isTeamRace) return changedWrites;
  if (changedWrites.some((write) => write.kind === "participantTotal")) {
    return changedWrites;
  }
  const heartbeat = candidateWrites.find(
    (write) => write.kind === "participantTotal"
  );
  return heartbeat ? [...changedWrites, heartbeat] : changedWrites;
}

function supersededRunMayDiscard(job, currentTime = new Date()) {
  return Boolean(
    job &&
      Number(job.generation) > Number(job.processingGeneration) &&
      job.dirtyPriority === "COALESCE" &&
      job.processingDirtyPriority === "COALESCE" &&
      job.lastCompletedAt &&
      currentTime.getTime() - new Date(job.lastCompletedAt).getTime() <= 15_000
  );
}

async function rebindArtifactPresentation(tx, artifactPayload) {
  const participants = artifactPayload?.result?.race?.participants;
  if (!Array.isArray(participants)) return false;
  const userIds = [...new Set(participants.map((row) => row.userId).filter(Boolean))];
  const users = await tx.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, displayName: true, profilePhotoUrl: true },
  });
  if (users.length !== userIds.length) return false;
  const byId = new Map(users.map((user) => [user.id, user]));
  for (const participant of participants) {
    const current = byId.get(participant.userId);
    if (!current) return false;
    participant.user = { ...(participant.user || {}), ...current };
  }
  for (const write of artifactPayload.writes || []) {
    if (write.kind !== "eventCreate") continue;
    const data = write.data;
    const target = byId.get(data?.targetUserId);
    const metadata = data?.metadata;
    if (!target || data?.powerupType !== "TRAIL_MINE" || !metadata) return false;
    const name = target.displayName || "A runner";
    data.description = metadata.blocked
      ? `${name} blocked a Trail Mine with Compression Socks!`
      : `${name} triggered a Trail Mine and lost ${
        Number(metadata.penalty || 0).toLocaleString()
      } steps.`;
  }
  return true;
}

// How far PAST the fence instant a due expiry still forces the closure away.
//
// `expireEffects` does not run inside the fence — it runs from the post-commit
// hook, against a LATER `now()` than the one the fence checked. So "not due at
// the fence" is not the same as "not due when expiry runs", and the gap is
// whatever the write transaction plus the commit plus the hook's own startup
// costs. 30s is chosen to strictly dominate that gap: the fenced write
// transaction's own timeout is 15s (see the `$transaction` options below), so
// 30s covers a worst-case full-duration transaction plus commit plus hook entry
// with room to spare.
//
// The cost of the slack being too LARGE is bounded and benign — some closures
// fall back to FULL slightly earlier than strictly necessary. The cost of it
// being too SMALL is a silently skipped `stepsAtExpiry` stamp on a row that is
// then written EXPIRED permanently, which is unrecoverable. Asymmetric risk, so
// the constant is deliberately generous.
const POST_COMMIT_SLACK_MS = 30_000;

// The types whose expiry consumes a value the generation computed for its
// TARGET, looked up by participant id in `baseAdjustedByParticipantId` — and
// both of which SILENTLY skip on a missing key rather than failing loudly
// (expireEffects.js:56-59 for the stepsAtExpiry stamp, :165 for the Drill
// Sergeant dare judgement).
const {
  SNAPSHOT_AT_EXPIRY_TYPES,
} = require("../../powerups/constants/expiryEffectTypes");
const FENCE_DUE_EXPIRY_VETO_TYPES = Object.freeze(
  new Set([...SNAPSHOT_AT_EXPIRY_TYPES, "DRILL_SERGEANT"])
);

/**
 * True when an active effect whose expiry needs a closure-computed value is (or
 * is about to become) due on a participant OUTSIDE the closure.
 *
 * This is a re-check, not a duplicate of the planner's `DUE_EXPIRY_OUTSIDE_CLOSURE`
 * veto. That veto is evaluated once, at the planner's `asOf`, against effects
 * already due at that instant. It cannot cover an effect that becomes due
 * between plan selection and the post-commit hook — and the closure's
 * `validUntil` does not close the hole either, because its effect-boundary term
 * enumerates only CLOSURE-RELEVANT effects, and by construction this row's
 * target is not in the closure.
 *
 * Evaluated against the in-fence fingerprint re-read, so it costs no extra
 * query: those rows were already selected and already digested.
 */
function dueExpiryOutsideClosureAtFence(activeEffects, closureParticipantIds, currentTime) {
  const closure = new Set(closureParticipantIds || []);
  const horizonMs = currentTime.getTime() + POST_COMMIT_SLACK_MS;
  for (const effect of activeEffects || []) {
    if (!FENCE_DUE_EXPIRY_VETO_TYPES.has(effect?.type)) continue;
    if (closure.has(effect.targetParticipantId)) continue;
    if (effect.expiresAt == null) continue;
    const expiresAtMs = new Date(effect.expiresAt).getTime();
    // An unparseable expiry is treated as due: we cannot prove it is not.
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= horizonMs) return true;
  }
  return false;
}

function resolutionPlanForDirtyReasons(reasons) {
  return Array.isArray(reasons) &&
    reasons.length === 1 &&
    reasons[0] === "BOX_OPEN"
    ? "NO_SCORE"
    : "FULL";
}

// ── Phase 2b: dependency-closure SHADOW observability ───────────────────────
//
// The planner's result carries in-memory handoffs (participant ids, effect
// rows, per-participant step totals) that exist for the Phase 3 write path.
// NONE of them may reach a log line. What follows is the complete, closed set
// of fields the shadow is allowed to emit: plan, a closed-enum fallback reason,
// three counts, two booleans/tri-state, and a duration. No user id, participant
// id, step total, or effect metadata — spec §Observability and the result-field
// contract comment on raceScoringDependencyClosure's return value.
//
// Every field is null when the flag is off or the envelope is not
// closure-candidate-shaped, so "the shadow did not run" is unambiguous in the
// log rather than indistinguishable from "it ran and found nothing".
const NULL_CLOSURE_SHADOW_FIELDS = Object.freeze({
  shadowClosurePlan: null,
  shadowClosureFallbackReason: null,
  shadowClosureCount: null,
  shadowSourceCount: null,
  shadowMinesActive: null,
  shadowWouldEscalateOnMine: null,
  shadowPlannerMs: null,
  shadowRetainedSourceCount: null,
});

function summarizeClosureShadow(
  result,
  plannerMs,
  escalationProbe = defaultWouldTrailMineEscalate
) {
  if (!result || typeof result !== "object") {
    return { ...NULL_CLOSURE_SHADOW_FIELDS, shadowPlannerMs: plannerMs };
  }
  const plan =
    result.plan === "DEPENDENCY_CLOSURE" || result.plan === "FULL"
      ? result.plan
      : null;
  const isClosure = plan === "DEPENDENCY_CLOSURE";
  const minesActive = result.minesActive === true;
  let wouldEscalate = null;
  if (isClosure && minesActive) {
    const verdict = escalationProbe({
      mines: result.mines,
      closureIds: result.participantIds,
      participantTotals: result.participantTotals,
    });
    // The tri-state is the whole point of this measurement: "UNKNOWN" is the
    // legacy-mine case (no `aheadParticipantIds`, no pre-generation total) and
    // Phase 3 must treat it as ESCALATE. It is logged as the STRING "UNKNOWN",
    // never coerced to a boolean and never dropped — the rate of this exact
    // value on the Weekly is what decides whether the closure can ship there.
    wouldEscalate =
      verdict === TRAIL_MINE_ESCALATION_UNKNOWN
        ? String(TRAIL_MINE_ESCALATION_UNKNOWN)
        : verdict === true;
  }
  return {
    shadowClosurePlan: plan,
    // Closed enum only. An unrecognized value is logged as null rather than
    // widening the dimension the rollout gates are read from.
    shadowClosureFallbackReason: CLOSURE_FALLBACK_REASON_VALUES.has(
      result.fallbackReason
    )
      ? result.fallbackReason
      : null,
    // Null (not 0) on a FULL plan: there is no closure to size, and a 0 would
    // drag every aggregate over closure size toward zero.
    shadowClosureCount: isClosure ? (result.participantIds || []).length : null,
    shadowSourceCount: Array.isArray(result.sourceParticipantIds)
      ? result.sourceParticipantIds.length
      : null,
    // On a FULL fallback the planner may have short-circuited before ever
    // inspecting the active set — "no mines" and "never looked" must not
    // collapse into the same value, so mines are reported only on a closure.
    shadowMinesActive: isClosure ? minesActive : null,
    shadowWouldEscalateOnMine: wouldEscalate,
    shadowPlannerMs: plannerMs,
    shadowRetainedSourceCount: Array.isArray(result.retainedUnresolvedSources)
      ? result.retainedUnresolvedSources.length
      : null,
  };
}

function normalizeParticipantWrites(writes) {
  const byParticipant = new Map();
  for (const write of writes || []) {
    if (!write?.participantId) throw new Error("participant capture missing id");
    let row = byParticipant.get(write.participantId);
    if (!row) {
      row = {
        participantId: write.participantId,
        totalSteps: null,
        hasTotal: false,
        rawSteps: null,
        hasRaw: false,
        bonusDecrement: 0,
      };
      byParticipant.set(write.participantId, row);
    }
    if (write.kind === "participantBonus") {
      if (!Number.isFinite(write.amount)) {
        throw new Error("invalid participant bonus capture");
      }
      // Safety net only: today's sole producer (Trail Mine's Math.round'ed
      // penalty) already emits an integer.
      row.bonusDecrement += Math.round(write.amount);
      continue;
    }
    if (write.kind !== "participantTotal" || !Number.isFinite(write.totalSteps)) {
      throw new Error("invalid participant total capture");
    }
    // Effect multipliers (0.5x debuffs, freeze proration, …) produce fractional
    // totals. The legacy per-row Prisma UPDATE survived them because Postgres
    // ROUNDS on numeric→int assignment, but jsonb_to_recordset's `integer`
    // column is a text cast that raises 22P02 on "59939.5" — which failed the
    // whole resolution transaction for any race with such an effect. Round here
    // to keep the exact values the legacy writer persisted (assignment casts
    // round half AWAY FROM ZERO vs Math.round's half-up — they differ only on
    // negative halves, unreachable because totals are floored at 0 upstream).
    // `rawSteps` also
    // mirrors the model's `Math.max(0, Math.round(...))` clamp, which this bulk
    // writer bypasses.
    const totalSteps = Math.round(write.totalSteps);
    const hasRaw = Number.isFinite(write.rawSteps);
    const rawSteps = hasRaw ? Math.max(0, Math.round(write.rawSteps)) : null;
    if (
      row.hasTotal &&
      (row.totalSteps !== totalSteps ||
        row.hasRaw !== hasRaw ||
        (hasRaw && row.rawSteps !== rawSteps))
    ) {
      throw new Error("conflicting participant total capture");
    }
    row.totalSteps = totalSteps;
    row.hasTotal = true;
    row.rawSteps = rawSteps;
    row.hasRaw = hasRaw;
  }
  return [...byParticipant.values()];
}

async function writeParticipantsBulk(tx, writes, totalsUpdatedAt) {
  const rows = normalizeParticipantWrites(writes);
  if (rows.length === 0) return 0;
  const ids = rows.map((row) => row.participantId);
  const locked = await tx.$queryRawUnsafe(
    `SELECT id
     FROM race_participants
     WHERE id = ANY($1::text[])
     ORDER BY user_id ASC, id ASC
     FOR UPDATE`,
    ids
  );
  if (locked.length !== rows.length) {
    throw new Error("race participant bulk lock count mismatch");
  }
  const updated = await tx.$queryRawUnsafe(
    `WITH input AS (
       SELECT *
       FROM jsonb_to_recordset($1::jsonb) AS row(
         "participantId" text,
         "totalSteps" integer,
         "hasTotal" boolean,
         "rawSteps" integer,
         "hasRaw" boolean,
         "bonusDecrement" integer
       )
     )
     UPDATE race_participants participant
     SET total_steps = CASE WHEN input."hasTotal" THEN input."totalSteps" ELSE participant.total_steps END,
         raw_steps = CASE WHEN input."hasRaw" THEN input."rawSteps" ELSE participant.raw_steps END,
         bonus_steps = participant.bonus_steps - input."bonusDecrement",
         totals_updated_at = CASE WHEN input."hasTotal" THEN $2 ELSE participant.totals_updated_at END
     FROM input
     WHERE participant.id = input."participantId"
     RETURNING participant.id`,
    JSON.stringify(rows),
    totalsUpdatedAt
  );
  if (updated.length !== rows.length) {
    throw new Error("race participant bulk update count mismatch");
  }
  return updated.length;
}

// The write-capture proxy lives in services/computeRaceState.js — the SAME one
// the read-only callers (usePowerup's Trail Mine plant and Uprising gate) use.
// One capture, one definition of "the write surface of resolveRaceState": the
// worker replays the recorded writes inside its fence, the read-only callers
// discard them. A second copy here would be a second thing to keep in lockstep.

function buildRaceResolutionWorkerV2(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const effectModel = dependencies.RaceActiveEffect || RaceActiveEffect;
  const eventModel = dependencies.RacePowerupEvent || RacePowerupEvent;
  const jobModel = dependencies.RaceResolutionJobV2 || defaultJobModel;
  const syncRacePowerupState =
    dependencies.syncRacePowerupState || defaultSyncRacePowerupState;
  const recentBoxMints = dependencies.recentBoxMints || defaultRecentBoxMints;
  const requestStepSyncForUsers =
    dependencies.requestStepSyncForUsers ||
    stepSyncPushService.requestStepSyncForUsers;
  const nudge = dependencies.nudgeOvertakenRivals || nudgeOvertakenRivals;
  const settings = dependencies.appSettings || defaultAppSettings;
  const logger = dependencies.logger || console;
  const workBudget = dependencies.raceResolutionWorkBudget || defaultWorkBudget;
  const postTaskHandoff =
    dependencies.raceResolutionPostTaskHandoff || defaultPostTaskHandoff;
  const displayArtifactStore =
    dependencies.raceResolutionDisplayArtifact || defaultDisplayArtifactStore;
  const buildInputFingerprint =
    dependencies.buildRaceResolutionInputFingerprint || defaultBuildInputFingerprint;
  const balanceConfig = dependencies.balanceConfig || defaultBalanceConfig;
  const buildStepSyncScope =
    dependencies.buildRaceResolutionStepSyncScope || defaultBuildStepSyncScope;
  const stepSyncScopeMatchesFence =
    dependencies.stepSyncScopeMatchesFence || defaultStepSyncScopeMatchesFence;
  const deliveryIntents =
    dependencies.raceResolutionDeliveryIntents || defaultDeliveryIntents;
  // Phase 2b shadow seam. Injectable so a test can assert the planner is NEVER
  // called with the flag off, and can force a planner failure.
  const buildDependencyClosure =
    dependencies.buildRaceScoringDependencyClosure || defaultBuildDependencyClosure;
  const wouldTrailMineEscalateProbe =
    dependencies.wouldTrailMineEscalate || defaultWouldTrailMineEscalate;
  const now = dependencies.now || (() => new Date());
  const leaseMs = dependencies.leaseMs ?? LEASE_MS;
  // Phase D hangs the Redis snapshot publish off this hook. It runs strictly
  // AFTER the Postgres commit — commit first, publish second (spec §5a item 5).
  // It also carries the two side effects Phase D step 8 takes off the
  // `/progress` request path and that nothing else covered: `expireEffects` and
  // the high-multiplier alert re-arm (see raceProgressSideEffects.js). The hook
  // is a no-op while `redisStandingsEnabled` is off, so the flag still gates
  // every behavior change on both sides of the split.
  const onCommitted =
    dependencies.onCommitted ||
    require("../services/raceProgressSideEffects").raceProgressPostCommit;

  const bootAt = dependencies.bootAt ?? Date.now();
  let oldQueueDrainedObserved = false;

  // (a) 60s quiet period after boot AND (b) one observation of the OLD table
  // with zero RUNNING-with-unexpired-lease rows. Once observed, the check is
  // never repeated: pm2 kills old workers within seconds of reload, so a single
  // clean observation proves the old bulk writer is gone. A missing old table
  // (post-contract restart) counts as drained.
  async function readyToClaim(currentTime) {
    if (Date.now() - bootAt < quietPeriodMs()) return false;
    if (oldQueueDrainedObserved) return true;
    try {
      const rows = await prisma.$queryRawUnsafe(
        `
        SELECT 1
        FROM race_resolution_jobs
        WHERE state = 'running'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at > $1
        LIMIT 1
        `,
        currentTime
      );
      if (rows.length === 0) {
        oldQueueDrainedObserved = true;
        return true;
      }
      return false;
    } catch (error) {
      // 42P01 undefined_table => the old table is gone; nothing to hand off from.
      if (error && (error.code === "42P01" || String(error.message || "").includes("does not exist"))) {
        oldQueueDrainedObserved = true;
        return true;
      }
      logger.error("[RACE_RESOLUTION_V2] old-queue drain check failed:", error);
      return false;
    }
  }

  async function claimingDisabled() {
    return (await settings.getUncachedFlag("raceQueueV2ClaimingDisabled")) === true;
  }

  // ── The fenced ownership protocol (§5a item 5). Ordering is NOT negotiable. ──
  //
  //   1. claim (elsewhere) mints a fresh lease token
  //   2. run the computation OUTSIDE any transaction, capturing its writes
  //   3. ONE write transaction:
  //        (i)   SELECT ... FOR UPDATE the job row WHERE id AND lease_token.
  //              Zero rows => abort immediately, having written NOTHING.
  //        (ii)  only as the verified lock-holder, write all participant rows,
  //              in ASCENDING userId order (the one global lock order)
  //        (iii) update the job row
  //        commit
  //
  // Fence-THEN-write, never write-then-fence: two workers can never both be
  // mid-flight on participant rows because the loser is turned away at the
  // job-row lock before its first participant write. The held job-row lock also
  // serializes this against raceExpiry, which acquires the same row.
  async function processOneUnbudgeted() {
    const currentTime = now();
    if (await claimingDisabled()) return null;
    if (!(await readyToClaim(currentTime))) return null;

    const job = await jobModel.claimNext({
      now: currentTime,
      leaseMs,
      leaseToken: newLeaseToken(),
    });
    if (!job) return null;

    // ── Phase 2b: the dependency-closure planner, in SHADOW MODE. ──────────
    //
    // Runs after the claim and strictly BEFORE plan selection, because that
    // is where Phase 3 will consume it. Nothing below reads `closureShadow`
    // except the commit log line: it cannot select a plan, change a write,
    // add or skip a post-task, or fail the job. A planner throw is caught,
    // logged as a shadow failure, and dropped — the job then proceeds exactly
    // as it would have with the flag off.
    //
    // Sits ABOVE the `startMs` bind so `coreMs` stays comparable across the
    // flag flip: the shadow's cost is reported ONLY as `shadowPlannerMs`,
    // never folded into the series the rollout gate reads.
    //
    // Ordering note (zero off-flag overhead): the candidate-shape test is a
    // PURE array comparison against the gatekeeper's own admitted reason sets
    // and runs FIRST, so a non-candidate envelope does no work at all — not
    // even a settings read. A candidate envelope with the flag off costs one
    // `getFlag` against the same warm appSettings cache the four flag reads
    // below already use, and zero database queries.
    // ── Phase 3 restructure: the planner runs ONCE per claim. ──────────────
    //
    // Phase 2b ran it purely for the log. Phase 3 also needs its verdict to
    // SELECT a plan, and running it twice would double the planner's cost on
    // exactly the big races it exists to speed up, and — worse — could produce
    // two different graph reads for one generation, so the plan committed and
    // the plan logged would describe different worlds. One call, two consumers.
    //
    // The two flags are independent in BOTH directions (spec rollout item 4).
    // Shadow-only = observe, never select. Write-only = select, and the same
    // result still fills the `shadow*` log fields so the rollout series does not
    // go blind the moment the write flag comes on. Both off = the planner is
    // never constructed and no settings read past the pure reason-set test
    // happens at all.
    let closureShadow = NULL_CLOSURE_SHADOW_FIELDS;
    // `closurePlan` is non-null ONLY when the write flag is on, the planner
    // returned DEPENDENCY_CLOSURE, and the Trail-Mine escalation cleared. It is
    // the single gate every closure behavior below reads.
    let closurePlan = null;
    // bool when a closure plan was evaluated, null when none was (the flag is
    // off, the envelope is not candidate-shaped, or the planner said FULL).
    let closureEscalatedOnMine = null;
    {
      if (isClosureEligibleReasonSet(job.processingDirtyReasons)) {
        // Two DISTINCT keys, never conflated. The shadow key means "observe";
        // the V1 key means "commit subset results". Reading one for the other
        // would make the Phase 3 deploy flip every environment already running
        // the measurement straight into writing.
        const closureShadowEnabled = await isStrictFlagEnabled(
          settings,
          "raceResolutionDependencyClosureShadowV1Enabled"
        );
        const closureWritesEnabled = await isStrictFlagEnabled(
          settings,
          "raceResolutionDependencyClosureV1Enabled"
        );
        if (closureShadowEnabled || closureWritesEnabled) {
          const shadowStartedAt = Date.now();
          try {
            const shadowConfig = await balanceConfig.getSnapshot();
            const shadowResult = await buildDependencyClosure({
              raceId: job.raceId,
              dirtyParticipantIds: job.processingDirtyParticipantIds,
              job,
              now: now(),
              Race: raceModel,
              RaceActiveEffect: effectModel,
              RaceParticipant: participantModel,
              balanceConfigVersion: shadowConfig?.version ?? null,
              // ONE fingerprint seam for the whole generation. Without this the
              // planner lazily resolves the shipped module itself while the
              // fence uses this worker's injected dependency — two different
              // code paths computing the digest that must match each other, and
              // a test can only ever see one of them.
              buildInputFingerprint,
            });
            const plannerMs = Math.max(0, Date.now() - shadowStartedAt);
            if (closureShadowEnabled) {
              closureShadow = summarizeClosureShadow(
                shadowResult,
                plannerMs,
                wouldTrailMineEscalateProbe
              );
            }
            if (
              closureWritesEnabled &&
              shadowResult &&
              shadowResult.plan === "DEPENDENCY_CLOSURE"
            ) {
              // ── TRAIL_MINE escalation (spec core rule 3). ────────────────
              //
              // Evaluated HERE — before the resolve, before the fence, before
              // any write — so an escalation costs a plan selection and nothing
              // else. "Zero partial writes" is therefore structural, not a
              // rollback: the closure path is simply never entered.
              //
              // The predicate runs over the full-field projection the planner
              // already assembled from its fingerprint read: fresh totals for
              // closure participants, persisted `total_steps` for every other
              // accepted row. Note the predicate SKIPS closure members outright
              // (they detonate in-closure exactly as FULL would), so the only
              // rows it reads are the non-closure ones — which is precisely why
              // no fresh score is needed to answer it and no second query is
              // issued.
              //
              // Tri-state, and "UNKNOWN" (a legacy pre-2026-08-07 mine with no
              // `aheadParticipantIds` and no pre-generation total) ESCALATES.
              // Answering "no" to a question we did not answer would send the
              // mine to the wrong player — `candidates[0]` is the LOWEST-total
              // crosser — and the mine then EXPIREs, which is unrecoverable.
              let escalate = false;
              if (shadowResult.minesActive === true) {
                try {
                  escalate =
                    wouldTrailMineEscalateProbe({
                      mines: shadowResult.mines,
                      closureIds: shadowResult.participantIds,
                      participantTotals: shadowResult.participantTotals,
                    }) !== false;
                } catch {
                  // Fail CLOSED. An unanswerable predicate is an escalation.
                  escalate = true;
                }
              }
              closureEscalatedOnMine = escalate;
              if (!escalate) closurePlan = shadowResult;
            }
          } catch (error) {
            // The duration is still honest and still useful (a timeout is the
            // failure mode worth measuring); every other field stays null. With
            // the write flag on, a planner throw leaves `closurePlan` null, so
            // the job proceeds down the existing FULL path unchanged.
            if (closureShadowEnabled) {
              closureShadow = {
                ...NULL_CLOSURE_SHADOW_FIELDS,
                shadowPlannerMs: Math.max(0, Date.now() - shadowStartedAt),
              };
            }
            logger.error(JSON.stringify({
              event: "race_resolution_v2_shadow_error",
              operation: "dependency_closure_planner",
              errorCode: String(error?.code || "SHADOW_PLANNER_ERROR"),
              // A race id is not user data; without it a failure spike cannot
              // be correlated to the race that provokes it.
              raceId: job.raceId,
            }));
          }
        }
      }
    }

    const startMs = Date.now();
    const triggeringUserIds = Array.isArray(job.processingTriggeredByUserIds)
      ? job.processingTriggeredByUserIds.filter(Boolean)
      : [];
    const orderedTriggeringUserIds = [...new Set(triggeringUserIds)].sort();

    try {
      // ── Step 2: computation, outside every transaction. ──────────────────
      const reasonAwareEnabled = await isStrictFlagEnabled(
        settings,
        "raceResolutionReasonAwareV1Enabled"
      );
      const baseResolutionPlan = reasonAwareEnabled
        ? resolutionPlanForDirtyReasons(job.processingDirtyReasons)
        : "FULL";
      let result = null;
      let computeMs = 0;
      const bulkWritesEnabled = await isStrictFlagEnabled(
        settings,
        "raceResolutionBulkWriteV1Enabled"
      );
      const burstCoalescingEnabled = await isStrictFlagEnabled(
        settings,
        "raceResolutionBurstCoalescingV1Enabled"
      );
      let superseded = false;
      let discarded = false;
      let writeMs = 0;
      let participantWrites = [];
      let resolutionPlan = baseResolutionPlan;
      let forceFull = false;
      let artifactHit = false;
      let artifactFallbackReason = null;
      // Aggregate count only — how many times a closure was turned away at the
      // fence for this claim. Never an id, a total, or a reason string.
      let closureCommittedRejections = 0;

      for (;;) {
        let artifactPayload = null;
        let stepSyncScope = null;
        let capture = null;
        const artifactEnabled = !forceFull && await isStrictFlagEnabled(
          settings,
          "raceResolutionDisplayArtifactReuseV1Enabled"
        );
        if (
          artifactEnabled &&
          job.processingDisplayArtifactId &&
          baseResolutionPlan === "FULL"
        ) {
          const loaded = await displayArtifactStore.load({
            id: job.processingDisplayArtifactId,
            digest: job.processingDisplayArtifactDigest,
            schema: job.processingDisplayArtifactSchema,
            raceId: job.raceId,
            timeZone: job.processingTimeZone || "UTC",
          });
          if (!loaded) {
            artifactFallbackReason = "load_or_envelope_mismatch";
          } else if (!artifactMatchesClaim(loaded, job)) {
            artifactFallbackReason = "claim_mismatch";
          } else {
            const config = await balanceConfig.getSnapshot();
            const fingerprint = await buildInputFingerprint({
              raceId: job.raceId,
              now: now(),
              balanceConfigVersion: config.version,
            });
            if (
              fingerprint?.digest === loaded.inputFingerprint &&
              String(config.version ?? "code-default") ===
                String(loaded.balanceConfigVersion ?? "code-default")
            ) {
              artifactPayload = loaded;
            } else {
              artifactFallbackReason = "input_or_config_mismatch";
            }
          }
        }

        if (artifactPayload) {
          resolutionPlan = "ARTIFACT_REUSE";
          capture = { writes: artifactPayload.writes };
          result = artifactPayload.result;
        } else {
          resolutionPlan = baseResolutionPlan;
          capture = createWriteCapture({ participantModel, effectModel, eventModel });
          result = null;
          if (!forceFull && reasonAwareEnabled && resolutionPlan === "FULL") {
            stepSyncScope = await buildStepSyncScope(job, {
              Race: raceModel,
              RaceActiveEffect: effectModel,
            });
          }
          if (stepSyncScope) {
            resolutionPlan = stepSyncScope.plan;
            result = stepSyncScope.result;
          } else if (resolutionPlan === "FULL") {
            // Precedence (spec rule 1): artifact → cheap committed scope →
            // closure → FULL. `forceFull` (the retry loop's second pass, and the
            // path a rejected fence takes) disables the closure exactly as it
            // disables the artifact, so a rejected closure can never be retried
            // as another closure.
            //
            // The cheap STEP_SYNC_COMMITTED scope above stays ahead of the
            // closure deliberately: it fires only on a race with ZERO active
            // effects, where the closure would compute the same rows for more
            // work. Nothing shipped changes ordering here.
            const useClosure = !forceFull && closurePlan != null;
            const computeStartedAt = Date.now();
            const computeResolve = buildResolveRaceState({
              Race: raceModel,
              RaceParticipant: capture.participants,
              RaceActiveEffect: capture.effects,
              RacePowerupEvent: capture.events,
              now,
            });
            const processed = await computeResolve({
              raceId: job.raceId,
              userIds: triggeringUserIds,
              timeZone: job.processingTimeZone || "UTC",
              // Additive and null on every non-closure run, so the FULL path is
              // byte-for-byte what it was.
              ...(useClosure
                ? { scoreParticipantIds: closurePlan.participantIds }
                : {}),
            });
            result = Array.isArray(processed) ? processed[0] : null;
            computeMs += Math.max(0, Date.now() - computeStartedAt);
            // Only after a result actually came back: a null result means the
            // race was skipped (settled/ended) and no plan was executed.
            if (useClosure && result) resolutionPlan = "DEPENDENCY_CLOSURE";
          }
        }

        const userIdByParticipant = new Map();
        for (const participant of result?.race?.participants || []) {
          userIdByParticipant.set(participant.id, participant.userId);
        }
        const sortKey = (write) =>
          `${userIdByParticipant.get(write.participantId) ?? "￿"}:${write.participantId}`;
        const participantById = new Map(
          (result?.race?.participants || []).map((participant) => [
            participant.id,
            participant,
          ])
        );
        const candidateParticipantWrites = capture.writes.filter(
          (write) => write.kind === "participantTotal" || write.kind === "participantBonus"
        );
        participantWrites = retainTeamAsOfHeartbeat(
          candidateParticipantWrites,
          candidateParticipantWrites.filter((write) =>
            participantTotalWriteChangesRow(write, participantById.get(write.participantId))
          ),
          result?.race?.isTeamRace === true
        ).sort((left, right) => sortKey(left).localeCompare(sortKey(right)));
        const sideWrites = capture.writes.filter(
          (write) => write.kind === "effectUpdate" || write.kind === "eventCreate"
        );

        // ── Step 3: the ONE write transaction. ─────────────────────────────
        let artifactRejectedAtFence = false;
        let stepSyncRejectedAtFence = false;
        let closureRejectedAtFence = false;
        const closureCommitting = resolutionPlan === "DEPENDENCY_CLOSURE";
        const writeStartedAt = Date.now();
        await prisma.$transaction(async (tx) => {
        // (i) fence
        const fenced = await jobModel.acquireForWrite(tx, {
          id: job.id,
          expectedLeaseToken: job.leaseToken,
        });
        if (!fenced) throw new FenceLostError();

        if (artifactPayload) {
          const currentConfig = await balanceConfig.getSnapshot();
          const fingerprint = await buildInputFingerprint({
            raceId: job.raceId,
            now: now(),
            balanceConfigVersion: currentConfig.version,
            client: tx,
          });
          if (
            Number(fenced.generation) !== Number(fenced.processingGeneration) ||
            !artifactMatchesClaim(artifactPayload, fenced) ||
            fingerprint?.digest !== artifactPayload.inputFingerprint ||
            String(currentConfig.version ?? "code-default") !==
              String(artifactPayload.balanceConfigVersion ?? "code-default") ||
            !(await rebindArtifactPresentation(tx, artifactPayload))
          ) {
            artifactRejectedAtFence = true;
            return;
          }
        }

        if (stepSyncScope) {
          const generationIsCurrent =
            Number(fenced.generation) === Number(fenced.processingGeneration);
          const inputsStillMatch = generationIsCurrent &&
            await stepSyncScopeMatchesFence(stepSyncScope, tx, job.raceId);
          if (!inputsStillMatch) {
            stepSyncRejectedAtFence = true;
            return;
          }
        }

        // ── Closure fence re-verify (spec rule 7). ─────────────────────────
        //
        // Atomic, inside the SAME transaction that holds the job row, and
        // strictly BEFORE the first participant write. Any mismatch returns
        // having written nothing and retries the generation as FULL — a stale
        // closure is never committed.
        //
        // ONE re-read covers four of the five required checks, because
        // `buildRaceResolutionInputFingerprint` already digests all of them:
        // the graph (active effects + the schema-2 EXPIRED LEECH/HITCHHIKE
        // rows), MEMBERSHIP (every participant row, so a join/leave/forfeit or
        // an accepted-status change moves the digest), the accepted members'
        // `user_scoring_input_versions.generation`, and the race row itself.
        // Re-deriving those separately would be a second fingerprint
        // implementation, which rule 7 prohibits.
        //
        // The remaining two are checked explicitly:
        //   * job generation — a newer generation arrived, so this plan was
        //     computed against a superseded dirty set;
        //   * the closure's exclusive validity deadline — a boundary the
        //     planner could SEE may now have crossed. `validUntil` is a
        //     NECESSARY condition only; the digest above is what makes the
        //     write safe, and it stays mandatory inside the window.
        //   * a due expiry landing on a NON-closure participant. See
        //     `dueExpiryOutsideClosureAtFence` — the planner's own veto is
        //     evaluated at its `asOf` and cannot cover this.
        if (closureCommitting) {
          const currentConfig = await balanceConfig.getSnapshot();
          const fingerprint = await buildInputFingerprint({
            raceId: job.raceId,
            now: now(),
            balanceConfigVersion: currentConfig.version,
            client: tx,
          });
          const deadline = closurePlan.validUntil
            ? new Date(closurePlan.validUntil).getTime()
            : null;
          if (
            Number(fenced.generation) !== Number(fenced.processingGeneration) ||
            !fingerprint ||
            fingerprint.digest !== closurePlan.graphFingerprint ||
            deadline == null ||
            !Number.isFinite(deadline) ||
            now().getTime() >= deadline ||
            dueExpiryOutsideClosureAtFence(
              fingerprint.activeEffects,
              closurePlan.participantIds,
              now()
            )
          ) {
            closureRejectedAtFence = true;
            return;
          }
        }

        if (
          burstCoalescingEnabled &&
          supersededRunMayDiscard(fenced, now()) &&
          typeof jobModel.discardSuperseded === "function"
        ) {
          const outcome = await jobModel.discardSuperseded(
            { id: job.id, leaseToken: job.leaseToken, now: now() },
            tx
          );
          if (outcome.applied) {
            discarded = true;
            return;
          }
        }

        // (ii) participant rows, ascending userId
        if (bulkWritesEnabled) {
          await writeParticipantsBulk(tx, participantWrites, now());
        } else for (const write of participantWrites) {
          if (write.kind === "participantTotal") {
            await tx.raceParticipant.update({
              where: { id: write.participantId },
              data: {
                totalSteps: write.totalSteps,
                totalsUpdatedAt: now(),
                // The RAW walked total (2026-08-09). Same row, same UPDATE,
                // same fence, same ascending-userId ordering — no new writer
                // and no extra statement. The captured value is already
                // high-watered against the stored one. Omitted (never nulled)
                // when the capture carries none, so a caller without a raw
                // figure can't blank a healed row.
                ...(typeof write.rawSteps === "number" &&
                Number.isFinite(write.rawSteps)
                  ? { rawSteps: write.rawSteps }
                  : {}),
              },
            });
          } else {
            await tx.raceParticipant.update({
              where: { id: write.participantId },
              data: { bonusSteps: { decrement: write.amount } },
            });
          }
        }

        // Trail-mine bookkeeping (effect status + feed row) rides the same
        // transaction, so a detonation is all-or-nothing with the totals it
        // adjusted. Fire-once serialization comes free from the fence.
        for (const write of sideWrites) {
          if (write.kind === "effectUpdate") {
            await tx.raceActiveEffect.update({
              where: { id: write.id },
              data: write.fields,
            });
          } else {
            await tx.racePowerupEvent.create({ data: write.data });
          }
        }

        // (iii) job row
        const outcome = await jobModel.recordSuccess(
          {
            id: job.id,
            leaseToken: job.leaseToken,
            processingGeneration: job.processingGeneration,
            now: now(),
          },
          tx
        );
        if (!outcome.applied) throw new FenceLostError();
        superseded = outcome.superseded;
        },
      // Only short writes run inside the fence (the expensive replay already
      // happened outside it), but a large field is still N row updates — give it
      // headroom past Prisma's 5s default so a big race can never be aborted
      // mid-write by a transaction timeout.
        { timeout: 15_000, maxWait: 10_000 });
        writeMs += Math.max(0, Date.now() - writeStartedAt);

        if (artifactRejectedAtFence) {
          artifactFallbackReason = "fence_mismatch";
          forceFull = true;
          await displayArtifactStore.consume(job.processingDisplayArtifactId);
          continue;
        }
        if (stepSyncRejectedAtFence) {
          forceFull = true;
          continue;
        }
        if (closureRejectedAtFence) {
          // The graph, membership, an input generation, the job generation, or
          // the validity deadline moved under us. Nothing was written (the fence
          // returned before the first participant UPDATE). Retry the SAME
          // generation as FULL, which commits the current full state.
          closureCommittedRejections += 1;
          forceFull = true;
          continue;
        }
        if (artifactPayload) {
          artifactHit = true;
          await displayArtifactStore.consume(job.processingDisplayArtifactId);
        }
        break;
      }

      if (discarded) {
        logger.log(JSON.stringify({
          event: "race_resolution_v2",
          outcome: "superseded_discard",
          reasonClasses: job.processingDirtyReasons || ["FULL"],
          dirtyParticipantCount: job.processingDirtyParticipantIds?.length || 0,
          changedRows: 0,
          computeMs,
          writeMs,
          durationMs: Math.max(0, Date.now() - startMs),
        }));
        return { jobId: job.id, discarded: true };
      }

      // ── Post-commit. Everything below is best-effort and holds no lock. ──
      const postStartedAt = Date.now();
      const postTasksEnabled = await isStrictFlagEnabled(
        settings,
        "raceResolutionPostTasksV1Enabled"
      );
      let deferredSnapshotCommand = null;
      const deferredIntents = [];
      // These are decisions waiting to be claimed.  They must not touch a
      // cooldown/cap until the durable post-task row has won its generation
      // dedupe insert, and they are resolved inside that same transaction.
      const deferredIntentClaims = [];
      // DEPENDENCY_CLOSURE is ADMITTED here, not exempted (spec item 8): it must
      // never skip expireEffects, box consequences, the high-multiplier re-arm,
      // the snapshot, or one-attempt delivery just because the scoring was
      // scoped. It carries the same generation-time artifacts:
      //   * `result.race.participants` is the FULL accepted roster (R9), so the
      //     alert pass reads exactly the recipients a FULL run would;
      //   * `baseAdjustedByParticipantId` is SUBSET, and the guarantee that
      //     makes that safe is INCOMPLETE — read this carefully before enabling
      //     the flag. Two checks currently cover it, and neither is a proof:
      //       - the planner's DUE_EXPIRY_OUTSIDE_CLOSURE veto, evaluated at the
      //         planner's `asOf`; and
      //       - `dueExpiryOutsideClosureAtFence`, re-evaluated in the fence with
      //         POST_COMMIT_SLACK_MS of lookahead.
      //     `expireEffects` nevertheless runs post-commit against a still-later
      //     `now()`, so an effect on a NON-closure target that becomes due after
      //     the fence horizon can still have its `stepsAtExpiry` stamp silently
      //     skipped (expireEffects.js:56-59) and then be written EXPIRED
      //     permanently. The slack makes that window small, not empty.
      //     Closing it is Phase 4's pre-handoff re-check (spec item 8: "if a due
      //     effect or global boundary could cross between fence and post-commit
      //     handling, it selects FULL before writes"), and closure enablement is
      //     gated on that work landing;
      //   * the snapshot is assembled by `computePersistedSnapshot`, which
      //     re-reads the committed rows. No second full score recompute happens
      //     on any plan, so no closure-specific approximation exists to make.
      if (
        resolutionPlan === "FULL" ||
        resolutionPlan === "ARTIFACT_REUSE" ||
        resolutionPlan === "STEP_SYNC_COMMITTED" ||
        resolutionPlan === "DEPENDENCY_CLOSURE"
      ) {
        try {
          const outcome = await onCommitted({
            raceId: job.raceId,
            job,
            result,
            superseded,
            deferSnapshot: postTasksEnabled,
            deferDelivery: postTasksEnabled,
          });
          deferredSnapshotCommand = outcome?.snapshotCommand || null;
          if (Array.isArray(outcome?.intents)) deferredIntentClaims.push(...outcome.intents);
        } catch (error) {
          logger.error("[RACE_RESOLUTION_V2] post-commit hook error:", error);
        }
      }

      // Box state / powerup-slot sync for EVERY user in the processing snapshot
      // (§5a item 2) — coalescing must not lose a triggering user's box roll.
      if (result) {
        const boxByUser = result.boxEffectiveStepsByUser || {};
        for (const triggerUserId of orderedTriggeringUserIds) {
          try {
            const syncResult = await syncRacePowerupState({
              raceId: result.raceId,
              userId: triggerUserId,
              race: result.race,
              boxEffectiveSteps: boxByUser[triggerUserId] ?? null,
            });
            // C3 / spec v9 item 2: this is the ONLY place an in-race box is
            // minted once Phase D is on, so it is the only place that can tell
            // the viewer's next `/progress` poll a box appeared. Record it for
            // the toast; the overlay consumes it. Best-effort and flag-gated —
            // a Redis hiccup costs a celebration, never a box.
            await recentBoxMints.record({
              userId: triggerUserId,
              raceId: result.raceId,
              syncResult,
            });
          } catch (error) {
            logger.error(JSON.stringify({
              event: "race_resolution_v2_post_error",
              operation: "powerup_state_sync",
              errorCode: error?.code || "POST_WORK_ERROR",
            }));
          }
        }

        for (const triggerUserId of orderedTriggeringUserIds) {
          try {
            await nudge({
              raceResults: [result],
              userId: triggerUserId,
              participantModel,
              requestStepSyncForUsers: postTasksEnabled
                ? async (recipientIds) => {
                  try {
                    deferredIntentClaims.push({
                      kind: "STEP_SYNC",
                      recipientIds: [...new Set(recipientIds || [])],
                      raceId: job.raceId,
                      sourceGeneration: job.processingGeneration,
                      deliveryKind: "NUDGE",
                    });
                  } catch (error) {
                    // Preserve the current delivery immediately when an
                    // immutable cooldown reservation cannot be made.
                    logger.error(JSON.stringify({
                      event: "race_resolution_v2_post_error",
                      operation: "nudge_intent_claim",
                      errorCode: error?.code || "INTENT_CLAIM_ERROR",
                    }));
                    await requestStepSyncForUsers(recipientIds);
                  }
                }
                : requestStepSyncForUsers,
            });
          } catch (error) {
            logger.error("[RACE_RESOLUTION_V2] overtake nudge error:", error);
          }
        }
      }

      // Creation happens only after every stateful/RNG/recipient decision above
      // has finished. The payload contains only already-claimed immutable
      // transport intents plus the generation-level publication command.
      if (postTasksEnabled && deferredSnapshotCommand) {
        try {
          const resolveIntents = async (client) => {
            const resolved = [];
            for (const claim of deferredIntentClaims) {
              if (claim?.kind === "HIGH_MULTIPLIER") {
                resolved.push(...await deliveryIntents.claimHighMultiplier(claim.data, {
                  sourceGeneration: claim.sourceGeneration,
                  client,
                  participantClaim: claim.participantClaim,
                }));
              } else if (claim?.kind === "STEP_SYNC") {
                resolved.push(...await deliveryIntents.claimStepSync(claim.recipientIds, {
                  raceId: claim.raceId,
                  sourceGeneration: claim.sourceGeneration,
                  kind: claim.deliveryKind,
                  client,
                }));
              }
            }
            return resolved;
          };
          await postTaskHandoff({
            raceId: job.raceId,
            sourceGeneration: job.processingGeneration,
            snapshotCommand: deferredSnapshotCommand,
            intents: deferredIntents,
            resolveIntents,
          });
        } catch (error) {
          // A created row remains recoverable by the runner; never issue an
          // uncoordinated second snapshot attempt after an ambiguous handoff.
          logger.error(JSON.stringify({
            event: "race_resolution_v2_post_error",
            operation: "post_task_handoff",
            errorCode: error?.code || "POST_HANDOFF_ERROR",
          }));
        }
      }

      logger.log(JSON.stringify({
        event: "race_resolution_v2",
        outcome: superseded ? "superseded_commit" : "commit",
        reasonClasses: job.processingDirtyReasons?.length
          ? job.processingDirtyReasons
          : ["FULL"],
        resolutionPlan,
        artifactHit,
        artifactFallbackReason,
        dirtyParticipantCount: job.processingDirtyParticipantIds?.length || 0,
        fullParticipantCount: result?.race?.participants?.length || 0,
        triggeringUserCount: triggeringUserIds.length,
        changedRows: new Set(participantWrites.map((write) => write.participantId)).size,
        computeMs,
        writeMs,
        postTaskMs: Math.max(0, Date.now() - postStartedAt),
        coreMs: Math.max(0, Date.now() - startMs),
        queueLagMs: Math.max(0, startMs - new Date(job.requestedAt).getTime()),
        // Additive, aggregate-only Phase 2b shadow dimensions. They are
        // populated ONLY when the shadow flag is on: with just the write flag
        // on, the planner still runs (once) but every `shadow*` field is null,
        // and the plan it chose is reported by `resolutionPlan` instead. Both
        // flags on = both, from that same single planner call.
        ...closureShadow,
        // Phase 3, aggregate-only. `null` when no closure plan was evaluated
        // (write flag off, envelope not candidate-shaped, or the planner said
        // FULL); `true` when an active mine had a non-closure candidate or an
        // UNKNOWN answer and the generation was escalated to FULL before any
        // write; `false` when a closure ran with the mine question answered no.
        closureEscalatedOnMine,
        closureFenceRejections: closureCommittedRejections,
        sqlCount: typeof dependencies.sqlCount === "function" ? dependencies.sqlCount() : null,
      }));
      return job;
    } catch (error) {
      if (error instanceof FenceLostError) {
        // Lost the lease mid-run. Nothing was written and the job row belongs to
        // whoever re-claimed it — recording a failure here would stomp them.
        logger.log(JSON.stringify({
          event: "race_resolution_v2",
          outcome: "fence_lost",
          reasonClasses: job.processingDirtyReasons || ["FULL"],
        }));
        return job;
      }
      logger.error(JSON.stringify({
        event: "race_resolution_v2",
        outcome: "failed",
        reasonClasses: job.processingDirtyReasons || ["FULL"],
        errorCode: error?.code || "WORKER_ERROR",
        // Diagnosability for raw-query failures (dependency-closure spec,
        // rollout item 7). Under the pg driver adapter (src/db.js) the
        // SQLSTATE lives at meta.driverAdapterError.cause.originalCode —
        // meta.code is undefined there; it only carries the SQLSTATE on the
        // non-adapter engine. Log the bare five-char code only — never SQL
        // text, IDs, raw steps, or tokens.
        sqlState: (() => {
          const s =
            error?.meta?.driverAdapterError?.cause?.originalCode ??
            error?.meta?.code;
          return typeof s === "string" && /^[0-9A-Z]{5}$/.test(s) ? s : null;
        })(),
      }));
      try {
        await jobModel.recordFailure({
          id: job.id,
          leaseToken: job.leaseToken,
          attempts: job.attempts,
          errorCode: error && error.code ? String(error.code) : "WORKER_ERROR",
          now: now(),
        });
      } catch (failureError) {
        logger.error("[RACE_RESOLUTION_V2] recordFailure failed:", failureError);
      }
      return job;
    }
  }

  async function processOne() {
    return workBudget.run("core", processOneUnbudgeted);
  }

  async function tick() {
    if (process.env.ASYNC_RACE_RESOLUTION_WORKER_DISABLED === "true") return 0;
    const concurrency = Math.min(
      3,
      Math.max(1, Number(process.env.ASYNC_RACE_RESOLUTION_CONCURRENCY) || 1)
    );
    return runBoundedRaceResolutionJobs(concurrency, processOne);
  }

  async function logQueueLag() {
    try {
      const lagMs = await jobModel.queueLagMs(now());
      const level = lagMs > QUEUE_LAG_ALARM_MS ? "warn" : "log";
      (logger[level] || logger.log).call(
        logger,
        `[RACE_RESOLUTION_V2] queue_lag_ms=${lagMs}` +
          (lagMs > QUEUE_LAG_ALARM_MS ? " ALARM(>30s) — raise ASYNC_RACE_RESOLUTION_CONCURRENCY" : "")
      );
      return lagMs;
    } catch (error) {
      logger.error("[RACE_RESOLUTION_V2] queue lag probe failed:", error);
      return null;
    }
  }

  return { processOne, tick, logQueueLag, readyToClaim, claimingDisabled, FenceLostError };
}

function scheduleRaceResolutionWorkerV2(dependencies = {}) {
  const logger = dependencies.logger || console;
  const worker = buildRaceResolutionWorkerV2(dependencies);

  let running = false;
  const interval = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await worker.tick();
    } catch (error) {
      logger.error("[RACE_RESOLUTION_V2] tick error:", error);
    } finally {
      running = false;
    }
  }, POLL_INTERVAL_MS);
  if (interval.unref) interval.unref();

  // Backpressure metric, once a minute (Phase A0 step (c) — shipped so before/
  // after lag is comparable across the C0 cutover).
  const lagInterval = setInterval(() => {
    worker.logQueueLag().catch(() => {});
  }, QUEUE_LAG_LOG_INTERVAL_MS);
  if (lagInterval.unref) lagInterval.unref();

  const stepSyncRequestModel =
    dependencies.StepSyncRequest || defaultStepSyncRequestModel;
  const cleanup = setInterval(() => {
    stepSyncRequestModel.cleanupExpired(new Date()).catch(() => {});
  }, CLEANUP_INTERVAL_MS);
  if (cleanup.unref) cleanup.unref();

  logger.log(
    "[CRON] Race-keyed (v2) resolution worker scheduled (poll 250ms, " +
      `${quietPeriodMs() / 1000}s startup quiet period)`
  );
  return { interval, lagInterval, cleanup, worker };
}

module.exports = {
  buildRaceResolutionWorkerV2,
  scheduleRaceResolutionWorkerV2,
  FenceLostError,
  createWriteCapture,
  runBoundedRaceResolutionJobs,
  quietPeriodMs,
  POLL_INTERVAL_MS,
  participantTotalWriteChangesRow,
  retainTeamAsOfHeartbeat,
  normalizeParticipantWrites,
  writeParticipantsBulk,
  supersededRunMayDiscard,
  resolutionPlanForDirtyReasons,
  summarizeClosureShadow,
  NULL_CLOSURE_SHADOW_FIELDS,
};
