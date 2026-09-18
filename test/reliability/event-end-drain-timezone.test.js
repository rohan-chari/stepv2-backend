const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { before, beforeEach, describe, it } = require('node:test');
const { cleanDatabase, createTestUser, getSharedServer, prisma, request, startServer } = require('./setup');
const { scheduleGlobalStepEvents, buildLocalGlobalStepEventTick } = require('../../src/modules/steps/jobs/globalStepEventScheduler');
const { EXPECTED_LOGICAL_OWNERS, GENERATION_CAPABILITIES, heartbeatGeneration } = require('../../src/modules/steps/models/globalStepEventGeneration');
const { buildNotificationScheduleRelease } = require('../../src/modules/notifications/jobs/notificationScheduleRelease');
const { buildDomainEventProjectionJob } = require('../../src/modules/domainEvents/jobs/domainEventProjection');
const { buildGlobalEventEndDrain } = require('../../src/modules/steps/jobs/globalEventEndDrain');
const quiet = { log() {}, error() {} };
async function ready() {
  const now = Date.now();
  for (const offset of [90000, 60000, 30000, 0]) for (const logicalOwnerId of EXPECTED_LOGICAL_OWNERS) {
    await heartbeatGeneration({ client: prisma, now: new Date(now-offset), logicalOwnerId, bootId: `test-${logicalOwnerId}`, capabilities: GENERATION_CAPABILITIES });
  }
}
async function pending(account, options = {}) {
  const day = new Date(Date.now()+3*86400000).toISOString().slice(0,10);
  const startsAt = new Date(`${day}T14:00:00Z`);
  const localHour=Number(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'numeric',hourCycle:'h23'}).format(startsAt));
  startsAt.setUTCHours(startsAt.getUTCHours()+10-localHour);
  const event = await prisma.globalStepEvent.create({data:{ scheduleMode:'LOCAL_ENTITLEMENTS', eventDay:day, localStartMinute:600, durationMinutes:30, multiplier:2, startsAt:new Date(Date.now()-3600000), endsAt:new Date(Date.now()+5*86400000)}});
  const entitlement = await prisma.globalStepEventEntitlement.create({data:{ eventId:event.id,userId:account.user.id,timezone:'America/New_York',localDate:day,startsAt,endsAt:new Date(+startsAt+1800000),...options }});
  await prisma.notificationSchedule.create({data:{recipientUserId:account.user.id,type:'GLOBAL_EVENT_STARTED',title:'2x',body:'Go',payload:{eventId:event.id},deliveryKey:`visible:GLOBAL_EVENT_STARTED:${account.user.id}:${event.id}`,sourceRef:entitlement.id,sourceRevision:0,availableAt:entitlement.startsAt,expiresAt:entitlement.endsAt}});
  return entitlement;
}
describe('bounded event ends and authoritative timezone HTTP contract', () => {
  let server;
  before(async()=>{server=await getSharedServer();});
  beforeEach(async()=>{await cleanDatabase();});
  it('immediately commits authoritative zone and clears legacy candidates with no pending events; return travel and old clients work', async()=>{
    const account=await createTestUser({timezone:'America/New_York',globalEventTimezone:'America/New_York'});
    for(const zone of ['America/Los_Angeles','America/New_York']) {
      const response=await request(server.baseUrl,'GET','/auth/me',{token:account.token,headers:{'x-timezone':zone,'x-client-features':''}});
      assert.equal(response.status,200); assert.ok((await response.json()).user.id);
      const user=await prisma.user.findUniqueOrThrow({where:{id:account.user.id}});
      assert.equal(user.timezone,zone); assert.equal(user.globalEventTimezone,zone); assert.equal(user.globalEventTimezoneCandidate,null); assert.equal(user.globalEventTimezoneCandidateSince,null);
    }
    for(const headers of [{},{'x-timezone':'not/a-zone'},{'x-timezone':'America/New_York'}]) {
      assert.equal((await request(server.baseUrl,'GET','/auth/me',{token:account.token,headers})).status,200);
    }
    assert.equal((await prisma.user.findUniqueOrThrow({where:{id:account.user.id}})).timezone,'America/New_York');
  });
  it('moves a personal future window after worldwide parent start and revises notification atomically before delayed projection/old expiry', async()=>{
    await ready();
    const account=await createTestUser({timezone:'America/New_York',globalEventTimezone:'America/New_York'});
    const old=await pending(account);
    const response=await request(server.baseUrl,'GET','/auth/me',{token:account.token,headers:{'x-timezone':'America/Los_Angeles'}});
    assert.equal(response.status,200);
    const moved=await prisma.globalStepEventEntitlement.findUniqueOrThrow({where:{id:old.id}});
    assert.equal(moved.timezone,'America/Los_Angeles'); assert.equal(+moved.startsAt,+old.startsAt+3*3600000);
    const schedule=await prisma.notificationSchedule.findFirstOrThrow({where:{sourceRef:old.id}});
    assert.equal(schedule.sourceRevision,1);assert.equal(+schedule.availableAt,+moved.startsAt); assert.equal(+schedule.expiresAt,+moved.endsAt);
    await buildNotificationScheduleRelease({now:()=>new Date(+old.endsAt+1000)})();
    assert.equal((await prisma.notificationSchedule.findUniqueOrThrow({where:{id:schedule.id}})).status,'PENDING');
    assert.equal(await prisma.inboxAlert.count({where:{userId:account.user.id}}),0);
  });
  it('preserves an individually started event while immediately changing subsequent scheduling zone',async()=>{
    await ready();const account=await createTestUser({timezone:'America/New_York',globalEventTimezone:'America/New_York'});
    const old=await pending(account,{startsAt:new Date(Date.now()-10000),endsAt:new Date(Date.now()+600000),startProcessedAt:new Date(),startOutcome:'ACTIVATED_ON_TIME'});
    assert.equal((await request(server.baseUrl,'GET','/auth/me',{token:account.token,headers:{'x-timezone':'America/Los_Angeles'}})).status,200);
    const stored=await prisma.globalStepEventEntitlement.findUniqueOrThrow({where:{id:old.id}});assert.equal(+stored.startsAt,+old.startsAt); assert.equal(stored.scheduleRevision,0);
    assert.equal((await prisma.user.findUniqueOrThrow({where:{id:account.user.id}})).globalEventTimezone,'America/Los_Angeles');
  });
  it('drains over 1000 ends through cron continuations, coalesces ticks, leaves future rows, and stops cleanly',async()=>{
    const now=new Date();const ids=Array.from({length:1002},()=>crypto.randomUUID());
    await prisma.user.createMany({data:ids.map(id=>({id,appleId:`end-${id}`}))});
    const event=await prisma.globalStepEvent.create({data:{startsAt:new Date(+now-3600000),endsAt:new Date(+now-1000),multiplier:2}});
    await prisma.globalStepEventEntitlement.createMany({data:ids.map((userId,i)=>({eventId:event.id,userId,timezone:'UTC',localDate:now.toISOString().slice(0,10),startsAt:new Date(+now-3600000),endsAt:new Date(+now+(i===1001?3600000:-1000))}))});
    let maintenance=0;
    const worker=scheduleGlobalStepEvents({maybeStartGlobalEvent:async()=>{maintenance++;},logger:quiet,endDrainBudgetMs:1000,endDrainMaxAttempts:3,endDrainPaceMs:5,endContinuationMs:10});
    try {
      await Promise.all([worker.tick(),worker.tick(),worker.tick()]);
      const deadline=Date.now()+20000;
      while(Date.now()<deadline && await prisma.globalStepEventEntitlement.count({where:{endProcessedAt:null,endsAt:{lte:now}}})) await new Promise(r=>setTimeout(r,30));
      assert.equal(await prisma.globalStepEventEntitlement.count({where:{endProcessedAt:{not:null}}}),1001);
      assert.equal(await prisma.globalStepEventEntitlement.count({where:{userId:ids[1001],endProcessedAt:null}}),1);
      assert.equal(maintenance,1,'end-only continuations must not repeat maintenance');
    } finally {await worker.stop();}
    assert.equal(await worker.tick(),null);
  });
  it('serializes a discovered old-zone enrollment after a timezone commit, with zero initial entitlement candidates',async()=>{
    await ready();
    const account=await createTestUser({timezone:'America/New_York',globalEventTimezone:'America/New_York'});
    const race=await prisma.race.create({data:{creatorId:account.user.id,name:'Timezone enrollment race',status:'ACTIVE',targetSteps:10000,startedAt:new Date()}});
    await prisma.raceParticipant.create({data:{raceId:race.id,userId:account.user.id,status:'ACCEPTED'}});
    const entitlement=await pending(account);
    const event=await prisma.globalStepEvent.findUniqueOrThrow({where:{id:entitlement.eventId}});
    await prisma.notificationSchedule.deleteMany({where:{sourceRef:entitlement.id}});
    await prisma.globalStepEventEntitlement.delete({where:{id:entitlement.id}});
    let discovered; const seen=new Promise(r=>{discovered=r;});
    let release; const gate=new Promise(r=>{release=r;});
    const job=buildLocalGlobalStepEventTick({GlobalStepEvent:{findLocalParentsForMaintenance:async()=>[event]},
      materializationAfterDiscovery:async()=>{discovered();await gate;},
      cleanupExpiredEntitlements:async()=>({healthy:false}),captureOperationalSnapshot:async()=>({healthy:false}),logger:quiet,skipEndBoundaries:true});
    const running=job();
    try {
      await Promise.race([seen,new Promise((_,reject)=>setTimeout(()=>reject(new Error('scheduler discovery hook missing')),1000))]);
      assert.equal((await request(server.baseUrl,'GET','/auth/me',{token:account.token,headers:{'x-timezone':'America/Los_Angeles'}})).status,200);
    } finally {release();await running;}
    const row=await prisma.globalStepEventEntitlement.findFirstOrThrow({where:{eventId:event.id,userId:account.user.id}});
    assert.equal(row.timezone,'America/Los_Angeles');
  });
  it('isolates a poison end row across bounded three-attempt passes and restart without losing healthy rows',async()=>{
    const now=new Date();const ids=Array.from({length:101},(_,i)=>`poison-${String(i).padStart(3,'0')}-${crypto.randomUUID()}`);
    await prisma.user.createMany({data:ids.map(id=>({id,appleId:id}))});
    const event=await prisma.globalStepEvent.create({data:{startsAt:new Date(+now-3600000),endsAt:new Date(+now-1000),multiplier:2}});
    await prisma.globalStepEventEntitlement.createMany({data:ids.map(userId=>({id:userId,eventId:event.id,userId,timezone:'UTC',localDate:now.toISOString().slice(0,10),startsAt:new Date(+now-3600000),endsAt:new Date(+now-1000)}))});
    await prisma.$executeRawUnsafe(`CREATE FUNCTION test_reject_one_end() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id LIKE 'poison-000-%' AND NEW.end_processed_at IS NOT NULL THEN RAISE EXCEPTION 'synthetic bad row' USING ERRCODE='23514'; END IF; RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe('CREATE TRIGGER test_reject_one_end BEFORE UPDATE ON global_step_event_entitlements FOR EACH ROW EXECUTE FUNCTION test_reject_one_end()');
    const worker=scheduleGlobalStepEvents({maybeStartGlobalEvent:async()=>{},logger:quiet,endDrainMaxAttempts:3,endDrainPaceMs:1,endContinuationMs:5});
    try {
      const deadline=Date.now()+10000;
      while(Date.now()<deadline && await prisma.globalStepEventEntitlement.count({where:{endProcessedAt:{not:null}}})<100) await new Promise(r=>setTimeout(r,20));
      assert.equal(await prisma.globalStepEventEntitlement.count({where:{endProcessedAt:{not:null}}}),100);
      const bad=await prisma.globalStepEventEntitlement.findUniqueOrThrow({where:{id:ids[0]}});
      assert.equal(bad.endProcessedAt,null);assert.ok(bad.endNextAttemptAt);assert.ok(bad.endAttemptCount>0);
    } finally {
      await worker.stop();await prisma.$executeRawUnsafe('DROP TRIGGER test_reject_one_end ON global_step_event_entitlements');await prisma.$executeRawUnsafe('DROP FUNCTION test_reject_one_end()');
    }
    await prisma.globalStepEventEntitlement.update({where:{id:ids[0]},data:{endNextAttemptAt:new Date(0)}});
    const recovered=scheduleGlobalStepEvents({maybeStartGlobalEvent:async()=>{},logger:quiet});
    try {await recovered.tick();assert.equal(await prisma.globalStepEventEntitlement.count({where:{endProcessedAt:{not:null}}}),101);} finally {await recovered.stop();}
  });

  it('reloads newly inserted candidates when enrollment commits while a timezone request waits for serialization',async()=>{
    await ready();const account=await createTestUser({timezone:'America/New_York',globalEventTimezone:'America/New_York'});
    const race=await prisma.race.create({data:{creatorId:account.user.id,name:'Enrollment before timezone',status:'ACTIVE',targetSteps:10000,startedAt:new Date()}});
    await prisma.raceParticipant.create({data:{raceId:race.id,userId:account.user.id,status:'ACCEPTED'}});
    const fixture=await pending(account);
    const event=await prisma.globalStepEvent.findUniqueOrThrow({where:{id:fixture.eventId}});
    await prisma.notificationSchedule.deleteMany({where:{sourceRef:fixture.id}});
    await prisma.globalStepEventEntitlement.delete({where:{id:fixture.id}});
    let entered;const seen=new Promise(r=>entered=r);let release;const gate=new Promise(r=>release=r);
    const api=await startServer({timezoneAfterRaceFences:async()=>{entered();await gate;}});
    const changing=request(api.baseUrl,'GET','/auth/me',{token:account.token,headers:{'x-timezone':'America/Los_Angeles'}});
    let old;
    try {
      await seen;
      const job=buildLocalGlobalStepEventTick({GlobalStepEvent:{findLocalParentsForMaintenance:async()=>[event]},
        cleanupExpiredEntitlements:async()=>({healthy:false}),captureOperationalSnapshot:async()=>({healthy:false}),logger:quiet,skipEndBoundaries:true});
      await job();
      old=await prisma.globalStepEventEntitlement.findFirstOrThrow({where:{eventId:event.id,userId:account.user.id}});
      assert.equal(old.timezone,'America/New_York');
      release();assert.equal((await changing).status,200);
    } finally {release();await changing;await api.close();}
    const row=await prisma.globalStepEventEntitlement.findUniqueOrThrow({where:{id:old.id}});
    assert.equal(row.timezone,'America/Los_Angeles');assert.equal(row.scheduleRevision,1);
  });
  it('uses the decision clock after locks and preserves an event that started while waiting',async()=>{
    await ready();const account=await createTestUser({timezone:'America/New_York',globalEventTimezone:'America/New_York'});
    let clock=new Date();const old=await pending(account,{startsAt:new Date(+clock+1000),endsAt:new Date(+clock+1801000)});
    const api=await startServer({now:()=>clock,timezoneAfterRaceFences:()=>{clock=new Date(+clock+2000);}});
    try {assert.equal((await request(api.baseUrl,'GET','/auth/me',{token:account.token,headers:{'x-timezone':'America/Los_Angeles'}})).status,200);} finally {await api.close();}
    assert.equal((await prisma.globalStepEventEntitlement.findUniqueOrThrow({where:{id:old.id}})).scheduleRevision,0);
    assert.equal((await prisma.user.findUniqueOrThrow({where:{id:account.user.id}})).timezone,'America/Los_Angeles');
  });
  it('preserves an admitted notification and a recalculated start in the past',async()=>{
    await ready();const account=await createTestUser({timezone:'America/New_York',globalEventTimezone:'America/New_York'});
    const old=await pending(account);await prisma.notificationSchedule.updateMany({where:{sourceRef:old.id},data:{status:'MATERIALIZED'}});
    assert.equal((await request(server.baseUrl,'GET','/auth/me',{token:account.token,headers:{'x-timezone':'America/Los_Angeles'}})).status,200);
    assert.equal((await prisma.globalStepEventEntitlement.findUniqueOrThrow({where:{id:old.id}})).scheduleRevision,0);
    await prisma.notificationSchedule.updateMany({where:{sourceRef:old.id},data:{status:'PENDING'}});
    await prisma.globalStepEvent.update({where:{id:old.eventId},data:{eventDay:new Date().toISOString().slice(0,10),localStartMinute:0}});
    assert.equal((await request(server.baseUrl,'GET','/auth/me',{token:account.token,headers:{'x-timezone':'UTC'}})).status,200);
    assert.equal((await prisma.globalStepEventEntitlement.findUniqueOrThrow({where:{id:old.id}})).scheduleRevision,0);
  });
  it('does no timezone database statements for repeated unchanged, absent and invalid headers',async()=>{
    const account=await createTestUser({timezone:'America/New_York',globalEventTimezone:'America/New_York'});
    const statements=[];const api=await startServer({timezoneStatementObserver:name=>statements.push(name)});
    try {
      for(let i=0;i<12;i++) assert.equal((await request(api.baseUrl,'GET','/auth/me',{token:account.token,headers:i%3===0?{}:{'x-timezone':i%3===1?'America/New_York':'invalid/timezone'}})).status,200);
    } finally {await api.close();}
    assert.deepEqual(statements,[]);
  });
  it('backs off a globally contended end transaction and recovers without overlapping scheduled ticks',async()=>{
    const now=new Date();const account=await createTestUser();const event=await prisma.globalStepEvent.create({data:{startsAt:new Date(+now-3600000),endsAt:new Date(+now-1000),multiplier:2}});
    const row=await prisma.globalStepEventEntitlement.create({data:{eventId:event.id,userId:account.user.id,timezone:'UTC',localDate:now.toISOString().slice(0,10),startsAt:event.startsAt,endsAt:event.endsAt}});
    let locked;const acquired=new Promise(r=>locked=r);let release;const gate=new Promise(r=>release=r);
    const holder=prisma.$transaction(async tx=>{await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended('global-event-enrollment',0))");locked();await gate;});
    await acquired;const errors=[];
    const worker=scheduleGlobalStepEvents({maybeStartGlobalEvent:async()=>{},logger:{log(){},error:(...args)=>errors.push(args)}});
    try {
      const one=worker.tick();assert.equal(worker.tick(),one,'tick must return the same active pass promise');
      await one;
      assert.equal((await prisma.globalStepEventEntitlement.findUniqueOrThrow({where:{id:row.id}})).endProcessedAt,null);
      assert.equal(errors.length,1,'one contention failure, no per-user fanout');
      release();await holder;
      const deadline=Date.now()+3000;
      while(Date.now()<deadline && !(await prisma.globalStepEventEntitlement.findUniqueOrThrow({where:{id:row.id}})).endProcessedAt) await new Promise(r=>setTimeout(r,20));
      assert.ok((await prisma.globalStepEventEntitlement.findUniqueOrThrow({where:{id:row.id}})).endProcessedAt);
    } finally {release();await holder;await worker.stop();}
  });

  for (const status of ['PENDING','ADMISSION_PENDING']) it(`defers delayed revision zero past its old expiry until the revised projection arrives (${status})`,async()=>{
    await ready();const account=await createTestUser({timezone:'America/New_York',globalEventTimezone:'America/New_York'});
    const old=await pending(account);
    const schedule=await prisma.notificationSchedule.findFirstOrThrow({where:{sourceRef:old.id}});
    await prisma.notificationSchedule.delete({where:{id:schedule.id}});
    assert.equal((await request(server.baseUrl,'GET','/auth/me',{token:account.token,headers:{'x-timezone':'America/Los_Angeles'}})).status,200);
    const moved=await prisma.globalStepEventEntitlement.findUniqueOrThrow({where:{id:old.id}});
    assert.equal(moved.scheduleRevision,1);
    // Revision-zero projection was delayed until after its former expiry.
    await prisma.notificationSchedule.create({data:{...schedule,status,...(status==='ADMISSION_PENDING'?{admissionClass:'visible:GLOBAL_EVENT_STARTED',admissionSequence:1n}:{})}});
    const clock=new Date(+old.endsAt+1000);
    await buildNotificationScheduleRelease({now:()=>clock})();
    const deferred=await prisma.notificationSchedule.findUniqueOrThrow({where:{id:schedule.id}});
    assert.equal(deferred.status,status);assert.ok(+deferred.availableAt>+clock,'deferred source revision must sleep beyond now');
    const projection=buildDomainEventProjectionJob({now:()=>clock,logger:quiet});await projection();await projection();
    const projected=await prisma.notificationSchedule.findUniqueOrThrow({where:{id:schedule.id}});
    assert.equal(projected.sourceRevision,1);assert.equal(+projected.availableAt,+moved.startsAt);
    assert.ok(+projected.expiresAt>+clock);assert.equal(await prisma.inboxAlert.count({where:{userId:account.user.id}}),0);
  });

  it('atomically reconciles more than one bounded page of future events instead of silently leaving overflow stale',async()=>{
    await ready();const account=await createTestUser({timezone:'America/New_York',globalEventTimezone:'America/New_York'});
    const events=Array.from({length:105},(_,i)=>{
      const day=new Date(Date.now()+(i+3)*86400000).toISOString().slice(0,10);
      const startsAt=new Date(`${day}T14:00:00Z`);
      return {id:crypto.randomUUID(),eventDay:day,scheduleMode:'LOCAL_ENTITLEMENTS',localStartMinute:600,durationMinutes:30,multiplier:2,startsAt,endsAt:new Date(+startsAt+86400000)};
    });
    await prisma.globalStepEvent.createMany({data:events});
    await prisma.globalStepEventEntitlement.createMany({data:events.map(event=>({eventId:event.id,userId:account.user.id,timezone:'America/New_York',localDate:event.eventDay,startsAt:event.startsAt,endsAt:new Date(+event.startsAt+1800000)}))});
    const response=await request(server.baseUrl,'GET','/auth/me',{token:account.token,headers:{'x-timezone':'America/Los_Angeles'}});
    assert.equal(response.status,200);
    assert.equal(await prisma.globalStepEventEntitlement.count({where:{userId:account.user.id,timezone:'America/Los_Angeles',scheduleRevision:1}}),105);
    assert.equal((await prisma.user.findUniqueOrThrow({where:{id:account.user.id}})).globalEventTimezone,'America/Los_Angeles');
    assert.equal(await prisma.domainEventOutbox.count({where:{eventType:'GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1'}}),105);
  });

  it('coalesces a maintenance tick during an end-only continuation instead of starving maintenance',async()=>{
    const account=await createTestUser();const now=new Date();
    const event=await prisma.globalStepEvent.create({data:{startsAt:new Date(+now-3600000),endsAt:new Date(+now-1000),multiplier:2}});
    await prisma.globalStepEventEntitlement.create({data:{eventId:event.id,userId:account.user.id,timezone:'UTC',localDate:now.toISOString().slice(0,10),startsAt:event.startsAt,endsAt:event.endsAt}});
    const real=buildGlobalEventEndDrain({endDrainMaxAttempts:1,logger:quiet});
    let calls=0,maintenance=0,entered,release;
    const seen=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
    const wrapped={run:async options=>{calls++;if(calls===2){entered();await gate;}const result=await real.run(options);if(calls===1)result.more=true;return result;}};
    const worker=scheduleGlobalStepEvents({endDrain:wrapped,maybeStartGlobalEvent:async()=>{maintenance++;},logger:quiet});
    try {
      await worker.tick();await seen;
      const overlapping=worker.tick();release();await overlapping;
      const deadline=Date.now()+1500;while(Date.now()<deadline && maintenance<2)await new Promise(r=>setTimeout(r,10));
      assert.equal(maintenance,2,'minute maintenance request during continuation must survive');
    } finally {release();await worker.stop();}
  });

  it('a full page of stale admitted schedules advances beyond now and the release worker returns',async()=>{
    await ready();const account=await createTestUser({timezone:'America/New_York',globalEventTimezone:'America/New_York'});
    const old=await pending(account),schedule=await prisma.notificationSchedule.findFirstOrThrow({where:{recipientUserId:account.user.id}});
    await prisma.notificationSchedule.delete({where:{id:schedule.id}});
    assert.equal((await request(server.baseUrl,'GET','/auth/me',{token:account.token,headers:{'x-timezone':'America/Los_Angeles'}})).status,200);
    const moved=await prisma.globalStepEventEntitlement.findUniqueOrThrow({where:{id:old.id}});
    const other=await createTestUser();
    const second=await prisma.globalStepEventEntitlement.create({data:{eventId:moved.eventId,userId:other.user.id,timezone:moved.timezone,localDate:moved.localDate,startsAt:moved.startsAt,endsAt:moved.endsAt,scheduleRevision:1}});
    await prisma.notificationSchedule.createMany({data:[{userId:account.user.id,source:old.id},{userId:other.user.id,source:second.id}].map(({userId,source},i)=>({...schedule,id:crypto.randomUUID(),recipientUserId:userId,deliveryKey:`visible:GLOBAL_EVENT_STARTED:${userId}:${old.eventId}`,sourceRef:source,status:'ADMISSION_PENDING',admissionClass:'visible:GLOBAL_EVENT_STARTED',admissionSequence:BigInt(i+1)}))});
    const clock=new Date(+old.endsAt+1000);
    const job=buildNotificationScheduleRelease({now:()=>clock,batchSize:2})();
    try {
      const result=await Promise.race([job,new Promise((_,reject)=>setTimeout(()=>reject(new Error('full stale page spun instead of sleeping')),1000))]);
      assert.equal(result.expired,0);assert.equal(result.materialized,0);
      const rows=await prisma.notificationSchedule.findMany({where:{sourceRef:{in:[old.id,second.id]}}});
      assert.equal(rows.length,2);assert.ok(rows.every(row=>row.status==='ADMISSION_PENDING' && +row.availableAt>+clock));
    } finally {
      await prisma.notificationSchedule.updateMany({where:{sourceRef:{in:[old.id,second.id]}},data:{availableAt:new Date(+clock+3600000)}});
      await job;
    }
  });

});
