#!/usr/bin/env node

// One private backend helper for the guided k6 operator. It is deliberately
// machine-readable, idempotent, and guarded by a run-bound database identity.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  loadCapacityEffectiveEnvironment,
} = require("./capacity-effective-env");

try {
  loadCapacityEffectiveEnvironment();
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    command: process.argv[2] || null,
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exit(2);
}

const { Pool } = require("pg");
const jwt = require("jsonwebtoken");
const {
  attestWorkers,
} = require("./capacity-attestation");
const {
  LOOPBACK_HOSTS,
  assertCapacityDatabaseMarker,
  capacityAuthSecret,
  capacityDatabaseSslDisabled,
  capacityIdentity,
  isPrivateCapacityHost,
  normalizeHostname,
  parsePostgresTarget,
  validateCapacityEnvironment,
} = require("../../src/localCapacitySafety");

const IDENTITY_SCHEMA = "capacity-identities-v1";
const SYNTHETIC_PREFIX = "capacity:";
const STATUS_IDENTITY_PREFIX = "capacity-status:";
const SYNTHETIC_SOURCE_PREFIX = "CAPACITY_OPERATOR:";
const STATUS_CONTEXT_COUNT = 16;
const SANITIZED_TABLES = Object.freeze([
  "device_tokens",
  "push_deliveries",
  "notifications",
  "inbox_delivery_outbox",
  "race_resolution_delivery_intents",
  "race_resolution_post_tasks",
  "race_resolution_jobs",
  "race_resolution_jobs_v2",
  "step_sync_requests",
]);
const QUEUE_BASELINE_TABLES = Object.freeze([
  "race_resolution_delivery_intents",
  "race_resolution_post_tasks",
  "race_resolution_jobs",
  "race_resolution_jobs_v2",
  "step_sync_requests",
]);
const COMMANDS = new Set([
  "inspect",
  "attest-workers",
  "sanitize",
  "verify-sanitized",
  "inflate",
  "verify-inflation",
  "canary",
  "barrier",
  "observe",
  "report",
]);

function parseArgs(argv) {
  const command = argv[0];
  if (!COMMANDS.has(command)) {
    throw new Error(`command must be one of: ${[...COMMANDS].join(", ")}`);
  }
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) throw new Error(`unexpected argument: ${item}`);
    const key = item.slice(2);
    if (key === "json") {
      options.json = true;
      continue;
    }
    const value = argv[index + 1];
    if (value == null || value.startsWith("--")) {
      throw new Error(`--${key} requires a value`);
    }
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

function integerOption(options, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = options[name];
  const value = raw == null ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`--${name} must be an integer from ${min} through ${max}`);
  }
  return value;
}

function assertRunOption(options) {
  const identity = capacityIdentity();
  if (options["run-id"] && options["run-id"] !== identity.runId) {
    throw new Error("--run-id does not match CAPACITY_RUN_ID");
  }
  return identity;
}

function databasePool() {
  const target = parsePostgresTarget(process.env.DATABASE_URL);
  const connectionString = process.env.DATABASE_URL.replace(
    /[?&]sslmode=[^&]*/g,
    "",
  );
  return new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 5000,
    ...(LOOPBACK_HOSTS.has(target.host) || capacityDatabaseSslDisabled()
      ? {}
      : { ssl: { rejectUnauthorized: false } }),
  });
}

function pgbouncerAdminPool() {
  const adminUrl = String(process.env.CAPACITY_PGBOUNCER_ADMIN_URL || "").trim();
  if (!adminUrl) return null;
  // Full environment validation proves this URL is the run-bound database host
  // and the special PgBouncer admin database before a connection is opened.
  validateCapacityEnvironment();
  const target = parsePostgresTarget(adminUrl);
  const connectionString = adminUrl.replace(/[?&]sslmode=[^&]*/g, "");
  return new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 5000,
    ...(LOOPBACK_HOSTS.has(target.host) || capacityDatabaseSslDisabled()
      ? {}
      : { ssl: { rejectUnauthorized: false } }),
  });
}

function emit(command, value = {}) {
  process.stdout.write(`${JSON.stringify({ ok: true, command, ...value })}\n`);
}

function capacityRuntimeError(message, details = {}) {
  const error = new Error(message);
  error.details = details;
  return error;
}

function deterministicUuid(label) {
  const bytes = crypto.createHash("sha256").update(label).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function syntheticSource(runId) {
  return `${SYNTHETIC_SOURCE_PREFIX}${runId}`;
}

function seedNumber(value) {
  if (/^-?\d+$/.test(String(value))) return Number(value) >>> 0;
  return crypto.createHash("sha256").update(String(value)).digest().readUInt32LE(0);
}

function deterministicRandom(seed) {
  let state = seedNumber(seed);
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(values, random) {
  const output = values.slice();
  for (let index = output.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [output[index], output[other]] = [output[other], output[index]];
  }
  return output;
}

async function assertDatabaseServer(client) {
  const validated = validateCapacityEnvironment();
  const identity = capacityIdentity();
  const result = await client.query(`
    SELECT current_database() AS database,
           pg_is_in_recovery() AS "inRecovery",
           inet_server_addr()::text AS "serverAddress"
  `);
  const row = result.rows[0];
  if (row.database.toLowerCase() !== validated.database.name) {
    throw new Error("connected database identity differs from CAPACITY_DB_NAME");
  }
  if (row.inRecovery) throw new Error("capacity destination is read-only/in recovery");
  return { ...validated, ...identity, serverAddress: row.serverAddress };
}

async function requireTables(client, names) {
  const result = await client.query(
    `SELECT name, to_regclass('public.' || name) IS NOT NULL AS present
     FROM unnest($1::text[]) AS name`,
    [names],
  );
  const missing = result.rows.filter((row) => !row.present).map((row) => row.name);
  if (missing.length) throw new Error(`required tables are missing: ${missing.join(", ")}`);
}

async function markerRow(client) {
  const result = await client.query(`
    SELECT run_id AS "runId", marker_hash AS "markerHash",
           sanitized_at AS "sanitizedAt", inflated_at AS "inflatedAt",
           inflated_users AS "inflatedUsers", inflated_races AS "inflatedRaces",
           inflated_memberships AS "inflatedMemberships", seed
    FROM capacity_operator_runs WHERE singleton = true
  `);
  return result.rows[0] || null;
}

async function assertMarker(client, { requireInflated = false } = {}) {
  const identity = capacityIdentity();
  let row;
  try {
    row = await markerRow(client);
  } catch (error) {
    if (error?.code === "42P01") throw new Error("capacity database marker is absent");
    throw error;
  }
  if (
    !row ||
    row.runId !== identity.runId ||
    row.markerHash !== identity.markerHash ||
    !row.sanitizedAt
  ) {
    throw new Error("capacity database marker does not match this sanitized run");
  }
  if (requireInflated && !row.inflatedAt) throw new Error("capacity inflation is incomplete");
  return row;
}

async function tableCounts(client, tables = SANITIZED_TABLES) {
  const counts = {};
  for (const table of tables) {
    const result = await client.query(`SELECT count(*)::integer AS count FROM ${table}`);
    counts[table] = result.rows[0].count;
  }
  return counts;
}

async function inspect() {
  const validated = validateCapacityEnvironment();
  const pool = databasePool();
  try {
    const client = await pool.connect();
    try {
      const server = await assertDatabaseServer(client);
      const settings = await client.query(`
        SELECT current_setting('server_version') AS "serverVersion",
               current_setting('max_connections')::integer AS "maxConnections",
               current_setting('shared_buffers') AS "sharedBuffers"
      `);
      let marker = null;
      try {
        marker = await markerRow(client);
      } catch (error) {
        if (error?.code !== "42P01") throw error;
      }
      return {
        runId: validated.runId,
        database: {
          ...validated.database,
          serverAddress: server.serverAddress,
          ...settings.rows[0],
          applicationPoolPerWorker: 20,
          sslMode:
            process.env.CAPACITY_DATABASE_SSL_DISABLED === "true"
              ? "disabled-capacity-only"
              : "required-non-loopback",
        },
        redis: validated.redis,
        pooler: validated.pooler,
        outboundDisabled: validated.outbound.outboundDisabled,
        marker: marker
          ? {
              runId: marker.runId,
              sanitized: Boolean(marker.sanitizedAt),
              inflated: Boolean(marker.inflatedAt),
              inflatedUsers: marker.inflatedUsers,
            }
          : null,
        queueFlags: {
          debounceMs: Number(process.env.RACE_RESOLVE_DEBOUNCE_MS || 0),
          quietPeriodMs: Number(process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS || 0),
          workerConcurrency: Number(process.env.ASYNC_RACE_RESOLUTION_CONCURRENCY || 1),
          asyncDisabled: process.env.ASYNC_RACE_RESOLUTION_DISABLED === "true",
          workerDisabled: process.env.ASYNC_RACE_RESOLUTION_WORKER_DISABLED === "true",
          postTaskWorkerDisabled:
            process.env.RACE_RESOLUTION_POST_TASK_WORKER_DISABLED === "true",
        },
      };
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

async function attestCapacityWorkers(options) {
  assertRunOption(options);
  const expectedWorkers = integerOption(options, "expected-workers", 2, {
    min: 1,
    max: 16,
  });
  return attestWorkers({ expectedWorkers });
}

async function sanitize() {
  const identity = assertRunOption(arguments[0] || {});
  const pool = databasePool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '10min'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `capacity-operator:${identity.runId}`,
    ]);
    await assertDatabaseServer(client);
    await requireTables(client, SANITIZED_TABLES);
    await client.query(`
      CREATE TABLE IF NOT EXISTS capacity_operator_runs (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        run_id text NOT NULL UNIQUE,
        marker_hash char(64) NOT NULL,
        sanitized_at timestamptz,
        inflated_at timestamptz,
        inflated_users integer,
        inflated_races integer,
        inflated_memberships integer,
        seed text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query("LOCK TABLE capacity_operator_runs IN ACCESS EXCLUSIVE MODE");
    const existing = await markerRow(client);
    if (
      existing &&
      (existing.runId !== identity.runId || existing.markerHash !== identity.markerHash)
    ) {
      throw new Error("database is already bound to a different capacity run");
    }
    await client.query(
      `INSERT INTO capacity_operator_runs (singleton, run_id, marker_hash)
       VALUES (true, $1, $2)
       ON CONFLICT (singleton) DO NOTHING`,
      [identity.runId, identity.markerHash],
    );
    await client.query(`TRUNCATE TABLE ${SANITIZED_TABLES.join(", ")}`);
    const counts = await tableCounts(client);
    const nonzero = Object.entries(counts).filter(([, count]) => count !== 0);
    if (nonzero.length) throw new Error("sanitization left delivery or queue rows behind");
    await client.query(
      `UPDATE capacity_operator_runs
       SET sanitized_at=now(), inflated_at=NULL, inflated_users=NULL,
           inflated_races=NULL, inflated_memberships=NULL, seed=NULL, updated_at=now()
       WHERE singleton=true AND run_id=$1 AND marker_hash=$2`,
      [identity.runId, identity.markerHash],
    );
    await client.query("COMMIT");
    return { runId: identity.runId, sanitized: true, counts };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function verifySanitized(options) {
  assertRunOption(options);
  const scope = options.scope || "baseline";
  if (!["permanent", "baseline"].includes(scope)) {
    throw new Error("--scope must be permanent or baseline");
  }
  const pool = databasePool();
  try {
    await assertCapacityDatabaseMarker({ pool });
    const counts = await tableCounts(pool);
    const accepted = await pool.query(`
      SELECT
        (SELECT count(*)::integer FROM device_tokens) AS "sendableDeviceTokens",
        (SELECT count(*)::integer FROM push_deliveries) AS "pushDeliveryRows"
    `);
    const invariants = accepted.rows[0];
    if (invariants.sendableDeviceTokens !== 0 || invariants.pushDeliveryRows !== 0) {
      throw new Error(`permanent outbound safety assertion failed: ${JSON.stringify(invariants)}`);
    }
    let queueBaseline = null;
    if (scope === "baseline") {
      queueBaseline = await tableCounts(pool, QUEUE_BASELINE_TABLES);
      const nonzero = Object.entries(queueBaseline).filter(([, count]) => count !== 0);
      if (nonzero.length) {
        throw new Error(`initial queue baseline is not empty: ${nonzero.map(([name, count]) => `${name}=${count}`).join(", ")}`);
      }
    }
    return {
      sanitized: true,
      scope,
      permanentOutboundInvariant: true,
      ...invariants,
      ...(queueBaseline ? { initialQueueBaseline: true, queueBaseline } : {}),
      counts,
    };
  } finally {
    await pool.end();
  }
}

async function productionRaceTemplates(client) {
  const result = await client.query(`
    SELECT r.time_based AS "timeBased", r.is_team_race AS "isTeamRace",
           r.powerups_enabled AS "powerupsEnabled",
           r.powerup_step_interval AS "powerupStepInterval",
           greatest(2, count(p.id)::integer) AS "rosterSize",
           greatest(1, least(30, coalesce(r.max_duration_days, 7))) AS "durationDays",
           greatest(1000, r.target_steps) AS "targetSteps"
    FROM races r
    JOIN race_participants p ON p.race_id=r.id AND p.status='accepted'
    WHERE r.status='active'
      AND (r.creation_source IS NULL OR r.creation_source NOT LIKE $1)
    GROUP BY r.id
    ORDER BY r.id
  `, [`${SYNTHETIC_SOURCE_PREFIX}%`]);
  if (result.rows.length > 0) return result.rows;
  return [{
    timeBased: true,
    isTeamRace: false,
    powerupsEnabled: false,
    powerupStepInterval: null,
    rosterSize: 10,
    durationDays: 7,
    targetSteps: 50000,
  }];
}

function buildSyntheticTopology({ runId, userCount, seed, templates }) {
  const random = deterministicRandom(seed);
  const users = Array.from({ length: userCount }, (_, index) => ({
    index,
    id: deterministicUuid(`${runId}:user:${index}`),
    googleSub: `${SYNTHETIC_PREFIX}${runId}:${String(index).padStart(6, "0")}`,
    displayName: `cap_${crypto.createHash("sha256").update(`${runId}:${index}`).digest("hex").slice(0, 18)}`,
    targetMemberships: 1 + Math.floor(random() * 5),
    activeRaceIds: [],
  }));
  const races = [];
  const memberships = [];
  for (let round = 0; round < 5; round += 1) {
    const eligible = shuffled(users.filter((user) => user.targetMemberships > round), random);
    let cursor = 0;
    while (cursor < eligible.length) {
      const template = templates[Math.floor(random() * templates.length)];
      const desired = Math.max(2, Math.min(250, Number(template.rosterSize) || 10));
      const remaining = eligible.length - cursor;
      if (remaining === 1 && races.length > 0) {
        const user = eligible[cursor];
        const race = races[races.length - 1];
        race.members.push(user);
        user.activeRaceIds.push(race.id);
        cursor += 1;
        continue;
      }
      const take = Math.min(desired, remaining);
      const members = eligible.slice(cursor, cursor + take);
      cursor += take;
      const ordinal = races.length;
      const id = deterministicUuid(`${runId}:race:${ordinal}`);
      const isTeamRace = Boolean(template.isTeamRace) && members.length >= 2;
      const race = { id, ordinal, template, members, isTeamRace };
      races.push(race);
      for (const [memberIndex, user] of members.entries()) {
        user.activeRaceIds.push(id);
        memberships.push({
          id: deterministicUuid(`${runId}:participant:${ordinal}:${user.index}`),
          raceId: id,
          userId: user.id,
          team: isTeamRace ? (memberIndex % 2 === 0 ? "team_a" : "team_b") : null,
        });
      }
    }
  }
  return { users, races, memberships };
}

async function insertJsonBatches(client, values, size, sql, extraParameters = []) {
  for (let offset = 0; offset < values.length; offset += size) {
    await client.query(sql, [
      JSON.stringify(values.slice(offset, offset + size)),
      ...extraParameters,
    ]);
  }
}

async function insertTopology(client, topology, runId) {
  await insertJsonBatches(client, topology.users, 1000, `
    INSERT INTO users (id, google_sub, display_name, name, created_at)
    SELECT row.id, row."googleSub", row."displayName", 'Capacity User', now()
    FROM jsonb_to_recordset($1::jsonb) AS row(
      id text, "googleSub" text, "displayName" text
    )
    ON CONFLICT (id) DO UPDATE SET
      google_sub=EXCLUDED.google_sub, display_name=EXCLUDED.display_name
  `);
  const raceRows = topology.races.map((race) => ({
    id: race.id,
    creatorId: race.members[0].id,
    name: `Capacity ${runId} ${race.ordinal}`.slice(0, 255),
    targetSteps: race.template.timeBased
      ? Math.max(1000, Number(race.template.targetSteps) || 50000)
      : 2_000_000_000,
    durationDays: Math.max(1, Number(race.template.durationDays) || 7),
    powerupsEnabled: Boolean(race.template.powerupsEnabled),
    powerupStepInterval: race.template.powerupsEnabled
      ? Math.max(100, Number(race.template.powerupStepInterval) || 2500)
      : null,
    maxParticipants: race.isTeamRace
      ? Math.max(2, 2 * Math.ceil(race.members.length / 2))
      : Math.max(2, race.members.length),
    timeBased: Boolean(race.template.timeBased),
    isTeamRace: race.isTeamRace,
    teamSize: race.isTeamRace ? Math.ceil(race.members.length / 2) : null,
  }));
  await insertJsonBatches(client, raceRows, 500, `
    INSERT INTO races (
      id, creator_id, name, target_steps, status, max_duration_days,
      started_at, ends_at, powerups_enabled, powerup_step_interval,
      is_public, max_participants, time_based, is_team_race, team_size,
      team_a_name, team_b_name, creation_source, created_at, updated_at
    )
    SELECT row.id, row."creatorId", row.name, row."targetSteps", 'active',
           row."durationDays", now() - interval '1 hour', now() + interval '24 hours',
           row."powerupsEnabled", row."powerupStepInterval", false,
           row."maxParticipants", row."timeBased", row."isTeamRace", row."teamSize",
           CASE WHEN row."isTeamRace" THEN 'Capacity A' ELSE NULL END,
           CASE WHEN row."isTeamRace" THEN 'Capacity B' ELSE NULL END,
           $2, now(), now()
    FROM jsonb_to_recordset($1::jsonb) AS row(
      id text, "creatorId" text, name text, "targetSteps" integer,
      "durationDays" integer, "powerupsEnabled" boolean,
      "powerupStepInterval" integer, "maxParticipants" integer,
      "timeBased" boolean, "isTeamRace" boolean, "teamSize" integer
    )
    ON CONFLICT (id) DO UPDATE SET
      status='active', ends_at=EXCLUDED.ends_at, updated_at=now()
  `, [syntheticSource(runId)]);
  await insertJsonBatches(client, topology.memberships, 1500, `
    INSERT INTO race_participants (
      id, race_id, user_id, status, total_steps, raw_steps,
      baseline_steps, joined_at, team
    )
    SELECT row.id, row."raceId", row."userId", 'accepted', 0, 0, 0, now(),
           CASE WHEN row.team IS NULL THEN NULL ELSE row.team::"RaceTeam" END
    FROM jsonb_to_recordset($1::jsonb) AS row(
      id text, "raceId" text, "userId" text, team text
    )
    ON CONFLICT (race_id, user_id) DO NOTHING
  `);
}

async function insertStatusPollCorpus(client, runId) {
  const users = Array.from({ length: STATUS_CONTEXT_COUNT }, (_, index) => ({
    id: deterministicUuid(`${runId}:status-user:${index}`),
    googleSub: `${STATUS_IDENTITY_PREFIX}${runId}:${String(index).padStart(3, "0")}`,
    displayName: `cap_status_${crypto.createHash("sha256").update(`${runId}:${index}`).digest("hex").slice(0, 14)}`,
    jobId: deterministicUuid(`${runId}:status-job:${index}`),
  }));
  await insertJsonBatches(client, users, STATUS_CONTEXT_COUNT, `
    INSERT INTO users (id, google_sub, display_name, name, created_at)
    SELECT row.id, row."googleSub", row."displayName", 'Capacity Status User', now()
    FROM jsonb_to_recordset($1::jsonb) AS row(
      id text, "googleSub" text, "displayName" text
    )
    ON CONFLICT (id) DO UPDATE SET
      google_sub=EXCLUDED.google_sub, display_name=EXCLUDED.display_name
  `);
  await insertJsonBatches(client, users, STATUS_CONTEXT_COUNT, `
    INSERT INTO race_resolution_jobs (
      id, user_id, generation, resolution_time_zone, state, attempts,
      requested_at, completed_at, created_at, updated_at
    )
    SELECT row."jobId", row.id, 1, 'UTC', 'succeeded', 0,
           now(), now(), now(), now()
    FROM jsonb_to_recordset($1::jsonb) AS row(id text, "jobId" text)
    ON CONFLICT (user_id) DO NOTHING
  `);
}

async function inflationStats(client, runId) {
  const prefix = `${SYNTHETIC_PREFIX}${runId}:%`;
  const source = syntheticSource(runId);
  const result = await client.query(`
    WITH synthetic_users AS (
      SELECT id FROM users WHERE google_sub LIKE $1
    ), membership_counts AS (
      SELECT u.id, count(p.id)::integer AS count
      FROM synthetic_users u
      LEFT JOIN race_participants p ON p.user_id=u.id AND p.status='accepted'
      GROUP BY u.id
    )
    SELECT
      (SELECT count(*)::integer FROM synthetic_users) AS users,
      (SELECT count(*)::integer FROM races WHERE creation_source=$2) AS races,
      (SELECT count(*)::integer FROM race_participants p
       JOIN synthetic_users u ON u.id=p.user_id WHERE p.status='accepted') AS memberships,
      coalesce((SELECT min(count) FROM membership_counts),0)::integer AS "minMemberships",
      coalesce((SELECT max(count) FROM membership_counts),0)::integer AS "maxMemberships",
      (SELECT count(*)::integer FROM races
       WHERE creation_source=$2 AND (status <> 'active' OR ends_at <= now() + interval '8 hours'))
       AS "invalidRaces",
      (SELECT count(*)::integer FROM users u
       JOIN race_resolution_jobs j ON j.user_id=u.id
       WHERE u.google_sub LIKE $3 AND j.state='succeeded') AS "statusContexts",
      (SELECT count(*)::integer FROM race_resolution_jobs_v2 j
       JOIN races r ON r.id=j.race_id
       WHERE r.creation_source=$2) AS "workloadV2Jobs"
  `, [prefix, source, `${STATUS_IDENTITY_PREFIX}${runId}:%`]);
  return result.rows[0];
}

async function identitiesFromDatabase(client, runId) {
  const result = await client.query(`
    SELECT u.id AS "userId",
           array_agg(p.race_id ORDER BY p.race_id) AS "activeRaceIds"
    FROM users u
    JOIN race_participants p ON p.user_id=u.id AND p.status='accepted'
    JOIN races r ON r.id=p.race_id AND r.status='active' AND r.creation_source=$2
    WHERE u.google_sub LIKE $1
    GROUP BY u.id
    ORDER BY u.id
  `, [`${SYNTHETIC_PREFIX}${runId}:%`, syntheticSource(runId)]);
  return result.rows;
}

async function statusContextsFromDatabase(client, runId) {
  const result = await client.query(`
    SELECT u.id AS "userId", j.id AS "resolutionJobId",
           j.generation AS "resolutionGeneration"
    FROM users u
    JOIN race_resolution_jobs j ON j.user_id=u.id
    WHERE u.google_sub LIKE $1 AND j.state='succeeded'
    ORDER BY u.id
  `, [`${STATUS_IDENTITY_PREFIX}${runId}:%`]);
  return result.rows;
}

function signCapacityIdentity(userId, secret, ttlSeconds) {
  return jwt.sign({ appleId: null }, secret, {
    subject: userId,
    issuer: "steps-tracker-api",
    expiresIn: ttlSeconds,
    algorithm: "HS256",
  });
}

function writeIdentityFile(
  outputPath,
  { runId, seed, identities, statusContexts, raceCount },
) {
  const secret = capacityAuthSecret();
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 12 * 60 * 60;
  const ttlSeconds = expiresAt - issuedAt;
  const lines = [JSON.stringify({
    type: "meta",
    schemaVersion: IDENTITY_SCHEMA,
    runId,
    seed: String(seed),
    userCount: identities.length,
    raceCount,
    statusContextCount: statusContexts.length,
    expiresAt,
  })];
  for (const identity of identities) {
    const token = signCapacityIdentity(identity.userId, secret, ttlSeconds);
    lines.push(JSON.stringify({ type: "identity", ...identity, token }));
  }
  for (const statusContext of statusContexts) {
    const token = signCapacityIdentity(statusContext.userId, secret, ttlSeconds);
    lines.push(JSON.stringify({ type: "statusContext", ...statusContext, token }));
  }
  const absolute = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
  const temporary = `${absolute}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${lines.join("\n")}\n`, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, absolute);
  fs.chmodSync(absolute, 0o600);
  return { output: absolute, expiresAt };
}

async function inflate(options) {
  const identity = assertRunOption(options);
  const userCount = integerOption(options, "users", 10000, { min: 1, max: 100000 });
  const seed = options.seed == null ? identity.runId : options.seed;
  const outputPath = options.output;
  if (!outputPath) throw new Error("--output is required");
  capacityAuthSecret();
  const pool = databasePool();
  const client = await pool.connect();
  try {
    await assertCapacityDatabaseMarker({ pool: client });
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '30min'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `capacity-inflate:${identity.runId}`,
    ]);
    const marker = await assertMarker(client);
    if (
      marker.inflatedAt &&
      (marker.inflatedUsers !== userCount || String(marker.seed) !== String(seed))
    ) {
      throw new Error("this run was already inflated with different users or seed");
    }
    if (!marker.inflatedAt) {
      const templates = await productionRaceTemplates(client);
      const topology = buildSyntheticTopology({
        runId: identity.runId,
        userCount,
        seed,
        templates,
      });
      await insertTopology(client, topology, identity.runId);
    }
    await insertStatusPollCorpus(client, identity.runId);
    const preparedStats = await inflationStats(client, identity.runId);
    if (
      preparedStats.users !== userCount ||
      preparedStats.minMemberships < 1 ||
      preparedStats.maxMemberships > 5 ||
      preparedStats.invalidRaces !== 0 ||
      preparedStats.statusContexts !== STATUS_CONTEXT_COUNT ||
      (!marker.inflatedAt && preparedStats.workloadV2Jobs !== 0)
    ) {
      throw new Error(`inflation verification failed: ${JSON.stringify(preparedStats)}`);
    }
    if (!marker.inflatedAt) {
      await client.query(
        `UPDATE capacity_operator_runs
         SET inflated_at=now(), inflated_users=$1, inflated_races=$2,
             inflated_memberships=$3, seed=$4, updated_at=now()
         WHERE singleton=true AND run_id=$5 AND marker_hash=$6`,
        [
          preparedStats.users,
          preparedStats.races,
          preparedStats.memberships,
          String(seed),
          identity.runId,
          identity.markerHash,
        ],
      );
    }
    await client.query("COMMIT");
    const stats = await inflationStats(client, identity.runId);
    const identities = await identitiesFromDatabase(client, identity.runId);
    const statusContexts = await statusContextsFromDatabase(client, identity.runId);
    if (identities.length !== userCount) {
      throw new Error("identity export count differs from inflated user count");
    }
    if (statusContexts.length !== STATUS_CONTEXT_COUNT) {
      throw new Error("status context export count differs from bounded corpus");
    }
    const file = writeIdentityFile(outputPath, {
      runId: identity.runId,
      seed,
      identities,
      statusContexts,
      raceCount: stats.races,
    });
    return { runId: identity.runId, seed: String(seed), ...stats, ...file };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function verifyInflation(options) {
  const identity = assertRunOption(options);
  const expected = integerOption(options, "users", 10000, { min: 1, max: 100000 });
  const pool = databasePool();
  try {
    const marker = await assertMarker(pool, { requireInflated: true });
    const stats = await inflationStats(pool, identity.runId);
    if (
      marker.inflatedUsers !== expected ||
      stats.users !== expected ||
      stats.minMemberships < 1 ||
      stats.maxMemberships > 5 ||
      stats.invalidRaces !== 0 ||
      stats.statusContexts !== STATUS_CONTEXT_COUNT ||
      stats.workloadV2Jobs !== 0
    ) {
      throw new Error(`inflation assertion failed: ${JSON.stringify(stats)}`);
    }
    return { verified: true, expectedUsers: expected, ...stats };
  } finally {
    await pool.end();
  }
}

function parseIdentityFile(filePath) {
  const lines = fs.readFileSync(path.resolve(filePath), "utf8").trim().split("\n");
  const meta = JSON.parse(lines[0]);
  const identity = JSON.parse(lines[1]);
  if (
    meta.type !== "meta" ||
    meta.schemaVersion !== IDENTITY_SCHEMA ||
    meta.runId !== process.env.CAPACITY_RUN_ID ||
    identity.type !== "identity" ||
    !identity.token
  ) {
    throw new Error("identity file does not match this capacity run");
  }
  jwt.verify(identity.token, capacityAuthSecret(), {
    issuer: "steps-tracker-api",
    algorithms: ["HS256"],
  });
  return { meta, identity };
}

function assertCapacityBaseUrl(input) {
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("--base-url must be a valid URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("--base-url must use http or https");
  }
  const host = normalizeHostname(parsed.hostname);
  if (host === "steptracker-api.org" || host.endsWith(".steptracker-api.org")) {
    throw new Error("production workload targets are categorically forbidden");
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    const allowed = normalizeHostname(process.env.CAPACITY_APP_HOST_ALLOWLIST);
    if (
      !allowed ||
      allowed.includes(",") ||
      !isPrivateCapacityHost(allowed) ||
      host !== allowed
    ) {
      throw new Error("base URL host does not match CAPACITY_APP_HOST_ALLOWLIST");
    }
  }
  return parsed.origin;
}

function requiredClientProfile(options) {
  const profile = {
    appVersion: options["app-version"],
    platform: options.platform,
    clientFeatures: options["client-features"],
    userAgent: options["user-agent"],
    timezone: options.timezone,
    releaseChannel: options["release-channel"],
  };
  for (const [name, value] of Object.entries(profile)) {
    if (typeof value !== "string" || value.length === 0 || /[\r\n\0]/.test(value)) {
      throw new Error(`canary client profile ${name} is required and must be a single line`);
    }
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(profile.appVersion)) {
    throw new Error("--app-version must be a semantic application version");
  }
  if (!["ios", "android"].includes(profile.platform.toLowerCase())) {
    throw new Error("--platform must be ios or android");
  }
  if (
    profile.clientFeatures.length > 512 ||
    profile.clientFeatures.split(",").some((token) => !/^[a-z0-9_-]+$/.test(token.trim()))
  ) {
    throw new Error("--client-features must be a comma-separated lowercase token list");
  }
  if (profile.userAgent.length > 256) {
    throw new Error("--user-agent must not exceed 256 characters");
  }
  try {
    Intl.DateTimeFormat("en-US", { timeZone: profile.timezone });
  } catch {
    throw new Error("--timezone must be a valid IANA timezone");
  }
  if (!["prod", "testflight"].includes(profile.releaseChannel.toLowerCase())) {
    throw new Error("--release-channel must be prod or testflight");
  }
  return profile;
}

async function canary(options) {
  assertRunOption(options);
  const clientProfile = requiredClientProfile(options);
  const baseUrl = assertCapacityBaseUrl(options["base-url"]);
  if (!options["identity-file"]) throw new Error("--identity-file is required");
  const { identity } = parseIdentityFile(options["identity-file"]);
  const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
  if (!health.ok) throw new Error(`capacity health canary returned ${health.status}`);
  const now = new Date();
  const end = new Date(Math.floor(now.getTime() / 3600000) * 3600000);
  const start = new Date(end.getTime() - 3600000);
  const response = await fetch(`${baseUrl}/steps/sync-v2`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${identity.token}`,
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
      "x-timezone": clientProfile.timezone,
      "x-app-version": clientProfile.appVersion,
      "x-platform": clientProfile.platform,
      "x-client-features": clientProfile.clientFeatures,
      "user-agent": clientProfile.userAgent,
      "x-release-channel": clientProfile.releaseChannel,
      "x-capacity-run-id": process.env.CAPACITY_RUN_ID,
    },
    body: JSON.stringify({
      date: now.toISOString().slice(0, 10),
      steps: 100,
      samples: [{
        periodStart: start.toISOString(),
        periodEnd: end.toISOString(),
        steps: 100,
        sourceName: "capacity-canary",
        sourceId: `${process.env.CAPACITY_RUN_ID}:canary`,
      }],
    }),
    signal: AbortSignal.timeout(30000),
  });
  const body = await response.text();
  if (response.status !== 202) {
    throw new Error(`step-sync canary returned ${response.status}: ${body.slice(0, 300)}`);
  }
  return {
    healthy: true,
    authenticatedUserId: identity.userId,
    stepSyncStatus: response.status,
    notificationSinkRequired: true,
    clientProfile,
  };
}

async function queueSnapshot(client) {
  const result = await client.query(`
    SELECT jsonb_build_object(
      'stepSync', jsonb_build_object(
        'total', (SELECT count(*) FROM step_sync_requests),
        'processing', (SELECT count(*) FROM step_sync_requests WHERE state='processing'),
        'complete', (SELECT count(*) FROM step_sync_requests WHERE state='complete')
      ),
      'v1', jsonb_build_object(
        'total', (SELECT count(*) FROM race_resolution_jobs),
        'queued', (SELECT count(*) FROM race_resolution_jobs WHERE state='queued'),
        'running', (SELECT count(*) FROM race_resolution_jobs WHERE state='running'),
        'succeeded', (SELECT count(*) FROM race_resolution_jobs WHERE state='succeeded'),
        'failed', (SELECT count(*) FROM race_resolution_jobs WHERE state='failed'),
        'generationTotal', (SELECT coalesce(sum(generation),0) FROM race_resolution_jobs),
        'retries', (SELECT coalesce(sum(greatest(attempts-1,0)),0) FROM race_resolution_jobs)
      ),
      'v2', jsonb_build_object(
        'total', (SELECT count(*) FROM race_resolution_jobs_v2),
        'queued', (SELECT count(*) FROM race_resolution_jobs_v2 WHERE state='queued'),
        'running', (SELECT count(*) FROM race_resolution_jobs_v2 WHERE state='running'),
        'succeeded', (SELECT count(*) FROM race_resolution_jobs_v2 WHERE state='succeeded'),
        'failed', (SELECT count(*) FROM race_resolution_jobs_v2 WHERE state='failed'),
        'generationTotal', (SELECT coalesce(sum(generation),0) FROM race_resolution_jobs_v2),
        'jobsTouched', (SELECT count(*) FROM race_resolution_jobs_v2 WHERE generation > 1),
        'retries', (SELECT coalesce(sum(greatest(attempts-1,0)),0) FROM race_resolution_jobs_v2),
        'oldestAgeSeconds', (SELECT coalesce(extract(epoch FROM now()-min(requested_at)),0)
          FROM race_resolution_jobs_v2 WHERE state IN ('queued','running'))
      ),
      'postTasks', jsonb_build_object(
        'queued', (SELECT count(*) FROM race_resolution_post_tasks WHERE state='queued'),
        'running', (SELECT count(*) FROM race_resolution_post_tasks WHERE state='running'),
        'failed', (SELECT count(*) FROM race_resolution_post_tasks WHERE state='succeeded_with_failures')
      ),
      'deliveryIntents', jsonb_build_object(
        'pending', (SELECT count(*) FROM race_resolution_delivery_intents WHERE state IN ('pending','attempting')),
        'failed', (SELECT count(*) FROM race_resolution_delivery_intents
          WHERE state IN ('rejected_no_retry','ambiguous_at_most_once'))
      )
    ) AS queue
  `);
  return result.rows[0].queue;
}

function pendingFromSnapshot(queue) {
  return Number(queue.stepSync.processing) +
    Number(queue.v1.queued) + Number(queue.v1.running) +
    Number(queue.v2.queued) + Number(queue.v2.running) +
    Number(queue.postTasks.queued) + Number(queue.postTasks.running) +
    Number(queue.deliveryIntents.pending);
}

function permanentFailuresFromSnapshot(queue) {
  const failures = {
    v1: Number(queue.v1.failed) || 0,
    v2: Number(queue.v2.failed) || 0,
    postTasks: Number(queue.postTasks.failed) || 0,
    deliveryIntents: Number(queue.deliveryIntents.failed) || 0,
  };
  return {
    ...failures,
    total: Object.values(failures).reduce((sum, count) => sum + count, 0),
  };
}

async function databaseSnapshot(client) {
  const result = await client.query(`
    SELECT jsonb_build_object(
      'connections', jsonb_build_object(
        'total', count(*),
        'active', count(*) FILTER (WHERE state='active'),
        'idle', count(*) FILTER (WHERE state='idle'),
        'waiting', count(*) FILTER (
          WHERE state='active' AND wait_event_type IS NOT NULL
        )
      ),
      'lockWaits', (SELECT count(*) FROM pg_locks WHERE NOT granted),
      'deadlocks', (SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()),
      'connectionLimit', current_setting('max_connections')::integer,
      'slowQueries', count(*) FILTER (
        WHERE state='active' AND query_start < now() - interval '2 seconds'
      )
    ) AS database
    FROM pg_stat_activity WHERE datname=current_database()
  `);
  return result.rows[0].database;
}

function sumRows(rows, key) {
  return rows.reduce((sum, row) => sum + (Number(row[key]) || 0), 0);
}

function maxRows(rows, key) {
  return rows.reduce((maximum, row) => Math.max(maximum, Number(row[key]) || 0), 0);
}

async function pgbouncerSnapshot() {
  const pool = pgbouncerAdminPool();
  if (!pool) return { enabled: false };
  try {
    const [poolsResult, statsResult, databasesResult, configResult] = await Promise.all([
      pool.query("SHOW POOLS"),
      pool.query("SHOW STATS"),
      pool.query("SHOW DATABASES"),
      pool.query("SHOW CONFIG"),
    ]);
    const databaseName = process.env.CAPACITY_DB_NAME;
    const selectDatabase = (rows) => {
      const selected = rows.filter((row) => row.database === databaseName);
      return selected.length > 0
        ? selected
        : rows.filter((row) => row.database !== "pgbouncer");
    };
    const pools = selectDatabase(poolsResult.rows);
    const stats = selectDatabase(statsResult.rows);
    const databases = selectDatabase(databasesResult.rows);
    const config = Object.fromEntries(
      configResult.rows.map((row) => [String(row.key), String(row.value)])
    );
    const clientsActive = sumRows(pools, "cl_active");
    const clientsWaiting = sumRows(pools, "cl_waiting");
    const serversActive = sumRows(pools, "sv_active");
    const serversIdle = sumRows(pools, "sv_idle");
    const serversUsed = sumRows(pools, "sv_used");
    const serversTested = sumRows(pools, "sv_tested");
    const serversLogin = sumRows(pools, "sv_login");
    const maxWaitSeconds = maxRows(pools, "maxwait");
    const configuredMaxConnections = sumRows(databases, "max_connections");
    const currentConnections = sumRows(databases, "current_connections");
    const defaultPoolSize = Number(config.default_pool_size) || null;
    const maxClientConnections = Number(config.max_client_conn) || null;
    const effectiveServerLimit = configuredMaxConnections > 0
      ? configuredMaxConnections
      : defaultPoolSize;
    const serverConnectionsInUse = serversActive + serversUsed + serversTested + serversLogin;
    const serverUtilizationRatio = effectiveServerLimit
      ? serverConnectionsInUse / effectiveServerLimit
      : null;
    const clientUtilizationRatio = maxClientConnections
      ? (clientsActive + clientsWaiting) / maxClientConnections
      : null;
    return {
      enabled: true,
      clients: {
        active: clientsActive,
        waiting: clientsWaiting,
        cancelRequests: sumRows(pools, "cl_cancel_req"),
      },
      servers: {
        active: serversActive,
        idle: serversIdle,
        used: serversUsed,
        tested: serversTested,
        login: serversLogin,
      },
      waits: {
        clientsWaiting,
        maxWaitSeconds,
        observed: clientsWaiting > 0 || maxWaitSeconds > 0,
      },
      saturation: {
        saturated: clientsWaiting > 0,
        nearSaturation:
          clientsWaiting > 0 ||
          (serverUtilizationRatio != null && serverUtilizationRatio >= 0.9) ||
          (clientUtilizationRatio != null && clientUtilizationRatio >= 0.9),
        serverUtilizationRatio,
        clientUtilizationRatio,
        effectiveServerLimit,
        maxClientConnections,
      },
      // Flat aliases are retained for report compatibility and simple jq use.
      maxWaitSeconds,
      transactions: sumRows(stats, "total_xact_count"),
      queries: sumRows(stats, "total_query_count"),
      bytesReceived: sumRows(stats, "total_received"),
      bytesSent: sumRows(stats, "total_sent"),
      configuredMaxConnections,
      currentConnections,
      poolModes: [...new Set(pools.map((row) => row.pool_mode).filter(Boolean))].sort(),
    };
  } finally {
    await pool.end();
  }
}

async function observe(options) {
  assertRunOption(options);
  const stageId = options["stage-id"] || null;
  if (stageId && !/^[a-zA-Z0-9._:-]{1,96}$/.test(stageId)) {
    throw new Error("--stage-id contains invalid characters");
  }
  const pool = databasePool();
  try {
    await assertMarker(pool);
    const [queue, database, pooler] = await Promise.all([
      queueSnapshot(pool),
      databaseSnapshot(pool),
      pgbouncerSnapshot(),
    ]);
    const pending = pendingFromSnapshot(queue);
    const permanentFailures = permanentFailuresFromSnapshot(queue);
    return {
      observedAt: new Date().toISOString(),
      stageId,
      queue,
      database,
      pooler,
      pending,
      queueEmpty: pending === 0,
      permanentFailures,
      permanentFailureCount: permanentFailures.total,
      failureFree: permanentFailures.total === 0,
    };
  } finally {
    await pool.end();
  }
}

async function barrier(options) {
  assertRunOption(options);
  const timeoutSeconds = integerOption(options, "timeout-seconds", 300, {
    min: 1,
    max: 7200,
  });
  const pool = databasePool();
  const started = Date.now();
  let peakPending = 0;
  let last;
  try {
    await assertMarker(pool);
    while (Date.now() - started <= timeoutSeconds * 1000) {
      last = await queueSnapshot(pool);
      const pending = pendingFromSnapshot(last);
      peakPending = Math.max(peakPending, pending);
      if (pending === 0) {
        const permanentFailures = permanentFailuresFromSnapshot(last);
        const result = {
          queueEmpty: true,
          drained: permanentFailures.total === 0,
          successful: permanentFailures.total === 0,
          drainState:
            permanentFailures.total === 0 ? "clean" : "permanent-failures",
          drainMs: Date.now() - started,
          peakPending,
          pending,
          permanentFailures,
          permanentFailureCount: permanentFailures.total,
          queue: last,
        };
        if (permanentFailures.total > 0) {
          throw capacityRuntimeError(
            `queue reached zero pending work with ${permanentFailures.total} permanent failures`,
            result,
          );
        }
        return result;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const pending = pendingFromSnapshot(last);
    const permanentFailures = permanentFailuresFromSnapshot(last);
    throw capacityRuntimeError(
      `queue did not drain within ${timeoutSeconds}s; pending=${pending}`,
      {
        queueEmpty: false,
        drained: false,
        successful: false,
        drainState: "timeout",
        drainMs: Date.now() - started,
        peakPending,
        pending,
        permanentFailures,
        permanentFailureCount: permanentFailures.total,
        queue: last,
      },
    );
  } finally {
    await pool.end();
  }
}

function numeric(values, accessor) {
  return values.map(accessor).map(Number).filter(Number.isFinite);
}

function nonnegativeDelta(first, last, accessor) {
  const before = Number(accessor(first) || 0);
  const after = Number(accessor(last) || 0);
  return Math.max(0, after - before);
}

function stageQueueDelta(stageId, documents) {
  const first = documents[0];
  const last = documents[documents.length - 1];
  const submissions = nonnegativeDelta(first, last, (item) => item.queue?.stepSync?.total);
  const v2JobInsertions = nonnegativeDelta(first, last, (item) => item.queue?.v2?.total);
  const v2GenerationTotalDelta = nonnegativeDelta(
    first,
    last,
    (item) => item.queue?.v2?.generationTotal,
  );
  const v2NetNewJobsWithMultipleGenerations = nonnegativeDelta(
    first,
    last,
    (item) => item.queue?.v2?.jobsTouched,
  );
  // Every new v2 row begins at generation one. Any additional generation in
  // the aggregate therefore proves an upsert which advanced a pre-existing
  // row. The separately gated queued-generation-merge path may coalesce an
  // upsert without advancing generation; snapshots intentionally label these
  // as a lower bound instead of claiming exact request-event telemetry.
  const v2GenerationAdvancingUpserts = Math.max(
    0,
    v2GenerationTotalDelta - v2JobInsertions,
  );
  return {
    stageId,
    observations: documents.length,
    submissions,
    v2JobInsertions,
    v2GenerationTotalDelta,
    v2GenerationAdvancingUpserts,
    v2NetNewJobsWithMultipleGenerations,
    submissionsPerInsertedJob:
      v2JobInsertions > 0 ? submissions / v2JobInsertions : null,
    observedGenerationCoalescingRatio:
      v2GenerationTotalDelta > 0 ? submissions / v2GenerationTotalDelta : null,
    queuedGenerationMergeMayUnderCount: true,
  };
}

async function report(options) {
  const input = options.observations || options.input;
  if (!input) throw new Error("--observations is required");
  const documents = fs.readFileSync(path.resolve(input), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (documents.length === 0) throw new Error("observation input is empty");
  const peaks = {
    queuePending: Math.max(...numeric(documents, (item) => item.pending)),
    dbConnections: Math.max(...numeric(documents, (item) => item.database?.connections?.total)),
    dbWaiting: Math.max(...numeric(documents, (item) => item.database?.connections?.waiting)),
    lockWaits: Math.max(...numeric(documents, (item) => item.database?.lockWaits)),
    poolerClientsActive: Math.max(...numeric(documents, (item) => item.pooler?.clients?.active), 0),
    poolerClientsWaiting: Math.max(...numeric(documents, (item) => item.pooler?.clients?.waiting), 0),
    poolerServersActive: Math.max(...numeric(documents, (item) => item.pooler?.servers?.active), 0),
  };
  const final = documents[documents.length - 1];
  const stages = new Map();
  for (const document of documents) {
    const stageId = document.stageId || "unscoped";
    if (!stages.has(stageId)) stages.set(stageId, []);
    stages.get(stageId).push(document);
  }
  const permanentFailures = permanentFailuresFromSnapshot(final.queue);
  const failedJobs = permanentFailures.total;
  return {
    observations: documents.length,
    startedAt: documents[0].observedAt,
    endedAt: final.observedAt,
    peaks,
    stageQueueDeltas: [...stages.entries()].map(([stageId, values]) =>
      stageQueueDelta(stageId, values)
    ),
    finalPending: Number(final.pending),
    permanentFailures,
    permanentFailureCount: permanentFailures.total,
    failedJobs,
    classification:
      Number(final.database?.deadlocks || 0) > 0 ||
      peaks.dbWaiting > 0 ||
      peaks.poolerClientsWaiting > 0
        ? "database-limit"
        : failedJobs > 0
          ? "application-limit"
          : Number(final.pending) > 0
            ? "inconclusive"
            : "drained",
  };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  let result;
  if (command === "inspect") result = await inspect(options);
  else if (command === "attest-workers") result = await attestCapacityWorkers(options);
  else if (command === "sanitize") result = await sanitize(options);
  else if (command === "verify-sanitized") result = await verifySanitized(options);
  else if (command === "inflate") result = await inflate(options);
  else if (command === "verify-inflation") result = await verifyInflation(options);
  else if (command === "canary") result = await canary(options);
  else if (command === "barrier") result = await barrier(options);
  else if (command === "observe") result = await observe(options);
  else if (command === "report") result = await report(options);
  emit(command, result);
}

main().catch((error) => {
  const command = process.argv[2] || null;
  process.stderr.write(`${JSON.stringify({
    ok: false,
    command,
    error: error instanceof Error ? error.message : String(error),
    ...(error?.details || {}),
  })}\n`);
  process.exitCode = 2;
});
