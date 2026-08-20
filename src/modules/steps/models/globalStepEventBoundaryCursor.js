const crypto = require("node:crypto");
const { prisma: defaultPrisma } = require("../../../db");

const CURSOR_KEY = "global";
const LEASE_MS = 30_000;

function buildGlobalStepEventBoundaryCursorModel(prisma = defaultPrisma) {
  return {
    async claim({ now = new Date(), leaseMs = LEASE_MS } = {}) {
      const leaseToken = crypto.randomUUID();
      const rows = await prisma.$queryRawUnsafe(
        `UPDATE global_step_event_boundary_cursors
         SET lease_token=$2, lease_expires_at=$3, updated_at=$1
         WHERE key=$4
           AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= $1)
         RETURNING lease_token AS "leaseToken"`,
        now,
        leaseToken,
        new Date(now.getTime() + leaseMs),
        CURSOR_KEY
      );
      return rows[0] || null;
    },

    // Coalesce every missed start/end through the latest due boundary. One FULL
    // generation per active race computes the current truth; replaying every
    // historical intermediate state would add load without changing the result.
    async findLatestDue(claim, now = new Date()) {
      if (!claim?.leaseToken) return null;
      const rows = await prisma.$queryRawUnsafe(
        `WITH boundaries AS (
           SELECT starts_at AS boundary_at, id AS event_id, 'START'::text AS boundary_kind
           FROM global_step_events
           WHERE schedule_mode = 'LEGACY_GLOBAL'
           UNION ALL
           SELECT ends_at AS boundary_at, id AS event_id, 'END'::text AS boundary_kind
           FROM global_step_events
           WHERE schedule_mode = 'LEGACY_GLOBAL'
         )
         SELECT (EXTRACT(EPOCH FROM boundary.boundary_at) * 1000)::float8 AS "boundaryAtMs",
           boundary.event_id AS "eventId",
           boundary.boundary_kind AS "boundaryKind"
         FROM boundaries boundary
         CROSS JOIN global_step_event_boundary_cursors cursor
         WHERE cursor.key=$2 AND cursor.lease_token=$3
           AND boundary.boundary_at <= (to_timestamp($1::float8 / 1000) AT TIME ZONE 'UTC')
           AND (boundary.boundary_at, boundary.event_id, boundary.boundary_kind) >
             (cursor.boundary_at, cursor.event_id, cursor.boundary_kind)
         ORDER BY boundary.boundary_at DESC,
           boundary.event_id DESC,
           boundary.boundary_kind DESC
         LIMIT 1`,
        now.getTime(),
        CURSOR_KEY,
        claim.leaseToken
      );
      return rows[0] || null;
    },

    async advance(claim, boundary, now = new Date()) {
      if (!claim?.leaseToken || !boundary) return false;
      const count = await prisma.$executeRawUnsafe(
        `UPDATE global_step_event_boundary_cursors
         SET boundary_at=(to_timestamp($2::float8 / 1000) AT TIME ZONE 'UTC'),
           event_id=$3, boundary_kind=$4,
           lease_token=NULL, lease_expires_at=NULL, updated_at=$5
         WHERE key=$1 AND lease_token=$6`,
        CURSOR_KEY,
        Number(boundary.boundaryAtMs),
        boundary.eventId,
        boundary.boundaryKind,
        now,
        claim.leaseToken
      );
      return Number(count) === 1;
    },

    async release(claim, now = new Date()) {
      if (!claim?.leaseToken) return false;
      const count = await prisma.$executeRawUnsafe(
        `UPDATE global_step_event_boundary_cursors
         SET lease_token=NULL, lease_expires_at=NULL, updated_at=$2
         WHERE key=$1 AND lease_token=$3`,
        CURSOR_KEY,
        now,
        claim.leaseToken
      );
      return Number(count) === 1;
    },
  };
}

const GlobalStepEventBoundaryCursor = buildGlobalStepEventBoundaryCursorModel();

module.exports = {
  CURSOR_KEY,
  LEASE_MS,
  buildGlobalStepEventBoundaryCursorModel,
  GlobalStepEventBoundaryCursor,
};
