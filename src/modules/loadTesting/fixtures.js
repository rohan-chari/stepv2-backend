const crypto = require("node:crypto");
const { signSessionToken } = require("../users/services/sessionToken");
const { assertCapacityDatabase } = require("../../localCapacitySafety");

const INTEGRITY_TABLES = ["users", "races", "race_participants", "steps", "step_samples"];

function assertRunId(runId) {
  if (!/^[a-z0-9][a-z0-9._-]{5,63}$/.test(runId)) throw new Error("runId must be 6-64 lowercase safe characters");
}

function assertFixtureDatabase(env = process.env) {
  if (env.CAPACITY_MODE === "true" || env.CAPACITY_MODE === "1") return assertCapacityDatabase(env.DATABASE_URL, env);
  const value = String(env.DATABASE_URL || "");
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("synthetic fixtures require a valid DATABASE_URL"); }
  const name = decodeURIComponent(parsed.pathname.slice(1)).toLowerCase();
  if (!parsed.hostname || !/(localhost|127\.0\.0\.1|::1)/i.test(parsed.hostname) && !/(^|[_-])(capacity|test)([_-]|$)/.test(name)) throw new Error("synthetic fixtures require a local or explicitly run-bound test database");
  if (!/(^|[-_])(integration|test|capacity)([-_]|$)/.test(name)) throw new Error("synthetic fixtures require a database name containing integration, test, or capacity");
  if (/(^|[-_])(prod|production|steptracker)([-_]|$)/.test(name)) throw new Error("synthetic fixtures categorically reject production databases");
  return { host: parsed.hostname, name };
}

async function baselineIntegrity(prisma) {
  const result = {};
  for (const table of INTEGRITY_TABLES) {
    const quoted = `"${String(table).replaceAll('"', '""')}"`;
    const rows = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS count, md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' ORDER BY to_jsonb(t)::text), '')) AS checksum FROM ${quoted} t`);
    result[table] = { count: Number(rows[0]?.count || 0), checksum: rows[0]?.checksum || crypto.createHash("md5").update("").digest("hex") };
  }
  return result;
}

async function assertNoSyntheticRows(prisma, ids) {
  const userIds = (Array.isArray(ids.users) ? ids.users : []).filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  const raceIds = (Array.isArray(ids.races) ? ids.races : []).filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (!userIds.length && !raceIds.length) return;
  const toArray = (values) => `ARRAY[${values.map((id) => `'${id}'`).join(",")}]::text[]`;
  const tables = await prisma.$queryRawUnsafe(`
    SELECT table_name,
           bool_or(column_name = 'user_id') AS has_user_id,
           bool_or(column_name = 'race_id') AS has_race_id
    FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name IN ('user_id', 'race_id')
    GROUP BY table_name
  `);
  for (const row of tables) {
    const predicates = [];
    if (row.has_user_id && userIds.length) predicates.push(`user_id::text = ANY(${toArray(userIds)})`);
    if (row.has_race_id && raceIds.length) predicates.push(`race_id::text = ANY(${toArray(raceIds)})`);
    if (!predicates.length) continue;
    const table = `"${String(row.table_name).replaceAll('"', '""')}"`;
    const rows = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS count FROM ${table} WHERE ${predicates.join(" OR ")}`);
    if (Number(rows[0]?.count || 0) !== 0) throw new Error(`synthetic cleanup leaked rows in ${row.table_name}`);
  }
}

async function createSyntheticFixtures({ prisma, runId, users = 1, races = 1, baseline = null, env = process.env }) {
  assertRunId(runId);
  assertFixtureDatabase(env);
  if (!Number.isInteger(users) || users < 1 || users > 5000 || !Number.isInteger(races) || races < 0 || races > 100) throw new Error("synthetic fixture counts are outside safe bounds");
  const before = baseline || await baselineIntegrity(prisma);
  const ids = { users: [], races: [], raceParticipants: [], steps: [], stepSamples: [] };
  const createdUsers = [];
  try {
  for (let index = 0; index < users; index += 1) {
    const marker = `load:${runId}:user:${index}`;
    const user = await prisma.user.create({ data: { appleId: `${marker}:apple`, email: `${marker}@synthetic.invalid`, displayName: marker } });
    ids.users.push(user.id);
    createdUsers.push({ ...user, token: signSessionToken({ userId: user.id, appleId: user.appleId }) });
  }
  const createdRaces = [];
  for (let index = 0; index < races; index += 1) {
    const race = await prisma.race.create({ data: { creatorId: createdUsers[0].id, name: `load:${runId}:race:${index}`, targetSteps: 100000, status: "ACTIVE", startedAt: new Date(Date.now() - 3600000), endsAt: new Date(Date.now() + 86400000), maxDurationDays: 7, powerupsEnabled: true, powerupStepInterval: 5000, isPublic: false, maxParticipants: Math.max(2, users) } });
    ids.races.push(race.id);
    createdRaces.push(race);
    for (const user of createdUsers) {
      const participant = await prisma.raceParticipant.create({ data: { raceId: race.id, userId: user.id, status: "ACCEPTED", totalSteps: 1000, nextBoxAtSteps: 5000, joinedAt: race.startedAt } });
      ids.raceParticipants.push(participant.id);
    }
  }
    const manifest = { schema: "synthetic-load-manifest-v1", runId, baseline: before, ids };
    return { baseline: before, manifest, users: createdUsers, races: createdRaces };
  } catch (error) {
    await cleanupSyntheticRun({ prisma, manifest: { schema: "synthetic-load-manifest-v1", runId, baseline: before, ids } }).catch(() => {});
    throw error;
  }
}

async function cleanupSyntheticRun({ prisma, manifest }) {
  if (!manifest || manifest.schema !== "synthetic-load-manifest-v1") throw new Error("synthetic cleanup requires a valid run manifest");
  assertRunId(manifest.runId);
  const ids = manifest.ids || {};
  const inList = (value) => Array.isArray(value) && value.length ? { in: value } : undefined;
  const safeIds = (value) => (Array.isArray(value) ? value : []).filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  const userIds = safeIds(ids.users);
  const raceIds = safeIds(ids.races);
  const globalEventIds = safeIds(ids.globalEvents);
  const sqlArray = (value) => `ARRAY[${value.map((id) => `'${id}'`).join(",")}]::text[]`;
  await prisma.$transaction(async (tx) => {
    if (userIds.length) {
      await tx.$executeRawUnsafe(
        `DELETE FROM domain_event_outbox WHERE payload->>'userId' = ANY($1::text[])`,
        userIds,
      );
    }
    if (globalEventIds.length) {
      await tx.$executeRawUnsafe(
        `DELETE FROM domain_event_outbox WHERE payload->>'eventId' = ANY($1::text[])`,
        globalEventIds,
      );
    }
    const userWhere = inList(ids.users);
    if (userWhere) {
      if (tx.stepSyncRequest) await tx.stepSyncRequest.deleteMany({ where: { userId: userWhere } });
      if (tx.raceResolutionJob) await tx.raceResolutionJob.deleteMany({ where: { userId: userWhere } });
      if (tx.userScoringInputVersion) await tx.userScoringInputVersion.deleteMany({ where: { userId: userWhere } });
    }
    // Sync and race-resolution now have several additive side-effect tables.
    // Discover every table keyed by a synthetic user/race and remove those
    // rows before deleting the parent rows. Retry FK-blocked tables so this
    // remains correct as new child tables are added in future migrations.
    const keyedTables = await tx.$queryRawUnsafe(`
      SELECT table_name,
             bool_or(column_name = 'user_id') AS has_user_id,
             bool_or(column_name = 'race_id') AS has_race_id
      FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name IN ('user_id', 'race_id')
      GROUP BY table_name
      ORDER BY table_name
    `);
    const excluded = new Set(['users', 'races', 'race_participants', 'steps', 'step_samples']);
    const pending = keyedTables.filter((row) => !excluded.has(row.table_name));
    for (let pass = 0; pass <= pending.length; pass += 1) {
      let progress = false;
      for (const row of pending) {
        const predicates = [];
        if (row.has_user_id && userIds.length) predicates.push(`user_id::text = ANY(${sqlArray(userIds)})`);
        if (row.has_race_id && raceIds.length) predicates.push(`race_id::text = ANY(${sqlArray(raceIds)})`);
        if (!predicates.length) continue;
        const table = `"${String(row.table_name).replaceAll('"', '""')}"`;
        try {
          const count = await tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE ${predicates.join(" OR ")}`);
          progress = progress || count > 0;
        } catch (error) {
          if (error?.code !== "P2003" && error?.code !== "23503") throw error;
        }
      }
      if (!progress) break;
    }
    if (inList(ids.stepSamples)) await tx.stepSample.deleteMany({ where: { id: inList(ids.stepSamples) } });
    if (inList(ids.steps)) await tx.step.deleteMany({ where: { id: inList(ids.steps) } });
    if (userWhere) {
      await tx.stepSample.deleteMany({ where: { userId: userWhere } });
      await tx.step.deleteMany({ where: { userId: userWhere } });
    }
    if (inList(ids.raceParticipants)) await tx.raceParticipant.deleteMany({ where: { id: inList(ids.raceParticipants) } });
    if (inList(ids.races)) await tx.race.deleteMany({ where: { id: inList(ids.races) } });
    if (globalEventIds.length) {
      await tx.globalStepEvent.deleteMany({ where: { id: { in: globalEventIds } } });
    }
    if (inList(ids.users)) await tx.user.deleteMany({ where: { id: inList(ids.users) } });
  }, { maxWait: 5_000, timeout: 60_000 });
  const after = await baselineIntegrity(prisma);
  await assertNoSyntheticRows(prisma, ids);
  if (JSON.stringify(after) !== JSON.stringify(manifest.baseline)) throw new Error("baseline integrity changed during synthetic cleanup");
  return { cleaned: true, baselineUnchanged: true };
}

module.exports = { assertFixtureDatabase, assertNoSyntheticRows, baselineIntegrity, cleanupSyntheticRun, createSyntheticFixtures };
