// Non-production /races benchmark (Phase A / §11). Seeds deterministic fixtures,
// then measures the OLD per-race query pattern vs the NEW bulk getRaces on the
// SAME machine/DB/fixtures: median/p95 wall time, response bytes, and Prisma
// query count. Aborts unless the DB is localhost or PERF_STAGING_OK=true.
//
// Query counting is done at the pg driver layer (patching Client/Pool.query
// before Prisma's adapter is constructed), so it counts every SQL statement
// Prisma issues. CAVEAT: this harness is single-user and SEQUENTIAL — it does NOT
// exercise the Phase C4 advisory-lock contention under concurrent load; that is
// validated separately by test/integration/raceResolutionLock.test.js.
require("dotenv").config();

// ── pg-level query counter (installed before db.js builds the pool) ──
const pg = require("pg");
let counting = false;
let queryCount = 0;
for (const Ctor of [pg.Client, pg.Pool]) {
  const orig = Ctor.prototype.query;
  if (orig && !orig.__perfPatched) {
    const patched = function (...args) {
      if (counting) queryCount += 1;
      return orig.apply(this, args);
    };
    patched.__perfPatched = true;
    Ctor.prototype.query = patched;
  }
}

const { prisma } = require("../../src/db");
const { generateFixtures } = require("./generateFixtures");
const { getRaces } = require("../../src/modules/races/queries/getRaces");
const { Race } = require("../../src/modules/races/models/race");
const { RaceActiveEffect } = require("../../src/modules/powerups/models/raceActiveEffect");
const { RacePowerup } = require("../../src/modules/powerups/models/racePowerup");

// Faithful reproduction of the PRE-optimization /races DB access pattern:
// findForUser (deep participant/accessory include) + a per-active-powerup-race
// Detour lookup, queued-count, and slot-inventory query. Mirrors the code this
// project replaced, so the before/after is apples-to-apples on the same fixtures.
async function baselineRaces(userId) {
  const races = await Race.findForUser(userId);
  for (const race of races) {
    if (race.status !== "ACTIVE" || !race.powerupsEnabled) continue;
    const mine = race.participants.find((p) => p.userId === userId);
    if (!mine) continue;
    await RaceActiveEffect.findActiveByTypeForParticipant(mine.id, "DETOUR_SIGN");
    await RacePowerup.countQueuedByParticipant(mine.id);
    await RacePowerup.findSlotPowerups(mine.id);
  }
  return races;
}

function stats(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return {
    median: +pct(50).toFixed(1),
    p95: +pct(95).toFixed(1),
    min: +sorted[0].toFixed(1),
    max: +sorted[sorted.length - 1].toFixed(1),
  };
}

async function measure(label, fn, { warmups = 5, runs = 30 } = {}) {
  for (let i = 0; i < warmups; i++) await fn();
  const times = [];
  counting = true;
  queryCount = 0;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  counting = false;
  const queriesPerRequest = Math.round(queryCount / runs);
  return { label, ...stats(times), queriesPerRequest };
}

async function run() {
  const active = Number(process.env.PERF_ACTIVE_RACES || 50);
  const participants = Number(process.env.PERF_PARTICIPANTS || 10);
  console.log(`Seeding ${active} active + 10 completed races, ${participants} participants/race...`);
  const { viewerUserId } = await generateFixtures({
    activeRaces: active,
    participantsPerRace: participants,
    completedRaces: 10,
  });

  // Byte size of the real serialized payload (new path).
  const payload = await getRaces(viewerUserId, false);
  const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");

  const before = await measure("OLD (per-race N+1)", () => baselineRaces(viewerUserId));
  const after = await measure("NEW (bulk getRaces)", () => getRaces(viewerUserId, false));

  console.log("\n=== /races benchmark (single-user, sequential; 5 warmups + 30 runs) ===");
  console.log(`fixture: ${active} active powerup races, ${participants} participants each, 10 completed`);
  console.log(`new-path response bytes: ${bytes} (${(bytes / 1024).toFixed(1)} KiB)`);
  for (const r of [before, after]) {
    console.log(
      `${r.label.padEnd(22)} median=${String(r.median).padStart(7)}ms  p95=${String(r.p95).padStart(7)}ms  ` +
        `min=${String(r.min).padStart(6)}ms max=${String(r.max).padStart(7)}ms  queries/req=${r.queriesPerRequest}`
    );
  }
  const improvement = before.median > 0 ? (1 - after.median / before.median) * 100 : 0;
  console.log(`\nmedian improvement: ${improvement.toFixed(1)}%  (target: >=50%, median<=750ms, p95<=1.5s)`);
}

run()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
