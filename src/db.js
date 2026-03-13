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

const pool = new pg.Pool({
  connectionString,
  ...(isLocalhost ? {} : { ssl: { rejectUnauthorized: false } }),
});

const adapter = new PrismaPg(pool);

const prisma = new PrismaClient({ adapter });

module.exports = { prisma };
