// Disposable PG18-only experiment. No production data, clock or statistics are changed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Client } = require('pg');
const { randomUUID } = require('node:crypto');
const target = new URL(process.env.DATABASE_URL);
assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname) && target.pathname.endsWith('_test'));
const mode = process.argv[2];
assert.ok(['baseline', 'candidate'].includes(mode));
const db = new Client({ connectionString: target.toString() });
const results = [];
(async () => {
  await db.connect();
  assert.match((await db.query('SELECT version() AS v')).rows[0].v, /PostgreSQL 18\./);
  for (const population of [6763, 67630]) for (let repetition = 0; repetition < 3; repetition++) {
    await db.query('BEGIN');
    try {
      await db.query("SET LOCAL statement_timeout='15s'");
      const user = randomUUID();
      await db.query('INSERT INTO users(id,apple_id) VALUES($1,$1)', [user]);
      await db.query(`INSERT INTO durable_capture_fact_roots(user_id,day,revision,last_used_at)
        SELECT $1,date '2000-01-01'+n,0,now()-interval '11 minutes' FROM generate_series(1,$2::int) n`, [user,population]);
      await db.query(`INSERT INTO durable_capture_fact_pins(owner_id,root_id)
        SELECT $1::uuid,id FROM durable_capture_fact_roots WHERE user_id=$2 ORDER BY id LIMIT $3`, [randomUUID(),user,Math.floor(population*.95)]);
      if (process.argv[4]==='superseded-pinned') {
        await db.query(`INSERT INTO durable_capture_fact_heads(user_id,day,revision,compacted_revision)
          SELECT DISTINCT r.user_id,r.day,1,1 FROM durable_capture_fact_roots r
          JOIN durable_capture_fact_pins p ON p.root_id=r.id WHERE r.user_id=$1`,[user]);
        await db.query('UPDATE durable_capture_fact_roots SET prepared_at=now() WHERE user_id=$1',[user]);
        await db.query('ANALYZE durable_capture_fact_heads');
      }
      if (mode === 'candidate') await db.query('DELETE FROM durable_capture_root_sweep');
      await db.query('INSERT INTO durable_capture_compaction_schedule(singleton) VALUES(true) ON CONFLICT DO NOTHING');
      await db.query('ANALYZE durable_capture_fact_roots'); await db.query('ANALYZE durable_capture_fact_pins');
      const before = (await db.query('SELECT id,xmin::text AS version FROM durable_capture_fact_roots WHERE user_id=$1 ORDER BY id',[user])).rows;
      let executionMs=0, buffers=0, walBytes=0, calls=0, maxFunctionExecutionMs=0;
      // One full sweep under identical data. The scheduled candidate repeats it
      // more frequently; the report separately applies the actual cadence.
      for (let page=0;page<Math.ceil(population/128)+1;page++) {
        // Advance only disposable scheduling deadlines; exclude these fixture
        // writes from measured work, as a real scheduler would wait for time.
        await db.query("UPDATE durable_capture_compaction_schedule SET next_due_at=clock_timestamp()-interval '1 second'");
        if (mode==='candidate') await db.query("UPDATE durable_capture_root_sweep SET next_due_at=clock_timestamp()-interval '1 second'");
        const result = (await db.query('EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON) SELECT * FROM durable_capture_compact_if_due(128)')).rows[0]['QUERY PLAN'][0];
        executionMs += result['Execution Time'];
        maxFunctionExecutionMs = Math.max(maxFunctionExecutionMs,result['Execution Time']);
        buffers += (result.Plan['Shared Hit Blocks']||0)+(result.Plan['Shared Read Blocks']||0);
        walBytes += result.Plan['WAL Bytes']||0;
        calls++;
      }
      const after = (await db.query('SELECT id,xmin::text AS version FROM durable_capture_fact_roots WHERE user_id=$1 ORDER BY id',[user])).rows;
      assert.equal(after.length,before.length);
      // xmin is constant inside a transaction: compare original last_used_at instead.
      const changedRoots = +(await db.query("SELECT count(*) AS n FROM durable_capture_fact_roots WHERE user_id=$1 AND last_used_at>now()-interval '10 minutes'",[user])).rows[0].n;
      if(mode==='candidate') assert.equal(changedRoots,0);
      const row = {mode,distribution:process.argv[4]||'current',population,repetition,calls,executionMs,buffers,walBytes,maxFunctionExecutionMs,changedRoots};
      results.push(row);console.log(JSON.stringify(row));
    } finally { await db.query('ROLLBACK'); }
  }
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
  await db.end();if(process.argv[3]) fs.writeFileSync(process.argv[3],JSON.stringify(results,null,2));
});
