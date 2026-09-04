require("dotenv").config();

// Query events attach a global listener to every Prisma query. They are useful
// to local/integration capacity tooling, but enabling them in production adds
// hot-path work across the entire API. The staging process intentionally runs
// with NODE_ENV=production, so its existing port AND parsed database identity
// must both match the deployed staging topology. Anything ambiguous fails
// before constructing Prisma.
function isExplicitStagingRuntime(env = process.env) {
  if (env.PORT !== "3003" || typeof env.DATABASE_URL !== "string") {
    return false;
  }
  try {
    const parsed = new URL(env.DATABASE_URL);
    if (!["postgres:", "postgresql:"].includes(parsed.protocol)) return false;
    const databaseName = decodeURIComponent(parsed.pathname.slice(1));
    return databaseName === "bara-staging-pool";
  } catch {
    return false;
  }
}

if (
  process.env.NODE_ENV === "production" &&
  process.env.PRISMA_QUERY_EVENTS_ENABLED === "true" &&
  !isExplicitStagingRuntime()
) {
  throw new Error(
    "PRISMA_QUERY_EVENTS_ENABLED is allowed only for the explicit staging runtime (PORT=3003 and database bara-staging-pool)",
  );
}

const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { AsyncLocalStorage } = require("node:async_hooks");
const pg = require("pg");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set before initializing Prisma");
}

const dbUrl = process.env.DATABASE_URL;
const isLocalhost = dbUrl.includes("localhost") || dbUrl.includes("127.0.0.1");
const {
  capacityDatabasePoolMax,
  capacityDatabaseSslDisabled,
} = require("./localCapacitySafety");
const {
  resolveDatabasePoolConfig,
} = require("./shared/config/databasePoolConfig");
const {
  resolveProductionCliDatabasePoolConfig,
} = require("./shared/config/productionCliDatabasePoolConfig");
const capacitySslDisabled = capacityDatabaseSslDisabled();
const databasePoolConfig = resolveDatabasePoolConfig(process.env, {
  capacityDatabasePoolMax,
  productionCliDatabasePoolConfig: resolveProductionCliDatabasePoolConfig,
});
const databasePoolMax = databasePoolConfig.max;

// Strip sslmode from URL to prevent pg from overriding our ssl config
const connectionString = dbUrl.replace(/[?&]sslmode=[^&]*/g, "");

// Force pg to serialize and parse timestamps as UTC.
// Without this, JS Date objects get converted to local time on write
// and misinterpreted on read, causing timezone offset drift.
pg.types.setTypeParser(1114, (str) => new Date(str + 'Z'));
pg.defaults.parseInputDatesAsUTC = true;

const databaseApplicationName = [
  "steps",
  process.env.STEPS_PROCESS_ROLE || "all",
  process.env.NODE_APP_INSTANCE == null ? "0" : String(process.env.NODE_APP_INSTANCE),
].join("-").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 63);

const pool = new pg.Pool({
  connectionString,
  // Keep database-session timestamp casts deterministic. The adapter already
  // parses legacy timestamp-without-time-zone columns as UTC; an explicit UTC
  // session is also required for the new durable timestamptz admission lane so
  // Prisma never applies the host's local offset twice.
  options: `-c timezone=UTC -c application_name=${databaseApplicationName}`,
  max: databasePoolMax,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ...(isLocalhost || capacitySslDisabled
    ? {}
    : { ssl: { rejectUnauthorized: false } }),
});

let poolWaitMsTotal = 0;
let poolWaitCount = 0;
let poolWaitMsMax = 0;
let poolConnectFailures = 0;
const poolWaitSamples = [];
let poolMeasurementId = "process-lifetime";
let poolMeasurementGeneration = 0;
let poolMeasurementStartedAtMs = Date.now();
const rawPoolConnect = pool.connect.bind(pool);
const processRole = process.env.STEPS_PROCESS_ROLE || "all";
let connectionBulkhead = null;
let basePoolConnect = rawPoolConnect;
if (processRole === "http" && databasePoolMax >= 3) {
  const {
    createDatabaseConnectionBulkhead,
  } = require("./shared/database/databaseConnectionBulkhead");
  const {
    isStepAdmissionActive,
  } = require("./shared/observability/stepTelemetryContext");
  connectionBulkhead = createDatabaseConnectionBulkhead({
    connect: () => rawPoolConnect(),
    maximum: databasePoolMax,
    // Preserve four connections for launch reads under step-ingestion pressure.
    // When no step transaction is waiting, the bulkhead lends all ten to the
    // rest of the application.
    maximumStep: databasePoolMax - 4,
    isStep: isStepAdmissionActive,
  });
  basePoolConnect = connectionBulkhead.connect;
  pool.bulkheadSnapshot = connectionBulkhead.snapshot;
}
pool.connect = (callback) => {
  const started = process.hrtime.bigint();
  const measurementGenerationAtStart = poolMeasurementGeneration;
  const record = () => {
    // A checkout that began before the capacity measurement reset belongs to
    // startup, even if its callback settles after the synchronous epoch swap.
    if (measurementGenerationAtStart !== poolMeasurementGeneration) return false;
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    poolWaitMsTotal += elapsedMs;
    poolWaitCount += 1;
    poolWaitMsMax = Math.max(poolWaitMsMax, elapsedMs);
    if (process.env.CAPACITY_MODE === "true" || process.env.CAPACITY_MODE === "1") {
      poolWaitSamples.push(elapsedMs);
      if (poolWaitSamples.length > 100_000) {
        poolWaitSamples.splice(0, poolWaitSamples.length - 100_000);
      }
    }
    return true;
  };
  if (typeof callback === "function") {
    return basePoolConnect((error, client, release) => {
      const recorded = record();
      if (error && recorded) poolConnectFailures += 1;
      callback(error, client, release);
    });
  }
  return basePoolConnect().then((client) => {
    record();
    return client;
  }, (error) => {
    const recorded = record();
    if (recorded) poolConnectFailures += 1;
    throw error;
  });
};

function getDbPoolPressure() {
  const sortedWaits = [...poolWaitSamples].sort((left, right) => left - right);
  const waitMsP99 = sortedWaits.length
    ? sortedWaits[Math.min(sortedWaits.length - 1, Math.ceil(sortedWaits.length * 0.99) - 1)]
    : 0;
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: Math.max(
      pool.waitingCount,
      connectionBulkhead?.snapshot().queued || 0,
    ),
    max: databasePoolMax,
    waitMsTotal: poolWaitMsTotal,
    waitCount: poolWaitCount,
    waitMsMax: poolWaitMsMax,
    waitMsP99,
    waitMsAverage: poolWaitCount ? poolWaitMsTotal / poolWaitCount : 0,
    connectionFailures: poolConnectFailures,
    measurementId: poolMeasurementId,
    measurementGeneration: poolMeasurementGeneration,
    measurementStartedAtMs: poolMeasurementStartedAtMs,
  };
}

function resetDbPoolPressureForCapacity({ runId, measurementId, env = process.env } = {}) {
  const capacityMode = env.CAPACITY_MODE === "true" || env.CAPACITY_MODE === "1";
  if (!capacityMode || env.CAPACITY_GLOBAL_EVENT_PROFILE !== "home-open" ||
      typeof runId !== "string" || runId !== env.CAPACITY_RUN_ID) {
    throw new Error("capacity DB-pool measurement reset is not authorized");
  }
  if (typeof measurementId !== "string" || !/^[a-zA-Z0-9:._-]{1,160}$/.test(measurementId)) {
    throw new Error("capacity DB-pool measurement id is invalid");
  }
  if (poolMeasurementId !== measurementId) {
    poolWaitMsTotal = 0;
    poolWaitCount = 0;
    poolWaitMsMax = 0;
    poolConnectFailures = 0;
    poolWaitSamples.splice(0, poolWaitSamples.length);
    poolMeasurementId = measurementId;
    poolMeasurementGeneration += 1;
    poolMeasurementStartedAtMs = Date.now();
  }
  return {
    schema: "capacity-db-pool-measurement-reset-v1",
    runId,
    process: {
      role: processRole,
      instance: process.env.NODE_APP_INSTANCE == null ? "0" : String(process.env.NODE_APP_INSTANCE),
      pid: process.pid,
    },
    measurement: {
      id: poolMeasurementId,
      generation: poolMeasurementGeneration,
      startedAtMs: poolMeasurementStartedAtMs,
    },
  };
}

const adapter = new PrismaPg(pool);
const databasePoolTestSeam = process.env.NODE_ENV === "test"
  ? Object.freeze({ connect: () => pool.connect() })
  : null;

const {
  createDatabasePoolTelemetry,
} = require("./shared/observability/databasePoolTelemetry");
const redisCache = require("./shared/cache/redisCache");
const cacheKeys = require("./shared/cache/cacheKeys");
const databasePoolTelemetry = createDatabasePoolTelemetry({
  pool,
  poolConfigSource: databasePoolConfig.source,
  redisCache,
  cacheKeys,
});

const rootPrisma = new PrismaClient({
  adapter,
  // Query events are deliberately opt-in. Integration/benchmark processes may
  // enable them before loading db.js; production keeps Prisma's global query
  // event stream disabled so endpoint instrumentation cannot add hot-path work.
  ...(process.env.PRISMA_QUERY_EVENTS_ENABLED === "true"
    ? { log: [{ emit: "event", level: "query" }] }
    : {}),
});

if (process.env.PRISMA_QUERY_EVENTS_ENABLED === "true") {
  const {
    incrementRequestQueryCount,
  } = require("./shared/http/requestQueryCounter");
  rootPrisma.$on("query", incrementRequestQueryCount);
}

// Domain commands which must atomically compose several legacy model modules
// need every model to use the same Prisma transaction client. The modules
// historically import a singleton, so a stable proxy is used instead of
// threading a client through thousands of unrelated call sites. Outside a
// command transaction it is indistinguishable from the root client. Inside
// `runInPrismaTransaction`, all delegate calls resolve to the scoped tx.
const prismaScope = new AsyncLocalStorage();

const prisma = new Proxy(rootPrisma, {
  get(_target, property) {
    const scope = prismaScope.getStore();
    const client = scope?.client || rootPrisma;

    // Prisma transaction clients deliberately omit `$transaction`. Existing
    // model methods sometimes own a small nested transaction. When they are
    // composed by an outer domain transaction, reuse the outer client rather
    // than opening an independent commit boundary.
    if (property === "$transaction" && scope?.client) {
      return async (operation) => {
        if (typeof operation === "function") return operation(scope.client);
        if (Array.isArray(operation)) return Promise.all(operation);
        throw new TypeError("Unsupported nested Prisma transaction operation");
      };
    }

    if (property === "$transaction" && !scope) {
      return async (operation, options) => {
        if (typeof operation !== "function") {
          return rootPrisma.$transaction(operation, options);
        }
        const afterCommit = [];
        const afterRollback = [];
        let result;
        try {
          result = await rootPrisma.$transaction(
            (tx) => prismaScope.run(
              { client: tx, afterCommit, afterRollback },
              () => operation(tx),
            ),
            options,
          );
        } catch (error) {
          await runAfterTransactionTasks(afterRollback, "rollback");
          throw error;
        }
        await runAfterCommitTasks(afterCommit);
        return result;
      };
    }

    const value = Reflect.get(client, property, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
  set(_target, property, value) {
    const scope = prismaScope.getStore();
    const client = scope?.client || rootPrisma;
    return Reflect.set(client, property, value, client);
  },
});

function deferUntilAfterCommit(task) {
  const scope = prismaScope.getStore();
  if (!scope) return Promise.resolve().then(task);
  scope.afterCommit.push(task);
  return Promise.resolve();
}

function deferUntilAfterRollback(task) {
  const scope = prismaScope.getStore();
  if (!scope) return Promise.resolve();
  scope.afterRollback.push(task);
  return Promise.resolve();
}

function isInPrismaTransactionScope() {
  return Boolean(prismaScope.getStore());
}

async function runInPrismaTransaction(work, options = {}) {
  const existing = prismaScope.getStore();
  if (existing) return work(existing.client);

  const afterCommit = [];
  const afterRollback = [];
  let result;
  try {
    result = await rootPrisma.$transaction(
      (tx) => prismaScope.run(
        { client: tx, afterCommit, afterRollback },
        () => work(tx),
      ),
      options,
    );
  } catch (error) {
    await runAfterTransactionTasks(afterRollback, "rollback");
    throw error;
  }
  await runAfterCommitTasks(afterCommit);
  return result;
}

async function runAfterCommitTasks(tasks, logger = console) {
  return runAfterTransactionTasks(tasks, "commit", logger);
}

async function runAfterTransactionTasks(tasks, phase, logger = console) {
  for (const task of tasks || []) {
    try {
      await task();
    } catch (error) {
      logger.error(`[DB] post${phase} callback failed`, error);
    }
  }
}

module.exports = {
  prisma,
  databasePoolConfig,
  databasePoolTestSeam,
  getDbPoolPressure,
  resetDbPoolPressureForCapacity,
  databasePoolTelemetry,
  runInPrismaTransaction,
  deferUntilAfterCommit,
  deferUntilAfterRollback,
  isInPrismaTransactionScope,
  runAfterCommitTasks,
};
