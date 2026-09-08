const assert = require('node:assert/strict');
const { it, after } = require('node:test');
const { fork, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const path = require('node:path');
const u = new URL(process.env.DATABASE_URL);
assert.equal(u.hostname, 'localhost'); assert.equal(u.pathname, '/steps_powerup_queue_unit_test');
const { prisma, cleanDatabase, startServer, createTestUser, request } = require('./setup');
const { installQueueSchema, createPowerupCommandQueue } = require('../../scripts/experiments/powerup-command-comparison/queue');
const HEADERS = { 'X-Client-Features': 'powerups2,powerups3,powerups4,powerups5,resolved_impact_events_v2', 'X-Timezone': 'UTC' };
const referenceRoot = process.env.POWERUP_REFERENCE_ROOT;
assert.ok(referenceRoot, 'POWERUP_REFERENCE_ROOT must identify unchanged 3b241ff checkout');
assert.equal(execFileSync('git', ['rev-parse','--short=7','HEAD'], { cwd: referenceRoot, encoding: 'utf8' }).trim(), '3b241ff');
after(async () => prisma.$disconnect());
async function clear() {
  await prisma.$executeRawUnsafe('TRUNCATE experiment_powerup_commands,experiment_powerup_inboxes,experiment_powerup_admissions');
  await cleanDatabase();
}
async function seed() {
  const players = [];
  for (const displayName of ['Replay Alpha','Replay Bravo','Replay Charlie']) players.push(await createTestUser({ displayName }));
  const race = await prisma.race.create({ data: { creatorId: players[0].user.id, name: 'Ordered HTTP replay', status: 'ACTIVE', timeBased: true, maxDurationDays: 7, targetSteps: 1000000, powerupsEnabled: true, startedAt: new Date(Date.now()-3600000), endsAt: new Date(Date.now()+86400000), timezone:'UTC' } });
  for (const [index,p] of players.entries()) p.participant = await prisma.raceParticipant.create({ data: { raceId:race.id,userId:p.user.id,status:'ACCEPTED',totalSteps:15000-index*5000,bonusSteps:15000-index*5000,nextBoxAtSteps:900000,joinedAt:new Date(Date.now()-(3-index)*60000) } });
  const plan = [
    [1,'COMPRESSION_SOCKS'], [0,'SHORTCUT',1], [0,'SHORTCUT',1], [1,'MIRROR'], [0,'SHORTCUT',1],
    [1,'DECOY'], [0,'SHORTCUT',1], [2,'POWER_OUTAGE'], [0,'SHORTCUT',1], [0,'CLEANSE'], [0,'SHORTCUT',1],
    [2,'PROTEIN_SHAKE'], [2,'TRAIL_MIX'], [1,'QUICK_RINSE'], [2,'DEFENSE_SCAN'],
  ];
  const commands = [];
  for (const [index,[owner,type,target]] of plan.entries()) {
    const p = players[owner];
    const item = await prisma.racePowerup.create({ data: {raceId:race.id,participantId:p.participant.id,userId:p.user.id,type,rarity:'RARE',status:'HELD',earnedAtSteps:index+1} });
    commands.push({ player:p,item,body:target == null ? {} : {targetUserId:players[target].user.id} });
  }
  const tables = ['users','races','race_participants','race_powerups']; const snapshot = {};
  for (const table of tables) snapshot[table] = (await prisma.$queryRawUnsafe(`SELECT to_jsonb(t) AS row FROM ${table} t`)).map(r => r.row);
  return {players,race,commands,tables,snapshot};
}
async function restore(f) {
  await clear();
  for (const table of f.tables) await prisma.$executeRawUnsafe(`INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table},$1::jsonb)`,JSON.stringify(f.snapshot[table]));
}
function normalize(value, labels, key='') {
  if (Array.isArray(value)) return value.map(v=>normalize(v,labels,key));
  if (value && typeof value==='object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,normalize(v,labels,k)]));
  if (typeof value==='string') {
    if (labels.has(value)) return labels.get(value);
    if (/^\d{4}-\d\d-\d\dT/.test(value)) return '<timestamp>';
    if (/^[\da-f]{8}-[\da-f-]{27}$/i.test(value)) return '<generated-id>';
    for (const [id,label] of labels) value=value.replaceAll(id,label);
    return value.replace(/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/gi,'<generated-id>');
  }
  // Millisecond-remaining values legitimately age between independent replay
  // processes; effect durations are separately compared to a second below.
  if (typeof value==='number' && /remainingMs/.test(key)) return Math.round(value/1000);
  return value;
}
async function state(f) {
  const effects = await prisma.raceActiveEffect.findMany({where:{raceId:f.race.id},orderBy:[{powerupId:'asc'},{type:'asc'},{targetUserId:'asc'}]});
  return {
    items: await prisma.racePowerup.findMany({where:{raceId:f.race.id},orderBy:{id:'asc'},select:{id:true,type:true,status:true,userId:true}}),
    participants: await prisma.raceParticipant.findMany({where:{raceId:f.race.id},orderBy:{userId:'asc'},select:{userId:true,bonusSteps:true,totalSteps:true}}),
    effects: effects.map(e=>({powerupId:e.powerupId,type:e.type,status:e.status,sourceUserId:e.sourceUserId,targetUserId:e.targetUserId,metadata:e.metadata,durationSeconds:e.expiresAt?Math.round((e.expiresAt-e.startsAt)/1000):null})),
    events: await prisma.racePowerupEvent.findMany({where:{raceId:f.race.id},orderBy:[{powerupType:'asc'},{actorUserId:'asc'},{description:'asc'}],select:{actorUserId:true,targetUserId:true,eventType:true,powerupType:true,description:true,metadata:true}}),
  };
}
for (const mode of ['SINGLE','BATCH']) it(`${mode} actual committed order replays through unchanged release HTTP`, async () => {
  await installQueueSchema(); await clear(); const f=await seed();
  const labels=new Map([[f.race.id,'race']]);
  f.players.forEach((p,i)=>{labels.set(p.user.id,`player${i}`);labels.set(p.participant.id,`participant${i}`);});
  f.commands.forEach((c,i)=>labels.set(c.item.id,`command${i}:${c.item.type}`));
  const q=createPowerupCommandQueue({mode,batchSize:mode==='BATCH'?4:1});
  const server=await startServer({usePowerup:args=>q.execute(args)});
  const responses=new Map(); let child;
  try {
    // Deliberately sequence admission, then execute an ordered chain. Unlike
    // throughput tests this semantic replay controls all state/time boundaries.
    for(const command of f.commands){
      const pending=request(server.baseUrl,'POST',`/races/${f.race.id}/powerups/${command.item.id}/use`,{token:command.player.token,headers:HEADERS,body:command.body});
      for(let n=0;n<200;n++) {const [r]=await prisma.$queryRawUnsafe('SELECT id FROM experiment_powerup_commands WHERE powerup_id=$1',command.item.id);if(r)break;await delay(5);}
      for(let n=0;n<4;n++)await q.tick(); const response=await pending;
      assert.ok(response.status<500,`${command.item.type}: ${q.metrics.lastError}`);
      responses.set(command.item.id,{status:response.status,body:await response.json()});
    }
    const actualOrder=await prisma.$queryRawUnsafe('SELECT powerup_id,sequence,random_draws FROM experiment_powerup_commands ORDER BY sequence');
    const expected=normalize(await state(f),labels);
    await server.close(); await restore(f);
    child=fork(path.resolve(__dirname,'../../scripts/experiments/powerup-command-comparison/queueReferenceServer.js'),[referenceRoot],{env:process.env,stdio:['ignore','ignore','ignore','ipc']});
    const ready=once(child,'message'); child.send({type:'start',drawsByItem:Object.fromEntries(actualOrder.map(r=>[r.powerup_id,r.random_draws]))});
    const [{baseUrl}]=await ready;
    for(const row of actualOrder){
      const command=f.commands.find(c=>c.item.id===row.powerup_id);
      const response=await request(baseUrl,'POST',`/races/${f.race.id}/powerups/${command.item.id}/use`,{token:command.player.token,headers:HEADERS,body:command.body});
      assert.deepEqual(normalize({status:response.status,body:await response.json()},labels),normalize(responses.get(row.powerup_id),labels),`${mode} command ${row.sequence}: ${command.item.type}`);
    }
    assert.deepEqual(normalize(await state(f),labels),expected,`${mode} persisted outcome parity`);
    console.log('QUEUE_REFERENCE_REPLAY',JSON.stringify({mode,commands:actualOrder.length,randomizedCommands:actualOrder.filter(r=>r.random_draws.length).length}));
  } finally { child?.kill('SIGKILL'); await server.close().catch(()=>{}); }
});
