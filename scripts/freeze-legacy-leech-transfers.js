#!/usr/bin/env node
// Run during the Leech migration maintenance window, while all application
// writers are stopped. Defaults to a read-only preview; --apply persists only
// the approved legacy final transfer metadata under the ordinary C0 race fence.
process.env.DOTENV_CONFIG_QUIET = "true";

async function main(argv = process.argv.slice(2)) {
  const { prisma } = require("../src/db");
  const { computeRaceState } = require("../src/modules/races/services/computeRaceState");
  const { withRaceWriteFence } = require("../src/modules/races/services/raceWriteFence");
  const apply = argv.includes("--apply");
  const at = new Date();
  const previewComplete = new Error("ROLLBACK_LEECH_PREVIEW");
  let cursor = "";
  let scanned = 0;
  let frozen = 0;
  const skipped = [];
  while (true) {
    const rows = await prisma.$queryRawUnsafe(`SELECT effect.id, effect.race_id AS "raceId"
      FROM race_active_effects effect JOIN races race ON race.id=effect.race_id
      WHERE UPPER(effect.type::text)='LEECH' AND effect.expires_at <= $1
        AND UPPER(race.status::text)='ACTIVE'
        AND NOT (COALESCE(effect.metadata, '{}'::jsonb) ? 'leechFinalV1')
        AND NOT EXISTS (SELECT 1 FROM leech_expiry_checkpoints checkpoint WHERE checkpoint.effect_id=effect.id)
        AND effect.id > $2 ORDER BY effect.id LIMIT 100`, at, cursor);
    if (!rows.length) break;
    cursor = rows.at(-1).id;
    scanned += rows.length;
    const byRace = new Map();
    for (const row of rows) {
      if (!byRace.has(row.raceId)) byRace.set(row.raceId, []);
      byRace.get(row.raceId).push(row.id);
    }
    for (const [raceId, ids] of byRace) {
      const raceResults = [];
      const processRace = async (tx) => {
        const computed = await computeRaceState({ raceId,
          dependencies: { now: () => at, evaluateConsequences: false },
        });
        const stamps = new Map((computed.writes || [])
          .filter(write => write.kind === "effectUpdate" && write.fields?.metadata?.leechFinalV1)
          .map(write => [write.id, write.fields.metadata]));
        const existing = await tx.raceActiveEffect.findMany({ where: { id: { in: ids } }, select: { id: true, metadata: true } });
        for (const row of existing) {
          const metadata = row.metadata?.leechFinalV1 ? row.metadata : stamps.get(row.id);
          if (!metadata) {
            skipped.push({ effectId: row.id, raceId, reason: "race_or_participant_no_longer_live_resolvable" });
            continue;
          }
          let final = metadata.leechFinalV1;
          if (apply) {
            const saved = await tx.raceActiveEffect.update({ where: { id: row.id }, data: { metadata } });
            final = saved.metadata.leechFinalV1;
          }
          raceResults.push({ effectId: row.id, raceId, amount: final.amount, applied: apply });
        }
      };
      try {
        await withRaceWriteFence(raceId, async tx => {
          await processRace(tx);
          // Existing Hitchhike scoring can refresh captures; preview rolls back
          // the whole transaction, including those incidental writes.
          if (!apply) throw previewComplete;
        });
      } catch (error) {
        if (error !== previewComplete) throw error;
      }
      frozen += raceResults.length;
      for (const result of raceResults) process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  }
  process.stdout.write(`${JSON.stringify({ applied: apply, scanned, frozen, skipped })}\n`);
  if (skipped.length) process.exitCode = 2;
}

if (require.main === module) main().then(() => process.exit(process.exitCode || 0), error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
module.exports = { main };
