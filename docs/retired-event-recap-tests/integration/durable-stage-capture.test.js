const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { before,beforeEach,describe,it } = require("node:test");
const { cleanDatabase,createTestUser,getSharedServer,prisma,request } = require("./setup");
const { buildGlobalEventSummaryTick } = require("../../src/modules/steps/jobs/globalEventSummary");

let server;
async function fixture(count = 20) {
  const accounts = [];
  for (let index = 0; index < count; index += 1) accounts.push(await createTestUser({ displayName: `Warm stage ${index}` }));
  const endsAt = new Date(Math.floor(Date.now()/3600000)*3600000 - 3600000);
  const startsAt = new Date(endsAt.getTime()-50*60000);
  const localDate = startsAt.toISOString().slice(0,10);
  const race = await prisma.race.create({ data: { creatorId: accounts[0].user.id,name: "Bounded warm directed scoring",
    status: "ACTIVE",targetSteps: 1000000,powerupsEnabled: true,timezone: "UTC",startedAt: new Date(startsAt.getTime()-600000),
    endsAt: new Date(Date.now()+3600000) } });
  const participants = [];
  for (const [index,account] of accounts.entries()) {
    participants.push(await prisma.raceParticipant.create({ data: { raceId: race.id,userId: account.user.id,status: "ACCEPTED",joinedAt: race.startedAt } }));
    await prisma.stepSample.create({ data: { userId: account.user.id,periodStart: startsAt,periodEnd: endsAt,steps: index ? 1000 : 200 } });
    await prisma.step.create({ data: { userId: account.user.id,date: new Date(localDate),steps: index ? 1000 : 200 } });
    if (index) {
      const powerup = await prisma.racePowerup.create({ data: { raceId: race.id,participantId: participants[0].id,
        userId: accounts[0].user.id,targetUserId: account.user.id,type: "LEECH",status: "USED" } });
      await prisma.raceActiveEffect.create({ data: { raceId: race.id,powerupId: powerup.id,targetParticipantId: participants[index].id,
        targetUserId: account.user.id,sourceUserId: accounts[0].user.id,type: "LEECH",status: "EXPIRED",startsAt,expiresAt: endsAt,metadata: { ratio: 2 } } });
    }
  }
  return { accounts,participants,race,startsAt,endsAt,localDate };
}
async function enqueue(f) {
  const event = await prisma.globalStepEvent.create({ data: { startsAt: f.startsAt,endsAt: f.endsAt,multiplier: 2,summaryAttributionVersion: 2 } });
  await prisma.globalStepEventEntitlement.create({ data: { eventId: event.id,userId: f.accounts[0].user.id,timezone: "UTC",
    localDate: f.localDate,startsAt: f.startsAt,endsAt: f.endsAt,startOutcome: "ACTIVATED_ON_TIME",startProcessedAt: f.startsAt } });
  const work = await prisma.globalEventSummaryWork.create({ data: { eventId: event.id,userId: f.accounts[0].user.id,status: "WAITING_SYNC",
    expiresAt: new Date(Date.now()+3600000),requiredRaceCount: 1 } });
  await prisma.globalEventRaceImpact.create({ data: { eventId: event.id,raceId: f.race.id,userId: f.accounts[0].user.id,status: "PENDING",attributionVersion: 2 } });
  const response = await request(server.baseUrl,"POST","/steps/sync-v2",{ token: f.accounts[0].token,
    headers: { "Idempotency-Key": randomUUID(),"X-Timezone": "UTC","X-Client-Features": "impact_summaries,impact_summary_expiry_v1" },
    body: { date: f.localDate,steps: 200,samples: [{ periodStart: f.startsAt.toISOString(),periodEnd: f.endsAt.toISOString(),steps: 200 }] } });
  assert.equal(response.status,202,JSON.stringify(response.body));
  const [capture] = await prisma.$queryRawUnsafe("SELECT id FROM durable_global_event_capture_requests WHERE work_id=$1",work.id);
  return { work,capture };
}
async function tick() { await buildGlobalEventSummaryTick({ prisma,now: () => new Date() })(); }
async function modifiers(f,count,{fractional=false}={}) {
  for (let index=0;index<count;index++) {
    const powerup=await prisma.racePowerup.create({data:{raceId:f.race.id,participantId:f.participants[0].id,
      userId:f.accounts[0].user.id,type: "RALLY_FLAG",status:"USED"}});
    await prisma.raceActiveEffect.create({data:{raceId:f.race.id,powerupId:powerup.id,targetParticipantId:f.participants[0].id,
      targetUserId:f.accounts[0].user.id,sourceUserId:f.accounts[0].user.id,type:"RALLY_FLAG",status:"EXPIRED",
      startsAt:fractional ? f.startsAt : new Date(f.startsAt.getTime()+index*5000),expiresAt:f.endsAt,
      metadata:{multiplier:fractional ? 0.1 : 1.25}}});
  }
}
async function addEffect(f,type,{source=0,target=0,startsAt=f.startsAt,metadata={}}={}) {
  const powerup=await prisma.racePowerup.create({data:{raceId:f.race.id,participantId:f.participants[source].id,
    userId:f.accounts[source].user.id,targetUserId:f.accounts[target].user.id,type,status:"USED"}});
  return prisma.raceActiveEffect.create({data:{raceId:f.race.id,powerupId:powerup.id,targetParticipantId:f.participants[target].id,
    targetUserId:f.accounts[target].user.id,sourceUserId:f.accounts[source].user.id,type,status:"EXPIRED",
    startsAt,expiresAt:f.endsAt,metadata}});
}
async function finish(workId) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    await tick();
    const artifact = await prisma.globalEventCaptureArtifact.findFirst({ where: { workId } });
    if (artifact) return artifact;
    const [current] = await prisma.$queryRawUnsafe("SELECT status,last_error_code FROM durable_global_event_capture_requests WHERE work_id=$1",workId);
    assert.notEqual(current.status,"FAILED",JSON.stringify(current));
  }
  assert.fail("stage scoring failed to finish bounded claims");
}

describe("bounded durable warm scoring stages",() => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => { await cleanDatabase(); });
  it("a warm directed graph still yields arithmetic work and resumes from completed stages",async () => {
    const f = await fixture();
    const first = await enqueue(f);
    assert.equal((await finish(first.work.id)).payload.attributionDeltaSteps,200);
    const second = await enqueue(f);
    await tick();
    assert.equal(await prisma.globalEventCaptureArtifact.count({ where: { workId: second.work.id } }),0,
      "warm scalar cache hits must not bypass the bounded arithmetic budget");
    const [progress] = await prisma.$queryRawUnsafe("SELECT completed_operations FROM durable_capture_score_progress WHERE request_id=$1::uuid AND race_id=$2",second.capture.id,f.race.id);
    assert.ok(progress?.completed_operations>0,"worker must persist a nonzero arithmetic cursor before yielding");
    const artifact = await finish(second.work.id);
    assert.equal(artifact.payload.attributionDeltaSteps,200);
    const [complete] = await prisma.$queryRawUnsafe("SELECT completed_operations,stage FROM durable_capture_score_progress WHERE request_id=$1::uuid AND race_id=$2",second.capture.id,f.race.id);
    assert.equal(complete.stage,"FINAL");
    assert.ok(complete.completed_operations>progress.completed_operations);
  });
  it("a serialized late join keeps the canonical base cutoff under a floor-sensitive incoming Leech",async () => {
    const f = await fixture(2);
    await prisma.raceParticipant.update({ where: { id: f.participants[0].id },data: { joinedAt: new Date(f.startsAt.getTime()+25*60000) } });
    await prisma.stepSample.updateMany({ where: { userId: f.accounts[1].user.id },data: { steps: 500 } });
    await prisma.step.updateMany({ where: { userId: f.accounts[1].user.id },data: { steps: 500 } });
    const powerup = await prisma.racePowerup.create({ data: { raceId: f.race.id,participantId: f.participants[1].id,
      userId: f.accounts[1].user.id,targetUserId: f.accounts[0].user.id,type: "LEECH",status: "USED" } });
    await prisma.raceActiveEffect.create({ data: { raceId: f.race.id,powerupId: powerup.id,targetParticipantId: f.participants[0].id,
      targetUserId: f.accounts[0].user.id,sourceUserId: f.accounts[1].user.id,type: "LEECH",status: "EXPIRED",
      startsAt: f.startsAt,expiresAt: f.endsAt,metadata: { ratio: 2 } } });
    const queued = await enqueue(f);
    // Base counts only half of A200 after join=100. Existing global boost
    // remains200; incoming Leech250 floors100->0 and300->50. Own outgoing
    // credit is constant in both scenarios, so exact event delta=50.
    assert.equal((await finish(queued.work.id)).payload.attributionDeltaSteps,50);
  });
  it("resumes a warm arithmetic cursor after losing its lease without replaying completed operations",async()=>{
    const f=await fixture(8); const first=await enqueue(f); await finish(first.work.id);
    const [baseline]=await prisma.$queryRawUnsafe("SELECT completed_operations FROM durable_capture_score_progress WHERE request_id=$1::uuid",first.capture.id);
    const queued=await enqueue(f);
    await prisma.$executeRawUnsafe(`CREATE FUNCTION durable_test_expire_stage_lease() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.completed_operations>=10 THEN UPDATE durable_global_event_capture_requests
        SET lease_until=clock_timestamp()-interval '1 second' WHERE id=NEW.request_id AND attempt_count=1; END IF;
      RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER durable_test_expire_stage AFTER UPDATE ON durable_capture_score_progress
      FOR EACH ROW EXECUTE FUNCTION durable_test_expire_stage_lease()`);
    try {
      await tick();
      assert.equal(await prisma.globalEventCaptureArtifact.count({where:{workId:queued.work.id}}),0);
      const [saved]=await prisma.$queryRawUnsafe("SELECT completed_operations FROM durable_capture_score_progress WHERE request_id=$1::uuid",queued.capture.id);
      assert.ok(saved.completed_operations>=10);
    } finally {
      await prisma.$executeRawUnsafe("DROP TRIGGER durable_test_expire_stage ON durable_capture_score_progress");
      await prisma.$executeRawUnsafe("DROP FUNCTION durable_test_expire_stage_lease()");
    }
    assert.equal((await finish(queued.work.id)).payload.attributionDeltaSteps,200);
    const [complete]=await prisma.$queryRawUnsafe(`SELECT p.completed_operations,r.attempt_count FROM durable_capture_score_progress p
      JOIN durable_global_event_capture_requests r ON r.id=p.request_id WHERE p.request_id=$1::uuid`,queued.capture.id);
    assert.equal(complete.completed_operations,baseline.completed_operations,"completed prefixes must not be scored again after reclaim");
    assert.ok(complete.attempt_count>=2);
  });
  it("checkpoints exceptional historical fractional multipliers in exact legacy row order",async()=>{
    const f=await fixture(1); await modifiers(f,90,{fractional:true}); const queued=await enqueue(f);
    await tick();
    assert.equal(await prisma.globalEventCaptureArtifact.count({where:{workId:queued.work.id}}),0);
    const [saved]=await prisma.$queryRawUnsafe("SELECT state FROM durable_capture_score_progress WHERE request_id=$1::uuid",queued.capture.id);
    assert.ok(saved.state.modifier.multiplierIndex>0,"historical fallback must save its per-effect accumulation cursor");
    //90 simultaneous0.1 multipliers sum to approximately9x;200 event-window
    //steps therefore yield1800 extra steps, rounded only at final attribution.
    assert.equal((await finish(queued.work.id)).payload.attributionDeltaSteps,1800);
  });
  it("deleting an account detaches one score owner and reclaims scratch points in bounded worker passes",async()=>{
    const f=await fixture(1); await modifiers(f,160); const queued=await enqueue(f);
    await tick(); await tick(); await tick();
    const count=async()=>Number((await prisma.$queryRawUnsafe("SELECT count(*)::int AS n FROM durable_capture_score_points WHERE request_id=$1::uuid",queued.capture.id))[0].n);
    const before=await count(); assert.ok(before>128);
    const response=await request(server.baseUrl,"DELETE","/auth/account",{token:f.accounts[0].token});
    assert.equal(response.status,204);
    const [owner]=await prisma.$queryRawUnsafe("SELECT live_request_id FROM durable_capture_score_owners WHERE id=$1::uuid",queued.capture.id);
    assert.equal(owner.live_request_id,null);
    assert.equal(await count(),before,"account deletion must not cascade the entire scoring plan");
    await tick(); const remaining=await count(); assert.ok(before-remaining<=128); assert.ok(remaining>0);
    for(let attempt=0;attempt<10;attempt++) await tick();
    assert.equal(await count(),0);
    assert.equal((await prisma.$queryRawUnsafe("SELECT id FROM durable_capture_score_owners WHERE id=$1::uuid",queued.capture.id)).length,0);
  });
  it("does not publish a plausible but wrong score when an accepted transfer checkpoint disappears",async()=>{
    const f=await fixture(20); const queued=await enqueue(f);
    for(let i=0;i<5;i++) {
      await tick();
      const [row]=await prisma.$queryRawUnsafe("SELECT effect_id FROM durable_capture_score_transfers WHERE request_id=$1::uuid LIMIT 1",queued.capture.id);
      if(row) { await prisma.$executeRawUnsafe("DELETE FROM durable_capture_score_transfers WHERE request_id=$1::uuid AND effect_id=$2",queued.capture.id,row.effect_id); break; }
    }
    for(let i=0;i<30;i++) await tick();
    assert.equal(await prisma.globalEventCaptureArtifact.count({where:{workId:queued.work.id}}),0);
    const [result]=await prisma.$queryRawUnsafe("SELECT status,last_error_code FROM durable_global_event_capture_requests WHERE id=$1::uuid",queued.capture.id);
    assert.equal(result.status,"FAILED"); assert.equal(result.last_error_code,"INPUTS_NOT_RETAINED");
  });
  for(const corruption of ["delete","payload","indexed time","pending point"]) {
    it(`rejects ${corruption} corruption of a persisted multiplier point`,async()=>{
      const f=await fixture(1); await modifiers(f,160); const queued=await enqueue(f); await tick();
      const [point]=await prisma.$queryRawUnsafe("SELECT plan_key,time_ms FROM durable_capture_score_points WHERE request_id=$1::uuid AND position=10",queued.capture.id);
      assert.ok(point,"fault must target a persisted point before scoring begins");
      if(corruption==="delete") await prisma.$executeRawUnsafe("DELETE FROM durable_capture_score_points WHERE request_id=$1::uuid AND position=10",queued.capture.id);
      else if(corruption==="payload") await prisma.$executeRawUnsafe(`UPDATE durable_capture_score_points SET payload=jsonb_set(payload,'{multiplier}','9999'::jsonb)
        WHERE request_id=$1::uuid AND position=10`,queued.capture.id);
      else if(corruption==="indexed time") await prisma.$executeRawUnsafe("UPDATE durable_capture_score_points SET time_ms=time_ms+1 WHERE request_id=$1::uuid AND position=10",queued.capture.id);
      else await prisma.$executeRawUnsafe(`UPDATE durable_capture_score_plans SET pending_points=jsonb_set(pending_points,'{100,point,multiplier}','9999'::jsonb)
        WHERE request_id=$1::uuid`,queued.capture.id);
      for(let i=0;i<30;i++) await tick();
      assert.equal(await prisma.globalEventCaptureArtifact.count({where:{workId:queued.work.id}}),0);
      const [result]=await prisma.$queryRawUnsafe("SELECT status,last_error_code FROM durable_global_event_capture_requests WHERE id=$1::uuid",queued.capture.id);
      assert.equal(result.status,"FAILED"); assert.equal(result.last_error_code,"INPUTS_NOT_RETAINED");
    });
  }
  it("retains per-segment rounding, umbrella masking, and signed global boosts",async()=>{
    const f=await fixture(1);
    await addEffect(f,"RUNNERS_HIGH"); await addEffect(f,"RALLY_FLAG",{metadata:{multiplier:1.25}});
    await addEffect(f,"RAINSTORM",{metadata:{multiplier:.5}});
    const umbrella=await addEffect(f,"UMBRELLA");
    await prisma.raceActiveEffect.update({where:{id:umbrella.id},data:{expiresAt:new Date(f.startsAt.getTime()+25*60000)}});
    await addEffect(f,"WRONG_TURN",{startsAt:new Date(f.startsAt.getTime()+25*60000)});
    const queued=await enqueue(f);
    // First100 steps3.25x, last100 steps-1.625x. Without event162.5;
    // with event325. Attribution rounds162.5 only once, yielding163.
    assert.equal((await finish(queued.work.id)).payload.attributionDeltaSteps,163);
  });
  it("sums signed Hitchhike copies before flooring and keeps copied steps drainable",async()=>{
    const f=await fixture(4);
    await prisma.stepSample.updateMany({where:{userId:f.accounts[3].user.id},data:{steps:2600}});
    await prisma.step.updateMany({where:{userId:f.accounts[3].user.id},data:{steps:2600}});
    await addEffect(f,"WRONG_TURN",{source:1,target:1}); await addEffect(f,"RUNNERS_HIGH",{source:2,target:2});
    await addEffect(f,"HITCHHIKE",{source:0,target:1,metadata:{scoringVersion:2,copyRatio:1}});
    await addEffect(f,"HITCHHIKE",{source:0,target:2,metadata:{scoringVersion:2,copyRatio:1}});
    await addEffect(f,"LEECH",{source:3,target:0,metadata:{ratio:2}});
    const queued=await enqueue(f);
    // A200 +copies(-1000+2000)=1200; event raises1400. Incoming drain1300
    // leaves0/100; A's outgoing credits are event-independent. Delta100.
    assert.equal((await finish(queued.work.id)).payload.attributionDeltaSteps,100);
  });
});
