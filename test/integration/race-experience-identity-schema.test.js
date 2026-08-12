const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it, before, beforeEach } = require("node:test");

const { cleanDatabase, prisma, getSharedServer } = require("./setup");

const MIGRATION_PATH = path.join(
  __dirname,
  "../../prisma/migrations/20260811190000_race_identity_and_auto_link/migration.sql"
);
const SEARCH_INDEX_RUNBOOK_PATH = path.join(
  __dirname,
  "../../docs/race-experience-identity-search-index-runbook.md"
);
const SEARCH_INDEX_SQL_PATH = path.join(
  __dirname,
  "../../scripts/race-experience-identity-search-indexes.sql"
);

describe("race experience + discoverable identity — additive data contract", () => {
  before(async () => {
    await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("adds the five backward-compatible users columns with the locked null/default contract", async () => {
    const rows = await prisma.$queryRaw`
      SELECT
        column_name,
        data_type,
        is_nullable,
        column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'users'
        AND column_name IN (
          'first_name',
          'last_name',
          'discoverable_name_search',
          'name_setup_onboarding_required',
          'name_setup_completed_at'
        )
      ORDER BY column_name
    `;

    const byName = Object.fromEntries(rows.map((row) => [row.column_name, row]));
    assert.deepEqual(Object.keys(byName).sort(), [
      "discoverable_name_search",
      "first_name",
      "last_name",
      "name_setup_completed_at",
      "name_setup_onboarding_required",
    ]);
    for (const name of [
      "first_name",
      "last_name",
      "discoverable_name_search",
      "name_setup_completed_at",
    ]) {
      assert.equal(byName[name].is_nullable, "YES", `${name} stays nullable`);
    }
    assert.equal(byName.name_setup_onboarding_required.data_type, "boolean");
    assert.equal(byName.name_setup_onboarding_required.is_nullable, "NO");
    assert.match(
      byName.name_setup_onboarding_required.column_default || "",
      /false/i
    );
  });

  it("adds canonical suppression and fixed-window quota tables with cascade ownership", async () => {
    const columns = await prisma.$queryRaw`
      SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN (
          'friendship_auto_link_suppressions',
          'friend_search_rate_windows'
        )
      ORDER BY table_name, ordinal_position
    `;
    const names = columns.map((row) => `${row.table_name}.${row.column_name}`);
    assert.deepEqual(names, [
      "friend_search_rate_windows.user_id",
      "friend_search_rate_windows.window_start",
      "friend_search_rate_windows.count",
      "friendship_auto_link_suppressions.user_a_id",
      "friendship_auto_link_suppressions.user_b_id",
      "friendship_auto_link_suppressions.reason",
      "friendship_auto_link_suppressions.created_at",
    ]);

    const constraints = await prisma.$queryRaw`
      SELECT
        tc.table_name,
        tc.constraint_type,
        pg_get_constraintdef(pc.oid) AS definition
      FROM information_schema.table_constraints tc
      JOIN pg_constraint pc ON pc.conname = tc.constraint_name
      JOIN pg_namespace pn ON pn.oid = pc.connamespace
      WHERE tc.table_schema = 'public'
        AND pn.nspname = 'public'
        AND tc.table_name IN (
          'friendship_auto_link_suppressions',
          'friend_search_rate_windows'
        )
      ORDER BY tc.table_name, tc.constraint_type, tc.constraint_name
    `;
    const rendered = constraints
      .map((row) => `${row.table_name} ${row.constraint_type} ${row.definition}`)
      .join("\n");
    assert.match(
      rendered,
      /friendship_auto_link_suppressions PRIMARY KEY .*user_a_id.*user_b_id/is
    );
    assert.match(rendered, /CHECK \(\(user_a_id < user_b_id\)\)/i);
    assert.match(rendered, /friend_search_rate_windows PRIMARY KEY .*user_id/is);
    assert.equal((rendered.match(/ON DELETE CASCADE/gi) || []).length, 3);
  });

  it("pins the migration backfill before automatic linking can be enabled", () => {
    assert.equal(fs.existsSync(MIGRATION_PATH), true, "locked migration is missing");
    const sql = fs.readFileSync(MIGRATION_PATH, "utf8");
    assert.match(sql, /CREATE TABLE\s+"friendship_auto_link_suppressions"/i);
    assert.match(
      sql,
      /INSERT INTO\s+"friendship_auto_link_suppressions"[\s\S]*FROM\s+"friendships"[\s\S]*status\s*=\s*'DECLINED'/i
    );
    assert.match(sql, /CHECK\s*\(\s*user_a_id\s*<\s*user_b_id\s*\)/i);
    assert.match(sql, /^\s*BEGIN\s*;/i, "schema and backfill must be atomic");
    assert.match(sql, /COMMIT\s*;\s*$/i, "schema and backfill must be atomic");
    assert.doesNotMatch(sql, /CREATE\s+EXTENSION/i);
    assert.doesNotMatch(sql, /CREATE\s+INDEX\s+CONCURRENTLY/i);
  });

  it("moves extension and concurrent indexes to an idempotent runbook with verification and recovery", () => {
    assert.equal(fs.existsSync(SEARCH_INDEX_RUNBOOK_PATH), true);
    assert.equal(fs.existsSync(SEARCH_INDEX_SQL_PATH), true);
    const sql = fs.readFileSync(SEARCH_INDEX_SQL_PATH, "utf8");
    assert.match(sql, /CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+pg_trgm/i);
    assert.equal((sql.match(/CREATE\s+INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS/gi) || []).length, 2);
    assert.match(sql, /users_display_name_search_trgm_idx/i);
    assert.match(sql, /users_discoverable_name_search_trgm_idx/i);

    const runbook = fs.readFileSync(SEARCH_INDEX_RUNBOOK_PATH, "utf8");
    assert.match(runbook, /verify/i);
    assert.match(runbook, /pg_extension/i);
    assert.match(runbook, /pg_indexes/i);
    assert.match(runbook, /indisvalid/i);
    assert.match(runbook, /EXPLAIN\s*\(ANALYZE,\s*BUFFERS\)/i);
    assert.match(runbook, /recover/i);
    assert.match(runbook, /DROP\s+INDEX\s+CONCURRENTLY\s+IF\s+EXISTS/i);
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8")
    );
    assert.match(
      packageJson.scripts["test:integration"] || "",
      /identity-search-indexes:apply/
    );
  });

  it("installs pg_trgm and the two exact partial GIN search indexes", async () => {
    const extension = await prisma.$queryRaw`
      SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'
    `;
    assert.equal(extension.length, 1);

    const indexes = await prisma.$queryRaw`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'users_display_name_search_trgm_idx',
          'users_discoverable_name_search_trgm_idx'
        )
      ORDER BY indexname
    `;
    assert.deepEqual(
      indexes.map((row) => row.indexname),
      [
        "users_discoverable_name_search_trgm_idx",
        "users_display_name_search_trgm_idx",
      ]
    );
    const defs = indexes.map((row) => row.indexdef).join("\n");
    assert.match(defs, /USING gin \(lower\(display_name\) gin_trgm_ops\)/i);
    assert.match(defs, /USING gin \(discoverable_name_search gin_trgm_ops\)/i);
    assert.match(defs, /is_review_account\s*=\s*false/i);
    assert.match(defs, /name_setup_completed_at IS NOT NULL/i);
  });

  it("uses both trigram indexes for the production search predicates", async () => {
    await prisma.$executeRawUnsafe(`
      INSERT INTO users (
        id,
        apple_id,
        display_name,
        is_review_account,
        first_name,
        discoverable_name_search,
        name_setup_completed_at
      )
      SELECT
        gen_random_uuid(),
        'explain-user-' || n,
        CASE
          WHEN n % 50 = 0 THEN 'Runner' || n || 'Nathan'
          ELSE 'Runner' || n || 'Zed'
        END,
        false,
        'Nathan',
        CASE
          WHEN n % 50 = 0 THEN 'nathan runner ' || n
          ELSE 'zed runner ' || n
        END,
        now()
      FROM generate_series(1, 2500) AS n
    `);
    // Flush GIN's fast-update pending list before asking the planner to price
    // the production predicates. Without this, a just-bulk-loaded test table
    // is unlike a steady-state users table and PostgreSQL may rationally scan
    // the unrelated unique display-name B-tree solely to avoid the pending
    // list, making this an insertion-state test instead of an index proof.
    await prisma.$executeRawUnsafe("VACUUM (ANALYZE) users");

    const plans = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      const handle = await tx.$queryRawUnsafe(`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
        SELECT id
        FROM users
        WHERE is_review_account = false
          AND display_name IS NOT NULL
          AND lower(display_name) LIKE '%nathan%'
        LIMIT 20
      `);
      const discoverable = await tx.$queryRawUnsafe(`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
        SELECT id
        FROM users
        WHERE is_review_account = false
          AND name_setup_completed_at IS NOT NULL
          AND discoverable_name_search IS NOT NULL
          AND discoverable_name_search LIKE '%nathan%'
        LIMIT 20
      `);
      return { handle, discoverable };
    });

    const render = (rows) => rows.map((row) => Object.values(row)[0]).join("\n");
    assert.match(render(plans.handle), /users_display_name_search_trgm_idx/i);
    assert.match(
      render(plans.discoverable),
      /users_discoverable_name_search_trgm_idx/i
    );
  });
});
