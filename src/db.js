require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const pg = require("pg");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set before initializing Prisma");
}

const dbUrl = process.env.DATABASE_URL;
const isLocalhost = dbUrl.includes("localhost") || dbUrl.includes("127.0.0.1");

// Strip sslmode from URL to prevent pg from overriding our ssl config
const connectionString = dbUrl.replace(/[?&]sslmode=[^&]*/g, "");

// Force pg to serialize and parse timestamps as UTC.
// Without this, JS Date objects get converted to local time on write
// and misinterpreted on read, causing timezone offset drift.
pg.types.setTypeParser(1114, (str) => new Date(str + 'Z'));
pg.defaults.parseInputDatesAsUTC = true;

const pool = new pg.Pool({
  connectionString,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ...(isLocalhost ? {} : { ssl: { rejectUnauthorized: false } }),
});

function getDbPoolPressure() {
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };
}

const adapter = new PrismaPg(pool);

const prisma = new PrismaClient({
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
  prisma.$on("query", incrementRequestQueryCount);
}

module.exports = { prisma, getDbPoolPressure };
