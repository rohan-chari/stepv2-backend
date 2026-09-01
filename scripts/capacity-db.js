#!/usr/bin/env node

require("dotenv").config();

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { Client } = require("pg");
const { assertCapacityDatabase, assertOutboundDisabled, capacityIdentity } = require("../src/localCapacitySafety");
const { createScrubAttestation } = require("../src/modules/loadTesting/safety");
const { writeCapacityOperatorMarker } = require("../src/modules/loadTesting/capacityDatabaseMarker");

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = path.resolve(__filename);

function args(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2).replaceAll("-", "_");
    const next = argv[index + 1];
    result[key] = !next || next.startsWith("--") ? true : argv[++index];
  }
  return result;
}

function required(value, name) {
  if (!value) throw new Error(`--${name.replaceAll("_", "-")} is required`);
  return value;
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function assertTarget(env = process.env) {
  if (env.CAPACITY_MODE === "true" || env.CAPACITY_MODE === "1") {
    assertCapacityDatabase(env.DATABASE_URL, env);
    assertOutboundDisabled(env);
    return;
  }
  const target = new URL(String(env.DATABASE_URL || ""));
  const host = target.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const database = decodeURIComponent(target.pathname.slice(1)).toLowerCase();
  const octets = net.isIPv4(host) ? host.split(".").map(Number) : [];
  const privateHost = ["localhost", "127.0.0.1", "::1"].includes(host) ||
    (net.isIPv4(host) && (octets[0] === 10 || octets[0] === 127 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168))) ||
    (net.isIPv6(host) && (host.startsWith("fc") || host.startsWith("fd")));
  if (!privateHost || !/(^|[_-])(capacity|test)([_-]|$)/.test(database) || /prod|production|steptracker/.test(database)) {
    throw new Error("capacity-db requires a private host and a disposable capacity/test database");
  }
}

async function withClient(work) {
  assertTarget();
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try { return await work(client); } finally { await client.end(); }
}

async function scrub(client, identity) {
  await client.query("BEGIN");
  try {
    await client.query('DELETE FROM "device_tokens"');
    const { rows: columns } = await client.query(`
      SELECT table_name, column_name, is_nullable, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND data_type IN ('character varying', 'character', 'text')
        AND (
          column_name ~* '(email|phone|apple_id|google_sub|provider_sub_hash|referee_sub_hash|ip_hash|ip_net_hash|device_token|access_token|refresh_token|password|secret|token|display_name|body|title|description|message|source_name|free_text)'
        )
      ORDER BY table_name, ordinal_position
    `);
    for (const column of columns) {
      if (column.table_name === "device_tokens") continue;
      // Deleting device_tokens already clears this nullable FK via ON DELETE
      // SET NULL. Replacing it with scrub text would violate the live FK.
      if (column.table_name === "inbox_delivery_device_attempts" && column.column_name === "device_token_id") continue;
      const table = `"${column.table_name.replaceAll('"', '""')}"`;
      const name = `"${column.column_name.replaceAll('"', '""')}"`;
      const seed = `'load-scrub-' || md5(${sqlLiteral(`${column.table_name}:${column.column_name}:`)} || ctid::text)`;
      const value = column.column_name === "email" ? `${seed} || '@capacity.invalid'` : seed;
      await client.query(`UPDATE ${table} SET ${name} = ${value}`);
    }
    await writeCapacityOperatorMarker(client, identity);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function verify(client) {
  const { rows: tokens } = await client.query('SELECT count(*)::int AS count FROM "device_tokens"');
  if (Number(tokens[0]?.count || 0) !== 0) throw new Error("capacity scrub verification found device tokens");
  const { rows: columns } = await client.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND data_type IN ('character varying', 'character', 'text')
      AND column_name ~* '(email|phone|apple_id|google_sub|provider_sub_hash|referee_sub_hash|ip_hash|ip_net_hash|device_token|access_token|refresh_token|password|secret|token|display_name|body|title|description|message|source_name|free_text)'
      AND table_name <> 'device_tokens'
  `);
  for (const column of columns) {
    const table = `"${column.table_name.replaceAll('"', '""')}"`;
    const name = `"${column.column_name.replaceAll('"', '""')}"`;
    const { rows } = await client.query(`SELECT count(*)::int AS count FROM ${table} WHERE ${name} IS NOT NULL AND ${name} NOT LIKE 'load-scrub-%'`);
    if (Number(rows[0]?.count || 0) !== 0) throw new Error(`capacity scrub verification found unsanitized ${column.table_name}.${column.column_name}`);
  }
  return { deviceTokens: 0, sensitiveColumnsVerified: columns.length };
}

function postgresRestoreTarget(databaseUrl, parentEnv = process.env) {
  const target = new URL(databaseUrl);
  const database = decodeURIComponent(target.pathname.slice(1));
  if (!database) throw new Error("DATABASE_URL must include a database name");
  const { DATABASE_URL: _databaseUrl, ...childEnv } = parentEnv;
  return {
    database,
    env: {
      ...childEnv,
      PGHOST: target.hostname.replace(/^\[|\]$/g, ""),
      PGPORT: target.port || "5432",
      PGUSER: decodeURIComponent(target.username),
      PGPASSWORD: decodeURIComponent(target.password),
      PGDATABASE: database,
    },
  };
}

async function restore(input) {
  assertTarget();
  const snapshot = path.resolve(required(input.snapshot, "snapshot"));
  if (!fs.existsSync(snapshot)) throw new Error(`snapshot does not exist: ${snapshot}`);
  const databaseUrl = required(process.env.DATABASE_URL, "DATABASE_URL");
  const target = postgresRestoreTarget(databaseUrl);
  const options = { timeout: 600000, env: target.env };
  const extension = path.extname(snapshot).toLowerCase();
  if ([".dump", ".backup", ".tar"].includes(extension)) {
    await execFileAsync("pg_restore", ["--clean", "--if-exists", "--no-owner", "--exit-on-error", "--dbname", target.database, snapshot], options);
  } else {
    await execFileAsync("psql", ["--dbname", target.database, "--command", "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"], options);
    await execFileAsync("psql", ["--dbname", target.database, "--file", snapshot, "--single-transaction"], options);
  }
  return { restored: true, snapshot, snapshotSha256: sha256File(snapshot) };
}

async function scrubAndAttest(input) {
  const snapshot = path.resolve(required(input.snapshot, "snapshot"));
  const attestationPath = path.resolve(required(input.attestation, "attestation"));
  const secret = required(process.env.CAPACITY_SCRUB_ATTESTATION_SECRET, "CAPACITY_SCRUB_ATTESTATION_SECRET");
  const identity = capacityIdentity(process.env);
  const result = await withClient(async (client) => {
    await scrub(client, identity);
    const verification = await verify(client);
    return { verification };
  });
  const attestation = createScrubAttestation({
    snapshotHash: sha256File(snapshot),
    scrubScriptHash: sha256File(SCRIPT_PATH),
    baseline: { verification: result.verification },
    expiresAt: input.expires_at || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  }, secret);
  fs.mkdirSync(path.dirname(attestationPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(attestationPath, `${JSON.stringify(attestation, null, 2)}\n`, { mode: 0o600 });
  return { scrubbed: true, attestationPath, snapshotSha256: sha256File(snapshot), scrubScriptHash: attestation.scrubScriptHash, verification: result.verification };
}

function packageSnapshot(input) {
  const source = path.resolve(required(input.source, "source"));
  const manifest = path.resolve(required(input.manifest, "manifest"));
  const output = path.resolve(required(input.output, "output"));
  const attestation = input.attestation ? path.resolve(input.attestation) : path.join(path.dirname(output), "capacity-scrub-attestation.json");
  if (!fs.existsSync(source) || !fs.existsSync(manifest)) throw new Error("snapshot package source and manifest must exist");
  const sourceSnapshotHash = sha256File(source);
  const approvedManifest = JSON.parse(fs.readFileSync(manifest, "utf8"));
  if (fs.existsSync(attestation)) {
    const scrubAttestation = JSON.parse(fs.readFileSync(attestation, "utf8"));
    if (scrubAttestation.snapshotHash !== sourceSnapshotHash) throw new Error("scrub attestation is not bound to source snapshot bytes");
  }
  const snapshot = {
    schema: "capacity-snapshot-v1",
    snapshotHash: sourceSnapshotHash,
    sourceSnapshotPath: source,
    sourceSnapshotHash,
    approvedManifest,
    scrubAttestationPath: attestation,
    scrubScriptPath: input.scrub_script ? path.resolve(input.scrub_script) : SCRIPT_PATH,
    packagedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  fs.writeFileSync(output, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  return { packaged: true, output, snapshotHash: sourceSnapshotHash };
}

async function main() {
  const [command] = process.argv.slice(2);
  const input = args(process.argv.slice(3));
  if (command === "restore") return restore(input);
  if (command === "scrub") return scrubAndAttest(input);
  if (command === "package") return packageSnapshot(input);
  if (command === "verify") return withClient(verify);
  throw new Error("usage: node scripts/capacity-db.js <restore|scrub|package|verify> [options]");
}

main().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
