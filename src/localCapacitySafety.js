const crypto = require("node:crypto");
const net = require("node:net");

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const PRODUCTION_DATABASE_NAMES = new Set([
  "steptracker",
  "steptracker_prod",
  "steps_tracker",
  "steps_tracker_prod",
  "production",
]);
const RUN_ID_RE = /^[a-z0-9][a-z0-9._-]{5,63}$/;
const OUTBOUND_SECRET_KEYS = Object.freeze([
  "APNS_KEY_PATH",
  "APNS_SIGNING_KEY",
  "APNS_KEY_ID",
  "APNS_TEAM_ID",
  "APNS_BUNDLE_ID",
  "FCM_SERVICE_ACCOUNT",
  "FCM_SERVICE_ACCOUNT_PATH",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_SESSION_TOKEN",
]);
const EXTERNAL_DATABASE_URL_KEYS = Object.freeze([
  "PROD_DATABASE_URL",
  "STAGING_DATABASE_URL",
]);
let capacityProviderCensus = null;

function readCapacityProviderCensus() {
  return capacityProviderCensus == null
    ? null
    : JSON.parse(JSON.stringify(capacityProviderCensus));
}

function strictTrue(value) {
  return value === "true" || value === "1";
}

function capacityDatabasePoolMax(env = process.env) {
  const productionDefault = 20;
  if (!strictTrue(env.CAPACITY_MODE)) return productionDefault;
  const raw = String(env.DB_POOL_MAX || "").trim();
  if (!raw) return productionDefault;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > productionDefault) {
    throw new Error(`DB_POOL_MAX must be an integer from 1 through ${productionDefault} in capacity mode`);
  }
  capacityIdentity(env);
  assertCapacityDatabase(env.DATABASE_URL, env);
  return value;
}

function normalizeHostname(hostname) {
  return String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

function isPrivateCapacityHost(hostname) {
  const host = normalizeHostname(hostname);
  if (LOOPBACK_HOSTS.has(host)) return true;
  if (net.isIPv4(host)) {
    const octets = host.split(".").map(Number);
    return octets[0] === 10 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 169 && octets[1] === 254) ||
      octets[0] === 127;
  }
  if (net.isIPv6(host)) {
    return host.startsWith("fc") || host.startsWith("fd") || /^fe[89ab]/.test(host);
  }
  return false;
}

function parseHostAllowlist(value, name) {
  const hosts = String(value || "")
    .split(",")
    .map(normalizeHostname)
    .filter(Boolean);
  if (hosts.length !== 1 || new Set(hosts).size !== 1) {
    throw new Error(`${name} must contain exactly one run-bound host`);
  }
  if (!isPrivateCapacityHost(hosts[0])) {
    throw new Error(`${name} must contain a loopback or private IP host`);
  }
  return hosts[0];
}

function parsePostgresTarget(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("DATABASE_URL must use PostgreSQL");
  }
  if (parsed.searchParams.has("host") || parsed.searchParams.has("hostaddr")) {
    throw new Error("capacity DATABASE_URL cannot override its host in query parameters");
  }
  const host = normalizeHostname(parsed.hostname);
  const database = decodeURIComponent(parsed.pathname.slice(1)).toLowerCase();
  if (!host || !database) throw new Error("DATABASE_URL requires a host and database");
  if (
    host === "steptracker-api.org" ||
    host.endsWith(".steptracker-api.org") ||
    PRODUCTION_DATABASE_NAMES.has(database) ||
    /(^|[_-])(prod|production)([_-]|$)/.test(database)
  ) {
    throw new Error("production database targets are categorically forbidden");
  }
  return { host, database, parsed };
}

function capacityIdentity(env = process.env) {
  if (!strictTrue(env.CAPACITY_MODE)) {
    throw new Error("CAPACITY_MODE must be true");
  }
  const runId = String(env.CAPACITY_RUN_ID || "");
  if (!RUN_ID_RE.test(runId)) {
    throw new Error("CAPACITY_RUN_ID must be 6-64 lowercase safe characters");
  }
  const marker = String(env.CAPACITY_DB_MARKER || "");
  if (marker.length < 16) {
    throw new Error("CAPACITY_DB_MARKER must contain at least 16 characters");
  }
  return {
    runId,
    marker,
    markerHash: crypto.createHash("sha256").update(marker).digest("hex"),
  };
}

function capacityAuthSecret(env = process.env) {
  const primary = String(env.CAPACITY_AUTH_SECRET || "");
  const compatibilityAlias = String(env.CAPACITY_JWT_SECRET || "");
  if (primary && compatibilityAlias && primary !== compatibilityAlias) {
    throw new Error("CAPACITY_AUTH_SECRET and CAPACITY_JWT_SECRET conflict");
  }
  const secret = primary || compatibilityAlias;
  if (secret.length < 32) {
    throw new Error("CAPACITY_AUTH_SECRET must contain at least 32 characters");
  }
  if (String(env.SESSION_TOKEN_SECRET || "") !== secret) {
    throw new Error("SESSION_TOKEN_SECRET must equal the run-only CAPACITY_AUTH_SECRET");
  }
  return secret;
}

function assertCapacityDatabase(databaseUrl = process.env.DATABASE_URL, env = process.env) {
  const target = parsePostgresTarget(databaseUrl);
  const expectedHost = parseHostAllowlist(
    env.CAPACITY_DB_HOST_ALLOWLIST,
    "CAPACITY_DB_HOST_ALLOWLIST",
  );
  if (target.host !== expectedHost) {
    throw new Error("DATABASE_URL host does not match CAPACITY_DB_HOST_ALLOWLIST");
  }
  const expectedDatabase = String(env.CAPACITY_DB_NAME || "").trim().toLowerCase();
  if (!expectedDatabase || target.database !== expectedDatabase) {
    throw new Error("DATABASE_URL database does not match CAPACITY_DB_NAME");
  }
  if (!/(^|[_-])(capacity|test)([_-]|$)/.test(expectedDatabase)) {
    throw new Error("CAPACITY_DB_NAME must contain a capacity or test token");
  }
  return target;
}

// Backward-compatible name retained for pre-existing local profiling tools.
// The operator gets the stronger run-bound guard whenever CAPACITY_MODE is set.
function assertLocalCapacityDatabase(databaseUrl = process.env.DATABASE_URL) {
  if (strictTrue(process.env.CAPACITY_MODE)) {
    return assertCapacityDatabase(databaseUrl);
  }
  const target = parsePostgresTarget(databaseUrl);
  if (!LOOPBACK_HOSTS.has(target.host)) {
    throw new Error("local capacity tooling requires loopback PostgreSQL");
  }
  if (!/(^|[_-])(capacity|test)([_-]|$)/.test(target.database)) {
    throw new Error("local capacity database name must contain capacity or test");
  }
  return target;
}

function assertOutboundDisabled(env = process.env) {
  if (!strictTrue(env.CAPACITY_OUTBOUND_DISABLED)) {
    throw new Error("CAPACITY_OUTBOUND_DISABLED must be true");
  }
  const leaked = OUTBOUND_SECRET_KEYS.filter((name) => String(env[name] || "").trim());
  if (leaked.length > 0) {
    throw new Error(`outbound credential fields must be empty: ${leaked.join(", ")}`);
  }
  if (String(env.APNS_PRODUCTION || "false") === "true") {
    throw new Error("APNS_PRODUCTION must not be true in capacity mode");
  }
  if (String(env.PEER_DATABASE_URL || "").trim()) {
    throw new Error("PEER_DATABASE_URL must be empty in capacity mode");
  }
  const externalDatabases = EXTERNAL_DATABASE_URL_KEYS.filter((name) =>
    String(env[name] || "").trim()
  );
  if (externalDatabases.length > 0) {
    throw new Error(
      `non-capacity database URL fields must be empty: ${externalDatabases.join(", ")}`
    );
  }
  return {
    outboundDisabled: true,
    clearedCredentialCount: OUTBOUND_SECRET_KEYS.length,
    clearedExternalDatabaseCount: EXTERNAL_DATABASE_URL_KEYS.length,
  };
}

function installLocalNotificationSink(env = process.env) {
  const profile = String(env.CAPACITY_GLOBAL_EVENT_PROFILE || "");
  if (["event_boundary_10000", "event_provider_outage_10000"].includes(profile)) {
    const { buildCapacityProviderSender } = require("./modules/loadTesting/globalEventReliabilityProfiles");
    let firstAttemptAt = null;
    const attemptCount = Number(env.CAPACITY_PROVIDER_ATTEMPT_COUNT) || 12_000;
    capacityProviderCensus = {
      profile,
      attemptCount,
      totalCalls: 0,
      initialCycle: { total: 0, accepted: 0, throttled: 0, transient: 0, invalid: 0 },
    };
    const sender = buildCapacityProviderSender({
      profile,
      attemptCount,
      elapsedMs: () => firstAttemptAt == null ? 0 : Date.now() - firstAttemptAt,
      nextAttemptIndex: (() => {
        let index = 0;
        return () => {
          if (firstAttemptAt == null) firstAttemptAt = Date.now();
          return index++;
        };
      })(),
      observeResult: ({ attemptIndex, result }) => {
        capacityProviderCensus.totalCalls += 1;
        if (attemptIndex >= attemptCount) return;
        capacityProviderCensus.initialCycle.total += 1;
        capacityProviderCensus.initialCycle[result.kind.toLowerCase()] += 1;
      },
    });
    const { apnsService } = require("./shared/push/apns");
    const { fcmService } = require("./shared/push/fcm");
    apnsService.sendNotification = sender;
    apnsService.sendSilentNotification = sender;
    apnsService.close = async () => {};
    fcmService.sendNotification = sender;
    fcmService.sendSilentNotification = sender;
    return Object.freeze({
      localCapacitySink: true,
      deterministicProvider: true,
      profile,
    });
  }
  const sinkResult = Object.freeze({
    success: true,
    localCapacitySink: true,
    providerDisposition: "capacity_sink",
  });
  capacityProviderCensus = null;
  const sink = async () => sinkResult;

  // Patch the shared singleton objects before application modules destructure
  // them. This is independent of credential removal and VM egress policy.
  const { apnsService } = require("./shared/push/apns");
  const { fcmService } = require("./shared/push/fcm");
  apnsService.sendNotification = sink;
  apnsService.sendSilentNotification = sink;
  apnsService.close = async () => {};
  fcmService.sendNotification = sink;
  fcmService.sendSilentNotification = sink;
  return sinkResult;
}

function secureLocalRedis(env = process.env) {
  const redisUrl = String(env.REDIS_URL || "").trim();
  let redis = { enabled: false, host: null };
  if (redisUrl) {
    let parsed;
    try {
      parsed = new URL(redisUrl);
    } catch {
      throw new Error("capacity REDIS_URL must be a valid URL");
    }
    const host = normalizeHostname(parsed.hostname);
    if (!["redis:", "rediss:"].includes(parsed.protocol)) {
      throw new Error("capacity REDIS_URL must use redis or rediss");
    }
    if (!LOOPBACK_HOSTS.has(host)) {
      const expected = parseHostAllowlist(
        env.CAPACITY_REDIS_HOST_ALLOWLIST,
        "CAPACITY_REDIS_HOST_ALLOWLIST",
      );
      if (host !== expected) {
        throw new Error("REDIS_URL host does not match CAPACITY_REDIS_HOST_ALLOWLIST");
      }
    }
    redis = { enabled: true, host };
  }
  const { runId } = capacityIdentity(env);
  env.CACHE_ENV_PREFIX = `capacity:${runId}:`;
  return redis;
}

function validateCapacityPgBouncer(env = process.env) {
  const adminUrl = String(env.CAPACITY_PGBOUNCER_ADMIN_URL || "").trim();
  if (!adminUrl) return { enabled: false, host: null };
  const admin = parsePostgresTarget(adminUrl);
  const database = assertCapacityDatabase(env.DATABASE_URL, env);
  if (admin.host !== database.host || admin.database !== "pgbouncer") {
    throw new Error("CAPACITY_PGBOUNCER_ADMIN_URL must target the run-bound DB host and pgbouncer database");
  }
  if (!admin.parsed.username) {
    throw new Error("CAPACITY_PGBOUNCER_ADMIN_URL requires an admin username");
  }
  return { enabled: true, host: admin.host };
}

function validateCapacityEnvironment(env = process.env) {
  const identity = capacityIdentity(env);
  const database = assertCapacityDatabase(env.DATABASE_URL, env);
  capacityAuthSecret(env);
  const outbound = assertOutboundDisabled(env);
  const redis = secureLocalRedis(env);
  const pooler = validateCapacityPgBouncer(env);
  return {
    runId: identity.runId,
    markerHash: identity.markerHash,
    database: { host: database.host, name: database.database },
    redis,
    pooler,
    outbound,
  };
}

function capacityDatabaseSslDisabled(env = process.env) {
  if (env.CAPACITY_DATABASE_SSL_DISABLED !== "true") return false;
  // This override is intentionally unavailable to normal production/staging
  // startup. A caller may disable TLS only after the entire run-bound capacity
  // target, auth, Redis, peer-DB, and outbound environment validates.
  validateCapacityEnvironment(env);
  return true;
}

async function assertCapacityDatabaseMarker({ env = process.env, pool } = {}) {
  const validated = validateCapacityEnvironment(env);
  const ownPool = !pool;
  const target = parsePostgresTarget(env.DATABASE_URL);
  const connectionString = env.DATABASE_URL.replace(/[?&]sslmode=[^&]*/g, "");
  const databasePool = pool || new (require("pg").Pool)({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5000,
    ...(LOOPBACK_HOSTS.has(target.host) || capacityDatabaseSslDisabled(env)
      ? {}
      : { ssl: { rejectUnauthorized: false } }),
  });
  try {
    const result = await databasePool.query(`
      SELECT run_id AS "runId", marker_hash AS "markerHash", sanitized_at AS "sanitizedAt"
      FROM capacity_operator_runs
      WHERE singleton = true
    `);
    const row = result.rows[0];
    if (
      result.rowCount !== 1 ||
      row.runId !== validated.runId ||
      row.markerHash !== validated.markerHash ||
      !row.sanitizedAt
    ) {
      throw new Error("capacity database marker or sanitization proof does not match this run");
    }
    return { ...validated, sanitizedAt: row.sanitizedAt };
  } catch (error) {
    if (error?.code === "42P01") {
      throw new Error("capacity database marker is absent; sanitize must complete first");
    }
    throw error;
  } finally {
    if (ownPool) await databasePool.end();
  }
}

function prepareLocalCapacityProcess() {
  const validated = validateCapacityEnvironment();
  process.env.HOST = "127.0.0.1";
  process.env.APNS_PRODUCTION = "false";
  process.env.OPS_USER_FANOUTS_DISABLED = "true";
  const notificationSink = installLocalNotificationSink(process.env);
  return { ...validated, databasePoolMax: capacityDatabasePoolMax(), notificationSink };
}

module.exports = {
  LOOPBACK_HOSTS,
  EXTERNAL_DATABASE_URL_KEYS,
  OUTBOUND_SECRET_KEYS,
  assertCapacityDatabase,
  assertCapacityDatabaseMarker,
  assertLocalCapacityDatabase,
  assertOutboundDisabled,
  capacityAuthSecret,
  capacityDatabasePoolMax,
  capacityDatabaseSslDisabled,
  capacityIdentity,
  installLocalNotificationSink,
  isPrivateCapacityHost,
  normalizeHostname,
  parsePostgresTarget,
  prepareLocalCapacityProcess,
  readCapacityProviderCensus,
  secureLocalRedis,
  strictTrue,
  validateCapacityPgBouncer,
  validateCapacityEnvironment,
};
