const crypto = require("node:crypto");
const { assertCapacityDatabaseMarker } = require("../../src/localCapacitySafety");

const PRESERVED_TABLES = Object.freeze(["race_participants", "races", "users"]);
const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

const DEFAULT_SELECTORS = Object.freeze([]);

function validatedSelectors(selectors = []) {
  const selected = [...DEFAULT_SELECTORS, ...selectors];
  if (!selected.length) throw new Error("targeted reset requires an explicit audited selector allowlist");
  return selected.map((row) => {
    if (!SAFE_IDENTIFIER.test(row.table) ||
        !SAFE_IDENTIFIER.test(row.column) || !["user", "race"].includes(row.scope)) {
      throw new Error("targeted reset selector is unsafe");
    }
    return row;
  });
}

function buildResetPlan(columns = [], selectors = []) {
  const selected = validatedSelectors(selectors);
  const byTable = new Map();
  for (const row of columns) {
    const table = String(row.table_name || "");
    const column = String(row.column_name || "");
    if (!SAFE_IDENTIFIER.test(table) || !SAFE_IDENTIFIER.test(column)) {
      throw new Error("targeted reset schema contains an unsafe identifier");
    }
    const matching = selected.filter((selector) =>
      selector.table === table && selector.column === column);
    if (!matching.length) continue;
    const value = byTable.get(table) || { table, userColumns: [], raceColumns: [] };
    for (const selector of matching) {
      const target = selector.scope === "user" ? value.userColumns : value.raceColumns;
      if (!target.includes(column)) target.push(column);
    }
    byTable.set(table, value);
  }
  const tables = [...byTable.values()].map((row) => ({ ...row,
    userColumns: row.userColumns.sort(), raceColumns: row.raceColumns.sort(),
    userColumn: row.userColumns.length > 0, raceColumn: row.raceColumns.length > 0 }))
    .filter((row) => !PRESERVED_TABLES.includes(row.table) &&
      (row.userColumn || row.raceColumn)).sort((left, right) => left.table.localeCompare(right.table))
    .map(({ table, userColumn, raceColumn, userColumns, raceColumns }) =>
      ({ table, userColumn, raceColumn, userColumns, raceColumns }));
  return { schema: "bara-perf-reset-plan-v1", tables,
    preservedTables: [...PRESERVED_TABLES].sort() };
}

async function discoverResetPlan(prisma, selectors = []) {
  const selected = validatedSelectors(selectors);
  const columnNames = [...new Set(selected.map((row) => row.column))];
  const columns = await prisma.$queryRawUnsafe(`
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND column_name = ANY($1::text[])
     ORDER BY table_name, column_name
  `, columnNames);
  return buildResetPlan(columns, selectors);
}

function predicate(row, userParameter = "$1", raceParameter = "$2") {
  const parts = [];
  for (const column of row.userColumns || (row.userColumn ? ["user_id"] : [])) {
    parts.push(`"${column}"::text = ANY(${userParameter}::text[])`);
  }
  for (const column of row.raceColumns || (row.raceColumn ? ["race_id"] : [])) {
    parts.push(`"${column}"::text = ANY(${raceParameter}::text[])`);
  }
  return parts.join(" OR ");
}

function scopedPredicate(row, users, races) {
  const hasUsers = (row.userColumns || (row.userColumn ? ["user_id"] : [])).length > 0;
  const hasRaces = (row.raceColumns || (row.raceColumn ? ["race_id"] : [])).length > 0;
  const userParameter = "$1";
  const raceParameter = hasUsers ? "$2" : "$1";
  return { sql: predicate(row, userParameter, raceParameter),
    parameters: hasUsers && hasRaces ? [users, races] : hasUsers ? [users] : [races] };
}

async function targetedReset({ prisma, fixture, plan, env = process.env,
  verifyMarker = () => assertCapacityDatabaseMarker({ env }) } = {}) {
  if (!prisma || fixture?.runId == null || plan?.schema !== "bara-perf-reset-plan-v1") {
    throw new Error("targeted reset requires Prisma, fixture identity, and a versioned plan");
  }
  if (plan.tables.some((row) => !SAFE_IDENTIFIER.test(row.table) || PRESERVED_TABLES.includes(row.table) ||
      !row.userColumn && !row.raceColumn ||
      [...(row.userColumns || []), ...(row.raceColumns || [])].some((column) =>
        !SAFE_IDENTIFIER.test(column)))) throw new Error("targeted reset plan is unsafe");
  await verifyMarker();
  const users = fixture.ids?.users || [];
  const races = fixture.ids?.races || [];
  const participants = fixture.ids?.raceParticipants || [];
  const startedAt = Date.now();
  const deletedByTable = {};
  const proof = await prisma.$transaction(async (tx) => {
    const pending = [...plan.tables];
    for (let pass = 0; pending.length && pass <= plan.tables.length; pass += 1) {
      let progressed = false;
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        const row = pending[index];
        try {
          const scoped = scopedPredicate(row, users, races);
          const count = Number(await tx.$executeRawUnsafe(
            `DELETE FROM "${row.table}" WHERE ${scoped.sql}`, ...scoped.parameters));
          deletedByTable[row.table] = (deletedByTable[row.table] || 0) + count;
          pending.splice(index, 1); progressed = true;
        } catch (error) {
          if (!["P2003", "23503"].includes(error?.code)) throw error;
        }
      }
      if (!progressed) break;
    }
    if (pending.length) throw new Error(`targeted reset could not resolve FK order: ${pending.map((row) => row.table).join(", ")}`);
    if (users.length) {
      deletedByTable.step_samples = Number(await tx.$executeRawUnsafe(
        `DELETE FROM "step_samples" WHERE "user_id"::text = ANY($1::text[])`, users));
      deletedByTable.steps = Number(await tx.$executeRawUnsafe(
        `DELETE FROM "steps" WHERE "user_id"::text = ANY($1::text[])`, users));
      await tx.$executeRawUnsafe(
        `UPDATE "users"
            SET "last_step_sync_at" = NULL,
                "last_seen_at" = $2::timestamptz,
                "last_app_version" = '2.3.11'
          WHERE "id"::text = ANY($1::text[])`, users,
        fixture.userBaselineLastSeenAt || new Date(0).toISOString());
    }
    if (participants.length) {
      await tx.$executeRawUnsafe(`
        UPDATE "race_participants"
           SET "total_steps" = 1000,
               "raw_steps" = 1000,
               "totals_updated_at" = $2::timestamptz,
               "next_box_at_steps" = 5000,
               "bonus_steps" = 0,
               "max_bonus_steps" = 0,
               "max_box_progress_steps" = NULL,
               "last_notified_placement" = NULL,
               "high_multiplier_notified_at" = NULL
         WHERE "id"::text = ANY($1::text[])
      `, participants, fixture.participantBaselineAt || new Date(0).toISOString());
    }
    let remainingRunOwnedRows = 0;
    for (const row of plan.tables) {
      const scoped = scopedPredicate(row, users, races);
      const [result] = await tx.$queryRawUnsafe(
        `SELECT count(*)::int AS remaining FROM "${row.table}" WHERE ${scoped.sql}`,
        ...scoped.parameters);
      remainingRunOwnedRows += Number(result?.remaining || 0);
    }
    const digest = crypto.createHash("sha256").update(JSON.stringify({
      runId: fixture.runId, users: users.length, races: races.length,
      participants: participants.length, remainingRunOwnedRows,
    })).digest("hex");
    return { remainingRunOwnedRows, fixtureUserCount: users.length,
      fixtureRaceCount: races.length, fixtureParticipantCount: participants.length,
      checksum: digest };
  }, { maxWait: 5_000, timeout: 15_000 });
  if (proof.remainingRunOwnedRows !== 0) throw new Error("targeted reset left run-owned rows");
  return { schema: "bara-perf-targeted-reset-v1", runId: fixture.runId,
    deletedByTable, proof, durationSeconds: (Date.now() - startedAt) / 1000 };
}

module.exports = { DEFAULT_SELECTORS, PRESERVED_TABLES, buildResetPlan, discoverResetPlan, targetedReset };
