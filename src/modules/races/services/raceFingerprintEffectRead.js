const { SETTLEMENT_EFFECT_TYPES } = require('./raceScoringEffectTypes');

// Full canonical projection, stamped in the same MVCC statement even when the
// race has no effects. Proof-only columns are stripped before hashing/scoring.
const EFFECT_SQL = `/* steps:prepared-read:v1 */ /* effect-fingerprint:full */
WITH effect_rows AS (
  SELECT id, target_participant_id AS "targetParticipantId",
    target_user_id AS "targetUserId", source_user_id AS "sourceUserId",
    powerup_id AS "powerupId", UPPER(type::text) AS type,
    CASE status WHEN 'active_effect' THEN 'ACTIVE'
      WHEN 'expired_effect' THEN 'EXPIRED' ELSE UPPER(status::text) END AS status,
    starts_at AS "startsAt", expires_at AS "expiresAt", metadata,
    updated_at AS "updatedAt", race_id AS "raceId", created_at AS "createdAt",
    (SELECT jsonb_object_agg(checkpoint.kind, to_jsonb(checkpoint))
     FROM leech_expiry_checkpoints checkpoint
     WHERE checkpoint.effect_id=race_active_effects.id
       AND NOT (COALESCE(race_active_effects.metadata, '{}'::jsonb) ? 'leechFinalV1')
       AND LEAST(race_active_effects.expires_at,
         (SELECT ends_at FROM races WHERE races.id=race_active_effects.race_id)) <= $3) AS "leechCheckpoint",
    NOT (COALESCE(metadata, '{}'::jsonb) ? 'leechFinalV1') AS "ef_checkpointEligible",
    (expires_at IS NULL OR expires_at=date_trunc('milliseconds',expires_at)) AND
    (starts_at IS NULL OR starts_at=date_trunc('milliseconds',starts_at)) AS "ef_precisionSafe"
  FROM race_active_effects WHERE race_id=$1
    AND (status='active_effect' OR (status='expired_effect' AND UPPER(type::text)=ANY($2::text[])))
)
SELECT effect.*, version.incarnation::text AS "ef_incarnation", version.revision::text AS "ef_revision",
  (EXTRACT(EPOCH FROM race.started_at)*1000)::float8 AS "ef_startedAt",
  (EXTRACT(EPOCH FROM race.ends_at)*1000)::float8 AS "ef_endsAt"
FROM races race LEFT JOIN race_effect_fingerprint_versions version ON version.race_id=race.id
LEFT JOIN effect_rows effect ON TRUE WHERE race.id=$1 ORDER BY effect.id`;

// The projection is evaluated once, before roster fan-out. A checkpoint's
// stored race_id is not authoritative; canonical SQL joins by effect_id only.
const CHECKPOINT_CTE = `effect_checkpoints AS MATERIALIZED (
  SELECT jsonb_object_agg(candidate.effect_id, candidate.checkpoints) AS checkpoints
  FROM (
    SELECT checkpoint.effect_id, jsonb_object_agg(checkpoint.kind, to_jsonb(checkpoint)) AS checkpoints
    FROM jsonb_to_recordset($2::jsonb) AS cached(id text, "expiresAt" timestamp)
    JOIN leech_expiry_checkpoints checkpoint ON checkpoint.effect_id=cached.id
    CROSS JOIN races race WHERE race.id=$1
      AND LEAST(cached."expiresAt", race.ends_at) <= $3
    GROUP BY checkpoint.effect_id
  ) candidate
)`;
const FINAL_COLUMNS = `effect_version.incarnation::text AS "ef_incarnation",
  effect_version.revision::text AS "ef_revision",
  CASE WHEN row_number() OVER (ORDER BY participant.id)=1
    THEN effect_checkpoints.checkpoints ELSE NULL END AS "ef_checkpoints"`;
const FINAL_JOINS = `LEFT JOIN race_effect_fingerprint_versions effect_version ON effect_version.race_id=race.id
  CROSS JOIN effect_checkpoints`;
const snapshots = new WeakMap();
const admitted = new WeakMap();
const MAX_ROWS = 20000, MAX_BYTES = 2 * 1024 * 1024, MAX_AGE_MS = 30000;
const clean = row => Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith('ef_')));
const proof = row => row?.ef_incarnation && /^\d+$/.test(row?.ef_revision || '')
  ? { incarnation: row.ef_incarnation, revision: row.ef_revision } : null;

async function loadEffects(client, raceId, now) {
  const raw = await client.$queryRawUnsafe(EFFECT_SQL, raceId, [...SETTLEMENT_EFFECT_TYPES, 'HITCHHIKE'], now);
  const effects = raw.filter(row => row.id).map(clean);
  return { raw, effects };
}
function bindEffectReadSnapshot(fingerprint, loaded, { raceId, now, balanceConfigVersion }) {
  const raw = loaded?.raw, stamp = proof(raw?.[0]);
  if (!fingerprint || !stamp || raw.length > MAX_ROWS ||
      raw.some(row => row.id && row.ef_precisionSafe !== true)) return fingerprint;
  const race = fingerprint.race;
  if (raw[0].ef_startedAt !== race.startedAt || raw[0].ef_endsAt !== race.endsAt) return fingerprint;
  const encoded = JSON.stringify(loaded.effects);
  if (Buffer.byteLength(encoded) > MAX_BYTES) return fingerprint;
  let deadline = now.getTime() + MAX_AGE_MS;
  for (const effect of loaded.effects) for (const date of [effect.startsAt, effect.expiresAt]) {
    const at = date == null ? NaN : new Date(date).getTime();
    if (at > now.getTime()) deadline = Math.min(deadline, at);
  }
  if (race.endsAt > now.getTime()) deadline = Math.min(deadline, race.endsAt);
  // The clone remains private. Final rows are cloned again before checkpoints
  // are attached; public fingerprint/scorer mutation cannot alter provenance.
  snapshots.set(fingerprint, {
    raceId, stamp, rows: structuredClone(loaded.effects),
    candidates: raw.filter(row => row.id && row.ef_checkpointEligible).map(row => ({ id: row.id, expiresAt: row.expiresAt == null ? null : row.expiresAt.toISOString() })),
    startedAt: race.startedAt, endsAt: race.endsAt, asOf: now.getTime(), deadline,
    config: String(balanceConfigVersion ?? 'code-default'),
  });
  return fingerprint;
}
function effectReadCandidate(fingerprint, { raceId, now, balanceConfigVersion }) {
  const snapshot = fingerprint && snapshots.get(fingerprint), at = now.getTime();
  if (!snapshot || snapshot.raceId !== raceId || !Number.isFinite(at) || at < snapshot.asOf ||
      at >= snapshot.deadline || Date.now() >= snapshot.deadline ||
      snapshot.config !== String(balanceConfigVersion ?? 'code-default')) return null;
  const token = Object.freeze({ checkpointJson: JSON.stringify(snapshot.candidates) });
  admitted.set(token, snapshot);
  return token;
}
function reuseEffects(token, row) {
  const candidate = token && admitted.get(token);
  const current = proof(row);
  if (!candidate || !current || current.incarnation !== candidate.stamp.incarnation ||
      current.revision !== candidate.stamp.revision || row.r_startedAt !== candidate.startedAt ||
      row.r_endsAt !== candidate.endsAt) return null;
  return structuredClone(candidate.rows).map(effect => ({
    ...effect, leechCheckpoint: row.ef_checkpoints?.[effect.id] ?? null,
  }));
}
module.exports = { loadEffects, bindEffectReadSnapshot, effectReadCandidate, reuseEffects,
  CHECKPOINT_CTE, FINAL_COLUMNS, FINAL_JOINS };
