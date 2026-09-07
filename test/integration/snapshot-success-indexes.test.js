const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Client } = require('pg');

// Index validity and access paths cannot be asserted through an HTTP response.
// Use real PostgreSQL, isolated temporary tables, and no application internals.
const specs = [
  ['race_resolution_post_tasks', 'race_post_snapshot_success_lookup_idx'],
  ['race_resolution_post_task_receipts', 'race_post_receipt_success_lookup_idx'],
];

test('snapshot success indexes are valid, selective, and eliminate failed-history scans', async () => {
  const url = new URL(process.env.DATABASE_URL);
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(url.hostname));
  assert.match(url.pathname, /_test$/);
  const db = new Client({ connectionString: url.toString() });
  await db.connect();
  try {
    const identity = await db.query('SELECT current_database() AS name');
    assert.ok(identity.rows[0].name.endsWith('_test'));
    const definitions = [];
    for (const [table, index] of specs) {
      const { rows } = await db.query(`SELECT i.indisvalid,i.indisready,i.indisunique,
        pg_get_indexdef(i.indexrelid) AS definition,
        pg_get_expr(i.indpred,i.indrelid) AS predicate,
        ARRAY(SELECT pg_get_indexdef(i.indexrelid,n,true)
          FROM generate_series(1,i.indnkeyatts) n) AS keys
        FROM pg_index i WHERE i.indexrelid=to_regclass($1)
          AND i.indrelid=to_regclass($2)`, [`public.${index}`, `public.${table}`]);
      assert.equal(rows.length, 1, `${index} must exist on ${table}`);
      const row = rows[0];
      assert.ok(row.indisvalid && row.indisready, `${index} must be usable`);
      assert.equal(row.indisunique, false);
      assert.deepEqual(row.keys, ['race_id', 'source_generation']);
      assert.match(row.predicate, /snapshot_state.*= 'succeeded'/);
      definitions.push(row.definition);
    }
    await db.query('BEGIN');
    await db.query("SET LOCAL statement_timeout='30s'");
    for (const [table] of specs) {
      await db.query(`CREATE TEMP TABLE ${table} ON COMMIT DROP AS
        SELECT race_id,source_generation,snapshot_state FROM public.${table} WITH NO DATA`);
      await db.query(`CREATE INDEX ON ${table}(race_id,source_generation)`);
      await db.query(`INSERT INTO ${table} SELECT 'history',g,'failed_no_retry'
        FROM generate_series(1,30000) g`);
      await db.query(`INSERT INTO ${table} VALUES ('history',0,'succeeded'),
        ('pending',10,'pending'),('ambiguous',10,'ambiguous_at_most_once'),
        ('skipped',10,'skipped_superseded')`);
      await db.query(`ANALYZE ${table}`);
    }
    await db.query("INSERT INTO race_resolution_post_tasks VALUES ('live',10,'succeeded')");
    await db.query("INSERT INTO race_resolution_post_task_receipts VALUES ('receipt',10,'succeeded')");
    const sql = `SELECT 1 FROM race_resolution_post_tasks
      WHERE race_id=$1 AND source_generation >= $2 AND snapshot_state='succeeded'
      UNION ALL SELECT 1 FROM race_resolution_post_task_receipts
      WHERE race_id=$1 AND source_generation >= $2 AND snapshot_state='succeeded' LIMIT 1`;
    const cases = [['history',1,false],['history',0,true],['live',9,true],
      ['live',10,true],['live',11,false],['receipt',9,true],['receipt',10,true],
      ['receipt',11,false],['pending',1,false],['ambiguous',1,false],
      ['skipped',1,false],['missing',0,false]];
    const check = async () => {
      for (const [race, gen, found] of cases)
        assert.equal((await db.query(sql,[race,gen])).rowCount > 0,found,`${race}/${gen}`);
    };
    await check();
    const explain = async () => (await db.query(
      `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON,TIMING OFF) ${sql}`,['history',1]
    )).rows[0]['QUERY PLAN'][0];
    const before = await explain();
    for (let n=0;n<specs.length;n++) {
      // Copy the actual deployed index definition onto the shadow temp table.
      await db.query(definitions[n].replace(`public.${specs[n][0]}`,specs[n][0]));
      await db.query(`ANALYZE ${specs[n][0]}`);
    }
    await check();
    const after = await explain();
    const blocks = p => (p.Plan['Local Hit Blocks']||0)+(p.Plan['Local Read Blocks']||0);
    assert.ok(blocks(before)>100, 'fixture must exercise substantial failed history');
    assert.ok(blocks(after)<blocks(before)/10, 'success indexes must reduce buffer work by >90%');
    const plan = JSON.stringify(after.Plan);
    for (const [,index] of specs) assert.ok(plan.includes(index), `${index} must serve the lookup`);
    console.log(JSON.stringify({beforeBlocks:blocks(before),afterBlocks:blocks(after),
      beforeMs:before['Execution Time'],afterMs:after['Execution Time']}));
    await db.query('ROLLBACK');
  } finally {
    await db.end();
  }
});
