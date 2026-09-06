const { Prisma } = require("@prisma/client");
const { prisma: defaultPrisma } = require("../../../db");

function collectRaceRows(value) {
  if (!value || typeof value !== "object") return [];
  if (typeof value.id === "string") return [value];
  return ["active", "pending", "completed"]
    .flatMap((key) => Array.isArray(value[key]) ? value[key] : []);
}

function buildAttachRaceViewerState(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  return async function attachRaceViewerState(value, userId) {
    const rows = collectRaceRows(value);
    const ids = [...new Set(rows.map((row) => row?.id).filter(Boolean))];
    if (!userId || ids.length === 0) return value;
    // One bounded viewer-overlay read for the whole response. Correlated EXISTS
    // checks avoid hydrating participant/scoring rosters and keep shared cache
    // fragments viewer-neutral.
    const cores = await prisma.$queryRaw(Prisma.sql`
      SELECT r.id,
             r.creator_id AS "creatorId",
             r.seed_id AS "seedId",
             r.tournament_id AS "tournamentId",
             r.creation_source AS "creationSource",
             r.start_policy AS "startPolicy",
             r.status::text AS status,
             r.rematch_root_race_id AS "rematchRootRaceId",
             r.series_id AS "seriesId",
             COALESCE(rs.enabled, false) AS "seriesEnabled",
             EXISTS (
               SELECT 1 FROM race_participants rp
                WHERE rp.race_id = r.id
                  AND rp.user_id = ${userId}
                  AND rp.status = 'accepted'::"RaceParticipantStatus"
             ) AS "viewerAccepted",
             (
               SELECT COUNT(*) FROM race_participants rp
                WHERE rp.race_id = r.id
                  AND rp.status = 'accepted'::"RaceParticipantStatus"
             ) AS "acceptedCount",
             EXISTS (
               SELECT 1 FROM races successor
                WHERE successor.series_predecessor_race_id = r.id
             ) AS "hasSeriesSuccessor",
             EXISTS (
               SELECT 1 FROM races descendant
                WHERE descendant.rematch_root_race_id = COALESCE(r.rematch_root_race_id, r.id)
                  AND descendant.status IN ('pending'::"RaceStatus", 'active'::"RaceStatus")
             ) AS "hasLiveRematch",
             EXISTS (
               SELECT 1 FROM races child
                WHERE child.rematch_source_race_id = r.id
                  AND child.status = 'completed'::"RaceStatus"
             ) AS "hasCompletedRematchChild",
             EXISTS (
               SELECT 1 FROM race_series_subscriptions subscription
                WHERE subscription.series_id = r.series_id
                  AND subscription.user_id = ${userId}
                  AND subscription.active = true
             ) AS subscribed
        FROM races r
        LEFT JOIN race_series rs ON rs.id = r.series_id
       WHERE r.id IN (${Prisma.join(ids)})
    `);
    const coreById = new Map(cores.map((row) => [row.id, row]));
    for (const output of rows) {
      const core = coreById.get(output.id);
      if (!core) continue;
      const recurringBlocksRematch = Boolean(
        core.seriesId && (core.seriesEnabled || core.hasSeriesSuccessor),
      );
      output.rematchEligible = Boolean(
        core.status === "completed" &&
        !core.seedId &&
        !core.tournamentId &&
        core.creationSource == null &&
        core.startPolicy == null &&
        core.viewerAccepted &&
        Number(core.acceptedCount) <= 100 &&
        !recurringBlocksRematch &&
        !core.hasCompletedRematchChild &&
        !core.hasLiveRematch,
      );
      if (core.seriesId) {
        output.series = {
          id: core.seriesId,
          enabled: core.seriesEnabled === true,
          subscribed: core.subscribed === true,
          canManage: core.creatorId === userId,
        };
      }
    }
    return value;
  };
}

const attachRaceViewerState = buildAttachRaceViewerState();

module.exports = { buildAttachRaceViewerState, attachRaceViewerState };
