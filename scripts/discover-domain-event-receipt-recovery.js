#!/usr/bin/env node
// Bounded, resumable keyset discovery. Dry-run is read-only; --apply only
// inserts idempotent recovery candidates and prints the cursor for the next
// invocation. Apply pages share automatic discovery admission and may defer;
// explicit cursors never advance either persisted checkpoint.
// No payloads are reconstructed here.
process.env.DOTENV_CONFIG_QUIET = "true";
require("dotenv").config({ quiet: true });

const DB_ALIASES = { local: "DATABASE_URL", staging: "STAGING_DATABASE_URL", prod: "PROD_DATABASE_URL" };

function parseArgs(argv) {
  const result = { db: "local", cutoff: null, limit: 500, afterCreatedAt: null, afterId: null, apply: false };
  for (const arg of argv) {
    if (arg.startsWith("--db=")) result.db = arg.slice(5);
    else if (arg.startsWith("--cutoff=")) result.cutoff = arg.slice(9);
    else if (arg.startsWith("--limit=")) result.limit = Number(arg.slice(8));
    else if (arg.startsWith("--after-created-at=")) result.afterCreatedAt = arg.slice(19);
    else if (arg.startsWith("--after-id=")) result.afterId = arg.slice(11);
    else if (arg === "--apply") result.apply = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!result.cutoff || Number.isNaN(new Date(result.cutoff).getTime())) throw new Error("--cutoff must be an ISO date");
  if (!Number.isInteger(result.limit) || result.limit < 1 || result.limit > 500) throw new Error("--limit must be an integer from 1 through 500");
  if (Boolean(result.afterCreatedAt) !== Boolean(result.afterId)) throw new Error("--after-created-at and --after-id must be supplied together");
  if (result.afterCreatedAt && Number.isNaN(new Date(result.afterCreatedAt).getTime())) throw new Error("--after-created-at must be an ISO date");
  if (result.afterId && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(result.afterId)) throw new Error("--after-id must be a UUID");
  return result;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const envKey = DB_ALIASES[options.db];
  if (!envKey) throw new Error(`Unknown --db target "${options.db}"`);
  const url = process.env[envKey];
  if (!url) throw new Error(`${envKey} is required`);
  process.env.DATABASE_URL = url;
  const { prisma } = require("../src/db");
  const recovery = require("../src/modules/domainEvents/models/domainEventReceiptRecovery").DomainEventReceiptRecovery;
  const cursor = options.afterCreatedAt || options.afterId
    ? { createdAt: new Date(options.afterCreatedAt || 0), id: options.afterId || "00000000-0000-0000-0000-000000000000" }
    : null;
  try {
    const result = options.apply
      ? await (cursor ? recovery.discoverPage({ cutoff: new Date(options.cutoff), cursor, limit: options.limit })
        : recovery.discoverNextPage({ cutoff: new Date(options.cutoff), limit: options.limit }))
      : await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout='2s'");
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout='250ms'");
        return tx.$queryRawUnsafe(`
          WITH source_page AS MATERIALIZED (
            SELECT id,event_key,created_at FROM domain_event_outbox
             WHERE created_at <= $1 AND (created_at,id) > ($2,$3::uuid)
             ORDER BY created_at,id LIMIT $4
          )
          SELECT event.id AS "domainEventId",event.event_key AS "eventKey",event.created_at AS "createdAt",
                 COALESCE(receipt.receipt_state,'MISSING') AS "receiptState"
            FROM source_page event
            LEFT JOIN LATERAL (
              SELECT receipt_state FROM domain_event_receipts
               WHERE domain_event_id=event.id LIMIT 1
            ) receipt ON true
           ORDER BY event.created_at,event.id`,
        new Date(options.cutoff), cursor?.createdAt || new Date(0), cursor?.id || "00000000-0000-0000-0000-000000000000", options.limit);
      }, { timeout: 5_000, maxWait: 2_000 })
      .then((rows) => ({ deferred: false, scanned: rows.length, discovered: rows.filter((row) => row.receiptState !== "FINAL").length, rows, nextCursor: rows.length ? {
        createdAt: new Date(rows.at(-1).createdAt).toISOString(), id: rows.at(-1).domainEventId,
      } : cursor, exhausted: rows.length < options.limit }));
    console.log(JSON.stringify({ readOnly: !options.apply, target: options.db, cutoff: options.cutoff, ...result }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((error) => {
    console.error(error?.stack || error);
    process.exit(1);
  });
}

module.exports = { main, parseArgs };
