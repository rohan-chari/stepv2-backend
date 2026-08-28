const { prisma: defaultPrisma } = require("../../../db");

function buildHitchhikeAttributionCaptureModel(client = defaultPrisma) {
  return {
    async findByEffect(effectId) {
      return client.hitchhikeAttributionCapture.findUnique({
        where: { effectId },
      });
    },

    async findFrozen(effectId) {
      const row = await this.findByEffect(effectId);
      return row?.frozenAt ? row : null;
    },

    async readDailySteps(userId, localDate) {
      const row = await client.step.findUnique({
        where: { userId_date: { userId, date: localDate } },
        select: { steps: true },
      });
      return Math.max(0, Number(row?.steps) || 0);
    },

    // Serialize the coarse daily counter by target/day, then reserve only the
    // still-unowned suffix for this effect. This is durable source ownership:
    // a later sequential Hitchhike can begin at the same coarse counter but
    // can never reuse a delta already assigned to an earlier effect.
    async claimAndCreditCoarseDelta({
      effect,
      currentDailySteps,
      effectiveContributionAtRaw,
      copyRatio = 1,
      captureThrough,
    }) {
      const work = async (tx) => {
        await tx.$executeRawUnsafe(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          `hitchhike:${effect.targetUserId}`,
        );
        const rows = await tx.$queryRawUnsafe(
          `SELECT effect_id AS "effectId",
                  cast_daily_steps AS "castDailySteps",
                  cast_day_start AS "castDayStart",
                  coarse_source_from AS "coarseSourceFrom",
                  coarse_source_through AS "coarseSourceThrough",
                  coarse_raw_attributed AS "coarseRawAttributed",
                  coarse_effective_contribution AS "coarseEffectiveContribution",
                  frozen_at AS "frozenAt"
             FROM hitchhike_attribution_captures
            WHERE effect_id = $1
            FOR UPDATE`,
          effect.id,
        );
        const row = rows[0];
        if (!row || row.frozenAt) return { claimedRaw: 0, row };
        const prior = await tx.$queryRawUnsafe(
          `SELECT COALESCE(MAX(coarse_source_through), 0)::int AS "ownedThrough"
             FROM hitchhike_attribution_captures
            WHERE target_user_id = $1
              AND cast_day_start = $2::timestamp
              AND effect_id <> $3
              AND cast_sample_boundary_at <= $4::timestamp`,
          effect.targetUserId,
          new Date(row.castDayStart || effect.startsAt),
          effect.id,
          effect.startsAt,
        );
        const current = Math.max(0, Math.floor(Number(currentDailySteps) || 0));
        const sourceFrom = Math.max(
          Math.max(0, Number(row.castDailySteps) || 0),
          Math.max(0, Number(row.coarseSourceThrough) || 0),
          Math.max(0, Number(prior[0]?.ownedThrough) || 0),
        );
        const claimedRaw = Math.max(0, current - sourceFrom);
        if (claimedRaw === 0) return { claimedRaw: 0, row };
        const coarseSourceFrom = row.coarseSourceFrom == null
          ? sourceFrom
          : Math.max(0, Number(row.coarseSourceFrom) || 0);
        const scoreAt = typeof effectiveContributionAtRaw === "function"
          ? effectiveContributionAtRaw
          : (raw) => raw;
        const desiredEffectiveContribution = Math.floor(
          (Number(scoreAt(current)) - Number(scoreAt(coarseSourceFrom))) *
            (Number(copyRatio) || 1),
        );
        const updated = await tx.$queryRawUnsafe(
          `UPDATE hitchhike_attribution_captures
              SET coarse_source_from = COALESCE(coarse_source_from, $2),
                  coarse_source_through = $3,
                  coarse_raw_attributed = coarse_raw_attributed + $4,
                  coarse_effective_contribution = $5,
                  raw_source_kind = CASE
                    WHEN coarse_raw_attributed + $4 > raw_source_high_water
                    THEN 'COARSE_DAILY_DELTA'
                    ELSE raw_source_kind
                  END,
                  raw_source_high_water = GREATEST(
                    raw_source_high_water,
                    coarse_raw_attributed + $4
                  ),
                  effective_contribution = CASE
                    WHEN coarse_raw_attributed + $4 > raw_source_high_water
                    THEN $5
                    ELSE effective_contribution
                  END,
                  capture_through = CASE
                    WHEN coarse_raw_attributed + $4 > raw_source_high_water
                    THEN GREATEST(capture_through, $6::timestamp)
                    ELSE capture_through
                  END,
                  updated_at = now()
            WHERE effect_id = $1 AND frozen_at IS NULL
            RETURNING effect_id AS "effectId",
                      coarse_source_from AS "coarseSourceFrom",
                      coarse_source_through AS "coarseSourceThrough",
                      coarse_raw_attributed AS "coarseRawAttributed",
                      coarse_effective_contribution AS "coarseEffectiveContribution",
                      raw_source_kind AS "rawSourceKind",
                      raw_source_high_water AS "rawSourceHighWater",
                      effective_contribution AS "effectiveContribution",
                      capture_through AS "captureThrough",
                      frozen_at AS "frozenAt"`,
          effect.id,
          sourceFrom,
          current,
          claimedRaw,
          desiredEffectiveContribution,
          captureThrough,
        );
        return { claimedRaw: updated[0] ? claimedRaw : 0, row: updated[0] || row };
      };
      return typeof client.$transaction === "function"
        ? client.$transaction(work)
        : work(client);
    },

    // Compare-and-replace the canonical signed contribution. A scoring-input
    // generation supersedes an older generation; within one generation only a
    // monotonic source high-water / capture boundary may replace the row.
    // frozen_at is terminal, so settlement can never be reopened by a delayed
    // sync after the participant/effect/race boundary.
    async replaceV3({
      effect,
      raceTimezone,
      castDayStart,
      castDailySteps = 0,
      scoringInputGeneration = 0n,
      scoringInputFingerprint = null,
      rawSourceKind,
      rawSourceHighWater,
      effectiveContribution,
      captureThrough,
      frozenAt = null,
    }) {
      const rows = await client.$queryRawUnsafe(
        `INSERT INTO hitchhike_attribution_captures (
           effect_id, race_id, source_user_id, target_user_id,
           scoring_version, race_timezone, cast_day_start, cast_daily_steps,
           cast_sample_boundary_at, scoring_input_generation,
           scoring_input_fingerprint, raw_source_kind, raw_source_high_water,
           effective_contribution, capture_through, frozen_at,
           created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, 3, $5, $6::timestamp, $7,
           $8::timestamp, $9::bigint, $10, $11, $12, $13,
           $14::timestamp, $15::timestamp, now(), now()
         )
         ON CONFLICT (effect_id) DO UPDATE SET
           scoring_input_generation = EXCLUDED.scoring_input_generation,
           scoring_input_fingerprint = EXCLUDED.scoring_input_fingerprint,
           raw_source_kind = EXCLUDED.raw_source_kind,
           raw_source_high_water = EXCLUDED.raw_source_high_water,
           effective_contribution = EXCLUDED.effective_contribution,
           capture_through = EXCLUDED.capture_through,
           frozen_at = COALESCE(
             hitchhike_attribution_captures.frozen_at,
             EXCLUDED.frozen_at
           ),
           updated_at = now()
         WHERE hitchhike_attribution_captures.frozen_at IS NULL
           AND (
             EXCLUDED.scoring_input_generation >
               hitchhike_attribution_captures.scoring_input_generation
             OR (
               EXCLUDED.scoring_input_generation =
                 hitchhike_attribution_captures.scoring_input_generation
               AND EXCLUDED.raw_source_high_water >=
                 hitchhike_attribution_captures.raw_source_high_water
               AND EXCLUDED.capture_through >=
                 hitchhike_attribution_captures.capture_through
             )
           )
         RETURNING
           effect_id AS "effectId",
           effective_contribution AS "effectiveContribution",
           coarse_raw_attributed AS "coarseRawAttributed",
           coarse_effective_contribution AS "coarseEffectiveContribution",
           raw_source_kind AS "rawSourceKind",
           raw_source_high_water AS "rawSourceHighWater",
           capture_through AS "captureThrough",
           frozen_at AS "frozenAt"`,
        effect.id,
        effect.raceId,
        effect.sourceUserId,
        effect.targetUserId,
        raceTimezone,
        castDayStart,
        castDailySteps,
        effect.startsAt,
        scoringInputGeneration,
        scoringInputFingerprint,
        rawSourceKind,
        rawSourceHighWater,
        effectiveContribution,
        captureThrough,
        frozenAt,
      );
      if (rows[0]) return rows[0];
      return client.hitchhikeAttributionCapture.findUnique({
        where: { effectId: effect.id },
      });
    },

    async readScoringInput(userId) {
      const row = await client.userScoringInputVersion.findUnique({
        where: { userId },
        select: { generation: true, scoringWatermark: true },
      });
      return {
        generation: row?.generation ?? 0n,
        fingerprint: row?.scoringWatermark ?? null,
      };
    },
  };
}

const HitchhikeAttributionCapture = buildHitchhikeAttributionCaptureModel();

module.exports = {
  buildHitchhikeAttributionCaptureModel,
  HitchhikeAttributionCapture,
};
