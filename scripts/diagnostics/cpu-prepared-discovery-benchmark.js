const assert=require('node:assert/strict'),fs=require('node:fs');
const {randomUUID}=require('node:crypto');const {performance}=require('node:perf_hooks');
const {Pool,Client}=require('pg');const {installPreparedReadQueries}=require('../../src/shared/database/preparedReadQueries');
const target=new URL(process.env.DATABASE_URL);assert.ok(['127.0.0.1','localhost'].includes(target.hostname)&&target.pathname.endsWith('_test'));
const input=fs.readFileSync(process.argv[2],'utf8').trim().split('\n').map(JSON.parse);
const selected=[...new Map(input.filter(q=>['race-discovery','tournament-discovery','viewer-overlay'].includes(q.family)&&!q.query.startsWith('EXPLAIN')&&(q.family!=='race-discovery'||q.query.includes('-- Count eligible races'))).map(q=>[q.family+q.query,q])).values()];
const {prisma}=require('../../src/db');const output=[];
const pct=(xs,p)=>[...xs].sort((a,b)=>a-b)[Math.ceil(xs.length*p)-1];
(async()=>{
 const users=Array.from({length:33},()=>randomUUID()),races=Array.from({length:100},()=>randomUUID()),tournaments=Array.from({length:100},()=>randomUUID());
 await prisma.user.createMany({data:users.map(id=>({id,appleId:id}))});
 await prisma.race.createMany({data:races.map((id,i)=>({id,creatorId:users[1],name:`Plan ${i}`,status:'PENDING',targetSteps:1000000,isPublic:true,maxParticipants:33,createdAt:new Date(Date.UTC(2026,0,1,0,i))}))});
 await prisma.tournament.createMany({data:tournaments.map((id,i)=>({id,creatorId:users[1],name:`Plan ${i}`,status:'PENDING',isPublic:true,bracketSize:16,matchupDurationDays:1,totalRounds:4,createdAt:new Date(Date.UTC(2026,0,1,0,i))}))});
 await prisma.raceParticipant.createMany({data:races.flatMap(raceId=>users.slice(1).map(userId=>({raceId,userId,status:'ACCEPTED'})))});
 await prisma.tournamentParticipant.createMany({data:tournaments.flatMap(tournamentId=>users.slice(1,9).map(userId=>({tournamentId,userId,status:'ACCEPTED'})))});
 try{
  for(const q of selected)for(const density of ['empty','sparse','dense'])for(let repetition=0;repetition<3;repetition++){
   const au=new URL(target);au.pathname='/pgbouncer';const admin=new Client({connectionString:au.toString()});await admin.connect();await admin.query(`RECONNECT ${target.pathname.slice(1)}`);await admin.end();
   const pool=new Pool({connectionString:target.toString(),max:1,options:'-c timezone=UTC'});installPreparedReadQueries(pool);const db=await pool.connect();
   try{
    await db.query('BEGIN');await db.query("SET LOCAL statement_timeout='10s'");
    const eligible=density==='empty'?0:density==='sparse'?1:100;
    await db.query('UPDATE races SET is_public=(id=ANY($1::text[])) WHERE id=ANY($2::text[])',[races.slice(0,eligible),races]);
    await db.query('UPDATE tournaments SET is_public=(id=ANY($1::text[])) WHERE id=ANY($2::text[])',[tournaments.slice(0,eligible),tournaments]);
    for(const table of ['races','race_participants','tournaments','tournament_participants'])await db.query(`ANALYZE ${table}`);
    let sql=q.query.replace(/^\/\* steps:prepared-read:v1 \*\//,''),candidate='/* steps:prepared-read:v1 */'+sql;
    let values=q.values.map(value=>typeof value==='string'?users[0]:value),candidateValues=values;
    if(q.family==='viewer-overlay'){
     const ids=eligible?races.slice(0,eligible):[randomUUID()];
     // Mirror the current variable IN-list text at the same response-list size.
     sql=sql.replace(/WHERE r.id IN \([^)]*\)/,`WHERE r.id IN (${ids.map((_,i)=>'$'+(i+3)).join(',')})`);
     values=[users[0],users[0],...ids];
     candidate='/* steps:prepared-read:v1 */'+q.query.replaceAll('$2','$1').replace(/WHERE r.id IN \([^)]*\)/,'WHERE r.id = ANY($2::text[])');
     candidateValues=[users[0],ids];
    }
    const times={baseline:[],prepared:[]};
    for(let i=0;i<110;i++){
     const result={};
     for(const kind of i%2?['prepared','baseline']:['baseline','prepared']){
      const start=performance.now();result[kind]=(await db.query({text:kind==='prepared'?candidate:sql,values:kind==='prepared'?candidateValues:values})).rows;
      if(i>=10)times[kind].push(performance.now()-start);
     }
     // Overlay results have no SQL ORDER BY; application maps them by ID.
     if(q.family==='viewer-overlay')for(const rows of Object.values(result))rows.sort((a,b)=>a.id.localeCompare(b.id));
     assert.deepEqual(result.prepared,result.baseline);
    }
    const plans=(await db.query('SELECT generic_plans::int,custom_plans::int FROM pg_prepared_statements WHERE statement=$1',[candidate])).rows[0];assert.ok(plans);
    const explain=async(text,values)=>(await db.query({text:'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+text,values})).rows[0]['QUERY PLAN'][0];
    const before=await explain(sql,values),after=await explain(candidate,candidateValues);
    const row={family:q.family,variantBytes:sql.length,density,repetition,...plans,baselineMedianMs:pct(times.baseline,.5),preparedMedianMs:pct(times.prepared,.5),baselineP95Ms:pct(times.baseline,.95),preparedP95Ms:pct(times.prepared,.95),baselineBuffers:(before.Plan['Shared Hit Blocks']||0)+(before.Plan['Shared Read Blocks']||0),candidateBuffers:(after.Plan['Shared Hit Blocks']||0)+(after.Plan['Shared Read Blocks']||0)};output.push(row);console.log(JSON.stringify(row));
   }finally{await db.query('ROLLBACK');db.release();await pool.end();}
  }
 }finally{await prisma.tournamentParticipant.deleteMany({where:{tournamentId:{in:tournaments}}});await prisma.tournament.deleteMany({where:{id:{in:tournaments}}});await prisma.race.deleteMany({where:{id:{in:races}}});await prisma.user.deleteMany({where:{id:{in:users}}});}
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await prisma.$disconnect();fs.writeFileSync(process.argv[3],JSON.stringify(output,null,2));}).then(()=>process.exit(process.exitCode||0));
