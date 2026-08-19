const ACTIVE_IMPACT_FLAG_KEY = "apiActiveImpactNoticesV1Enabled";
const ACTIVE_IMPACT_EPOCH_KEY = "apiActiveImpactNoticesV1EnabledFrom";

const BOUNDARY_TYPES_SQL = [
  "leg_cramp", "quicksand", "runners_high", "wrong_turn",
  "campfire_rest", "rainstorm", "uprising", "rally_flag", "coin_flip",
  "ghost_pepper", "umbrella", "drill_sergeant", "leech", "hitchhike",
].map((value) => `'${value}'`).join(", ");

function parseFenceRows(rows) {
  const byKey = new Map((rows || []).map((row) => [row.key, row.value]));
  const enabled = byKey.get(ACTIVE_IMPACT_FLAG_KEY) === true;
  const enabledFrom = new Date(byKey.get(ACTIVE_IMPACT_EPOCH_KEY));
  return {
    enabled,
    enabledFrom: Number.isFinite(enabledFrom.getTime()) ? enabledFrom : null,
  };
}

async function readActiveImpactRolloutFence(tx, { exclusive = false } = {}) {
  const lock = exclusive ? "FOR UPDATE" : "FOR SHARE";
  const rows = await tx.$queryRawUnsafe(
    `SELECT key, value
       FROM app_settings
      WHERE key IN ($1, $2)
      ORDER BY key ASC
      ${lock}`,
    ACTIVE_IMPACT_FLAG_KEY,
    ACTIVE_IMPACT_EPOCH_KEY,
  );
  return parseFenceRows(rows);
}

async function stampIneligibleDueEffects(tx, cutoff) {
  return tx.$executeRawUnsafe(
    `UPDATE race_active_effects effect
        SET metadata = COALESCE(effect.metadata, '{}'::jsonb)
          || '{"activeImpactResolutionSkippedVersion":1}'::jsonb,
            updated_at = CURRENT_TIMESTAMP
      WHERE effect.expires_at IS NOT NULL
        AND effect.expires_at <= $1::timestamp
        AND effect.status IN ('active_effect', 'expired_effect')
        AND effect.type IN (${BOUNDARY_TYPES_SQL})
        AND NOT EXISTS (
          SELECT 1
            FROM active_race_impact_work work
           WHERE work.race_id = effect.race_id
             AND work.source_kind = 'ACTIVE_EFFECT'
             AND work.source_id = effect.id
        )
        AND COALESCE(
          (effect.metadata->>'activeImpactResolutionSkippedVersion')::int,
          0
        ) <> 1`,
    cutoff.toISOString(),
  );
}

async function transitionActiveImpactFlag(tx, value, now = new Date()) {
  const current = await readActiveImpactRolloutFence(tx, { exclusive: true });
  const enabling = value === true && current.enabled !== true;
  if (enabling) {
    const enabledFrom = new Date(now);
    if (!Number.isFinite(enabledFrom.getTime())) {
      throw new TypeError("Invalid active-impact enablement time");
    }
    await stampIneligibleDueEffects(tx, enabledFrom);
    await tx.appSetting.upsert({
      where: { key: ACTIVE_IMPACT_EPOCH_KEY },
      update: { value: enabledFrom.toISOString() },
      create: { key: ACTIVE_IMPACT_EPOCH_KEY, value: enabledFrom.toISOString() },
    });
  }
  await tx.appSetting.upsert({
    where: { key: ACTIVE_IMPACT_FLAG_KEY },
    update: { value: value === true },
    create: { key: ACTIVE_IMPACT_FLAG_KEY, value: value === true },
  });
  return {
    enabled: value === true,
    enabledFrom: enabling ? new Date(now) : current.enabledFrom,
  };
}

function sourceResolvedUnderFence(fence, resolvedAt) {
  if (fence?.enabled !== true) return false;
  const time = new Date(resolvedAt);
  if (!Number.isFinite(time.getTime())) return false;
  return !fence.enabledFrom || time >= fence.enabledFrom;
}

module.exports = {
  ACTIVE_IMPACT_FLAG_KEY,
  ACTIVE_IMPACT_EPOCH_KEY,
  BOUNDARY_TYPES_SQL,
  readActiveImpactRolloutFence,
  stampIneligibleDueEffects,
  transitionActiveImpactFlag,
  sourceResolvedUnderFence,
};
