// Optional connection to the "peer" environment's database (prod's peer is
// staging and vice-versa). Used so admin edits to the cosmetic catalog can be
// mirrored to both databases, keeping them consistent no matter which
// environment the editor is pointed at.
//
// Configured via PEER_DATABASE_URL. If it is unset (e.g. there is no peer to
// mirror to yet), getPeerPrisma() returns null and all mirroring is skipped —
// a safe no-op, never an error.
//
// NOTE: db.js sets the global pg type parsers (UTC handling) at require-time;
// this module reuses those globals, so require db.js before this if you need
// them. In practice db.js is loaded at server startup.
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const pg = require("pg");

let peerPrisma = null;
let initialized = false;

function getPeerPrisma() {
  if (initialized) return peerPrisma;
  initialized = true;

  const url = process.env.PEER_DATABASE_URL;
  if (!url) {
    peerPrisma = null;
    return null;
  }

  const isLocalhost = url.includes("localhost") || url.includes("127.0.0.1");
  // Strip sslmode so pg doesn't override the ssl config below (mirrors db.js).
  const connectionString = url.replace(/[?&]sslmode=[^&]*/g, "");

  const pool = new pg.Pool({
    connectionString,
    // Small pool: mirroring is low-volume (admin edits only).
    max: 3,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    ...(isLocalhost ? {} : { ssl: { rejectUnauthorized: false } }),
  });

  const adapter = new PrismaPg(pool);
  peerPrisma = new PrismaClient({ adapter });
  return peerPrisma;
}

module.exports = { getPeerPrisma };
