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
} = require("../services/raceResolutionStepSyncScope");
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
  if (!current || current.totalSteps !== write.totalSteps) return true;
  return (
    typeof write.rawSteps === "number" &&
    Number.isFinite(write.rawSteps) &&
    current.rawSteps !== write.rawSteps
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

function resolutionPlanForDirtyReasons(reasons) {
  return Array.isArray(reasons) &&
    reasons.length === 1 &&
    reasons[0] === "BOX_OPEN"
    ? "NO_SCORE"
    : "FULL";
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
      row.bonusDecrement += write.amount;
      continue;
    }
    if (write.kind !== "participantTotal" || !Number.isFinite(write.totalSteps)) {
      throw new Error("invalid participant total capture");
    }
    const hasRaw = Number.isFinite(write.rawSteps);
    if (
      row.hasTotal &&
      (row.totalSteps !== write.totalSteps ||
        row.hasRaw !== hasRaw ||
        (hasRaw && row.rawSteps !== write.rawSteps))
    ) {
      throw new Error("conflicting participant total capture");
    }
    row.totalSteps = write.totalSteps;
    row.hasTotal = true;
    row.rawSteps = hasRaw ? write.rawSteps : null;
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
            });
            result = Array.isArray(processed) ? processed[0] : null;
            computeMs += Math.max(0, Date.now() - computeStartedAt);
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
      if (
        resolutionPlan === "FULL" ||
        resolutionPlan === "ARTIFACT_REUSE" ||
        resolutionPlan === "STEP_SYNC_COMMITTED"
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
};
