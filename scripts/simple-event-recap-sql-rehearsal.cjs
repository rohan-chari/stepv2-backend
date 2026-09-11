// Migration/administrative gates are not expressible through HTTP. Runtime
// behavior and actual account deletion are covered by HTTP integration tests.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const target = new URL(process.env.DATABASE_URL);
assert.equal(target.hostname, '127.0.0.1');
assert.equal(target.pathname, '/bara_recap_sql_test');
assert.equal(process.env.NODE_ENV, 'test');
const results = [];
let retainedLegacyId;
const root = path.resolve(__dirname, '..');
async function connection(fn) {
  const db = new Client({connectionString: target.toString()});
  await db.connect(); try { return await fn(db); } finally { await db.end(); }
}
function run(file, expectedError) {
  let output;
  try { output = execFileSync('psql', [target.toString(), '--set=ON_ERROR_STOP=1', '--file='+path.join(root,file)], {encoding:'utf8',stdio:['ignore','pipe','pipe']}); }
  catch (error) {
    const details = String(error.stderr);
    if (!expectedError || !details.includes(expectedError)) throw error;
    results.push({file,expectedRejection:expectedError}); return;
  }
  assert.ok(!expectedError, 'expected rejection: '+expectedError);
  results.push({file,passed:true}); return output;
}
async function main() {
  // Input: a disposable clone of the populated unchanged synthetic benchmark.
  run('scripts/simple-event-recap-verify.sql', 'retired recap trigger remains installed');
  await connection(async db=>{
    const {rows}=await db.query('SELECT id FROM global_event_user_summaries ORDER BY id LIMIT 4');
    assert.equal(rows.length,4,'requires populated synthetic baseline');
    retainedLegacyId=rows[0].id;
    await db.query('UPDATE global_event_user_summaries SET extra_race_steps=0 WHERE id=$1',[rows[0].id]);
    // Entitlement retention can precede the recap's midnight expiry cutoff by
    // almost one day. B must not strand this already-expired orphan forever.
    await db.query(`UPDATE global_event_user_summaries SET expires_at=now()-INTERVAL '29 days 12 hours' WHERE id=$1`,[retainedLegacyId]);
    await db.query(`UPDATE global_step_event_entitlements e SET starts_at=now()-INTERVAL '30 days 2 hours',
      ends_at=now()-INTERVAL '30 days 1 hour',start_processed_at=now(),end_processed_at=now()
      FROM global_event_user_summaries recap WHERE recap.id=$1
        AND e.event_id=recap.event_id AND e.user_id=recap.user_id`,[retainedLegacyId]);
    await db.query(`DELETE FROM global_event_race_impacts impact USING global_event_user_summaries recap
      WHERE recap.id=$1 AND impact.event_id=recap.event_id AND impact.user_id=recap.user_id`,[retainedLegacyId]);
    await db.query('UPDATE global_event_user_summaries SET extra_race_steps=-99 WHERE id=$1',[rows[1].id]);
    await db.query('UPDATE global_event_user_summaries SET expires_at=NULL WHERE id=$1',[rows[2].id]);
    await db.query('UPDATE global_event_user_summaries SET attribution_version=1 WHERE id=$1',[rows[3].id]);
  });
  run('prisma/migrations/20260911120000_simple_event_recap_expand/migration.sql');
  await connection(async db=>{
    await assert.rejects(db.query(`UPDATE global_step_event_entitlements SET
      recap_race_count=3,recap_count_policy_version=NULL,recap_window_revision=1
      WHERE id=(SELECT id FROM global_step_event_entitlements LIMIT 1)`),
      error=>error.code==='23514');
    results.push({stampConstraint:'partially populated count/revision with null policy rejected'});
  });
  await connection(async()=>run('scripts/simple-event-recap-cutover.sql','stop and drain ALL database clients'));
  run('scripts/simple-event-recap-cutover.sql');
  run('scripts/simple-event-recap-cutover.sql');
  await connection(async db=>{
    const {rows:[r]}=await db.query(`SELECT count(*) AS n,count(*) FILTER(WHERE suppressed) AS suppressed
      FROM event_recaps`);
    assert.equal(+r.n,6);assert.equal(+r.suppressed,4);
    const {rows:[m]}=await db.query(`SELECT count(*) AS mismatches FROM global_event_user_summaries old
      JOIN event_recaps new USING(id) WHERE (old.extra_race_steps,old.race_count,old.expires_at,old.acknowledged_at)
      IS DISTINCT FROM (new.extra_race_steps,new.race_count,new.expires_at,new.acknowledged_at)`);
    assert.equal(+m.mismatches,0);
    results.push({copy:'all six IDs/numbers/expiry/ack preserved; four ineligible suppressed; rerun safe'});
    const counts=async()=> (await db.query(`SELECT
      (SELECT count(*) FROM durable_capture_fact_journal) AS journal,
      (SELECT sum(revision) FROM durable_capture_fact_heads) AS revisions,
      (SELECT count(*) FROM global_event_summary_work) AS work`)).rows[0];
    const before=await counts();
    await db.query('BEGIN');
    await db.query('UPDATE steps SET steps=steps+1');
    await db.query('UPDATE step_samples SET steps=steps+1');
    await db.query(`INSERT INTO steps(id,user_id,steps,date,created_at,step_goal)
      SELECT gen_random_uuid()::text,user_id,1,date-INTERVAL '7 days',now(),step_goal FROM steps LIMIT 1`);
    await db.query(`INSERT INTO step_samples(id,user_id,period_start,period_end,steps,created_at)
      SELECT gen_random_uuid()::text,user_id,period_start-INTERVAL '7 days',period_end-INTERVAL '7 days',1,now() FROM step_samples LIMIT 1`);
    await db.query('DELETE FROM steps WHERE id=(SELECT id FROM steps ORDER BY date LIMIT 1)');
    await db.query('DELETE FROM step_samples WHERE id=(SELECT id FROM step_samples ORDER BY period_start LIMIT 1)');
    assert.deepEqual(await counts(),before);
    await db.query('ROLLBACK');
    results.push({sourceMutations:'INSERT/UPDATE/DELETE both raw source tables: zero capture journal/revision/work changes'});
    await db.query(`UPDATE global_step_event_entitlements SET ends_at=(now() AT TIME ZONE 'UTC')+INTERVAL '2 hours',
      schedule_revision=schedule_revision+1 WHERE id=(SELECT e.id FROM global_step_event_entitlements e
        WHERE NOT EXISTS(SELECT 1 FROM event_recaps recap WHERE recap.id=$1
          AND recap.event_id=e.event_id AND recap.user_id=e.user_id) LIMIT 1)`,[retainedLegacyId]);
    const {rows: kinds}=await db.query('SELECT DISTINCT kind FROM global_event_recovery_candidates');
    assert.deepEqual(kinds.map(r=>r.kind),['ENTITLEMENT_EVENT']);
    await db.query(`SELECT global_event_recovery_seed_page(10),
      global_event_recovery_revalidate_page('ENTITLEMENT_EVENT',now()::timestamp,10)`);
    results.push({notificationRecovery:'entitlement change + bounded seed/revalidation intact; no summary candidates'});
    const {rows: owners}=await db.query('SELECT id,live_request_id FROM durable_capture_score_owners WHERE live_request_id IS NOT NULL ORDER BY id LIMIT 2');
    assert.equal(owners.length,2); const owner=owners[0];
    await db.query(`INSERT INTO durable_capture_score_plans(request_id,race_id,plan_key,metadata,metadata_digest,point_count)
      VALUES($1,'synthetic-race','synthetic-plan','{}','test-only',1000)`,[owner.id]);
    await db.query(`INSERT INTO durable_capture_score_points(request_id,race_id,plan_key,position,time_ms,payload,payload_digest)
      SELECT $1,'synthetic-race','synthetic-plan',i,i,'{}','test-only' FROM generate_series(1,1000)i`,[owner.id]);
    await db.query(`INSERT INTO durable_capture_score_progress(request_id,race_id,state,state_digest)
      VALUES($1,'synthetic-race','{}','test-only')`,[owner.id]);
    await db.query(`INSERT INTO durable_capture_score_transfers(request_id,race_id,effect_id,starts_ms,payload,payload_digest)
      VALUES($1,'synthetic-race','synthetic-effect',0,'{}','test-only')`,[owner.id]);
    const began=performance.now();
    await db.query('DELETE FROM durable_global_event_capture_requests WHERE id=$1',[owner.live_request_id]);
    const elapsedMs=performance.now()-began;
    for(const table of ['durable_capture_score_owners','durable_capture_score_plans','durable_capture_score_points','durable_capture_score_progress','durable_capture_score_transfers']) {
      const column=table==='durable_capture_score_owners'?'id':'request_id';
      assert.equal((await db.query(`SELECT count(*) AS n FROM ${table} WHERE ${column}=$1`,[owner.id])).rows[0].n,'0');
    }
    assert.equal((await db.query('SELECT count(*) AS n FROM durable_capture_score_owners WHERE id=$1',[owners[1].id])).rows[0].n,'1');
    results.push({retainedDescendantDeletion:'1000 points + plan/progress/transfer/owner deleted; unrelated owner preserved',elapsedMs});
  });
  // Exercise real replacement retention between A and B: source evidence must
  // survive even after its entitlement is legitimately retired.
  // A separate process guarantees externally-owned adapter pools are drained
  // before B's stopped-client guard (Prisma disconnect alone does not close it).
  execFileSync(process.execPath,['-e',`
    const assert=require('node:assert/strict');
    const {prisma}=require('./src/db');
    const {cleanupExpiredEntitlements}=require('./src/modules/steps/services/globalStepEventRetention');
    (async()=>{
      const retired=await cleanupExpiredEntitlements({client:prisma});
      assert.equal(retired.deletedEntitlements,1);
      assert.ok(await prisma.eventRecap.findUnique({where:{id:${JSON.stringify(retainedLegacyId)}}}));
      assert.equal(await prisma.eventRecap.count(),6);
    })().then(()=>process.exit(0)).catch(error=>{console.error(error);process.exit(1);});
  `],{cwd:root,env:process.env,stdio:['ignore','pipe','pipe'],timeout:30000});
  results.push({retention:'actual replacement retention removed one expired entitlement, preserved all six copied results for B audit'});
  run('scripts/simple-event-recap-final-drop.sql','at least seven days ago');
  await connection(db=>db.query(`UPDATE job_runs SET updated_at=(now() AT TIME ZONE 'UTC')-INTERVAL '8 days'
    WHERE job_name='simple_event_recap:cutover:v1'`)); // Dedicated test fixture only.
  run('scripts/simple-event-recap-final-drop.sql');
  await connection(async db=>{
    const {rows:[r]}=await db.query(`SELECT count(*) AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' AND (c.relname LIKE 'durable_capture_%'
        OR c.relname IN ('global_event_summary_work','global_event_capture_artifacts','global_event_user_summaries','durable_global_event_capture_requests'))`);
    assert.equal(+r.n,0);
    await db.query(`SELECT global_event_recovery_seed_page(10),
      global_event_recovery_revalidate_page('ENTITLEMENT_EVENT',now()::timestamp,10)`);
    assert.equal((await db.query('SELECT count(*) AS n FROM event_recaps')).rows[0].n,'5');
    assert.equal((await db.query('SELECT count(*) AS n FROM event_recaps WHERE id=$1',[retainedLegacyId])).rows[0].n,'0');
    results.push({finalDrop:'all21 retired tables gone; one audited expired orphan copy removed, five unrelated copied recaps and notification recovery retained'});
  });
  run('scripts/simple-event-recap-final-drop.sql');
}
main().then(()=>{const report={success:true,results};if(process.argv[2])fs.writeFileSync(process.argv[2],JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));})
  .catch(error=>{console.error(error);process.exitCode=1;});
