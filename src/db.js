require("dotenv").config();
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
const capacitySslDisabled = capacityDatabaseSslDisabled();
const databasePoolMax = capacityDatabasePoolMax();

// Strip sslmode from URL to prevent pg from overriding our ssl config
const connectionString = dbUrl.replace(/[?&]sslmode=[^&]*/g, "");

// Force pg to serialize and parse timestamps as UTC.
// Without this, JS Date objects get converted to local time on write
// and misinterpreted on read, causing timezone offset drift.
pg.types.setTypeParser(1114, (str) => new Date(str + 'Z'));
pg.defaults.parseInputDatesAsUTC = true;

const pool = new pg.Pool({
  connectionString,
  max: databasePoolMax,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ...(isLocalhost || capacitySslDisabled
    ? {}
    : { ssl: { rejectUnauthorized: false } }),
});

function getDbPoolPressure() {
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
    max: databasePoolMax,
  };
}

const adapter = new PrismaPg(pool);

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

async function runInPrismaTransaction(work, options = {}) {
  const existing = prismaScope.getStore();
  if (existing) return work(existing.client);

  const afterCommit = [];
  const result = await rootPrisma.$transaction(
    (tx) => prismaScope.run({ client: tx, afterCommit }, () => work(tx)),
    options,
  );
  await runAfterCommitTasks(afterCommit);
  return result;
}

async function runAfterCommitTasks(tasks, logger = console) {
  for (const task of tasks || []) {
    try {
      await task();
    } catch (error) {
      logger.error("[DB] postcommit callback failed", error);
    }
  }
}

module.exports = {
  prisma,
  getDbPoolPressure,
  runInPrismaTransaction,
  deferUntilAfterCommit,
  runAfterCommitTasks,
};
