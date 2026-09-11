const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { before,beforeEach,describe,it } = require("node:test");
const { cleanDatabase,createTestUser,getSharedServer,prisma,request } = require("./setup");
const { buildGlobalEventSummaryTick, buildGlobalEventSummaryV2Tick } = require("../../src/modules/steps/jobs/globalEventSummary");

let server;
async function fixture() {
  const account=await createTestUser({displayName:`Terminal pins ${randomUUID().slice(0,8)}`});
  const endsAt=new Date(Math.floor(Date.now()/3600000)*3600000-3600000);
  const startsAt=new Date(endsAt.getTime()-30*60000);
  const race=await prisma.race.create({data:{creatorId:account.user.id,name:"Long retained capture",status:"ACTIVE",
    targetSteps:100000000,powerupsEnabled:false,timezone:"UTC",startedAt:new Date(startsAt.getTime()-180*86400000),
    endsAt:new Date(Date.now()+3600000)}});
  await prisma.raceParticipant.create({data:{raceId:race.id,userId:account.user.id,status:"ACCEPTED",joinedAt:race.startedAt}});
  const event=await prisma.globalStepEvent.create({data:{startsAt,endsAt,multiplier:2,summaryAttributionVersion:2}});
  const localDate=startsAt.toISOString().slice(0,10);
  await prisma.globalStepEventEntitlement.create({data:{eventId:event.id,userId:account.user.id,timezone:"UTC",localDate,
    startsAt,endsAt,startOutcome:"ACTIVATED_ON_TIME",startProcessedAt:startsAt}});
  const work=await prisma.globalEventSummaryWork.create({data:{eventId:event.id,userId:account.user.id,status:"WAITING_SYNC",
    expiresAt:new Date(Date.now()+3600000),requiredRaceCount:1}});
  await prisma.globalEventRaceImpact.create({data:{eventId:event.id,raceId:race.id,userId:account.user.id,status:"PENDING",attributionVersion:2}});
  const response=await request(server.baseUrl,"POST","/steps/sync-v2",{token:account.token,
    headers:{"Idempotency-Key":randomUUID(),"X-Timezone":"UTC","X-Client-Features":"impact_summaries,impact_summary_expiry_v1"},
    body:{date:localDate,steps:200,samples:[{periodStart:startsAt.toISOString(),periodEnd:endsAt.toISOString(),steps:200}]}});
  assert.equal(response.status,202,JSON.stringify(response.body));
  const [capture]=await prisma.$queryRawUnsafe("SELECT id FROM durable_global_event_capture_requests WHERE work_id=$1",work.id);
  return {account,work,capture};
}
const pins=async(id)=>Number((await prisma.$queryRawUnsafe("SELECT count(*)::int AS n FROM durable_capture_fact_pins WHERE owner_id=$1::uuid",id))[0].n);
const tick=(recovery=true)=>recovery
  ? buildGlobalEventSummaryTick({prisma,now:()=>new Date()})()
  : buildGlobalEventSummaryV2Tick({prisma,now:()=>new Date()})({recovery:false});

describe("bounded terminal durable-capture pin release",()=>{
  before(async()=>{server=await getSharedServer();});
  beforeEach(async()=>{await cleanDatabase();});
  for(const recovery of [true,false]) for(const terminal of ["EXPIRED","FAILED"]) {
    it(`${terminal} releases at most128pins per worker pass and eventually releases all (recovery=${recovery})`,async()=>{
      const f=await fixture(); const healthy=await fixture();
      await prisma.$executeRawUnsafe("UPDATE durable_global_event_capture_requests SET available_at=clock_timestamp()+interval '1 hour' WHERE id=$1::uuid",healthy.capture.id);
      const healthyPins=await pins(healthy.capture.id); const before=await pins(f.capture.id);
      assert.ok(before>128,"realHTTP intake must pin an oversized immutable root vector");
      if(terminal==="EXPIRED") {
        await prisma.$executeRawUnsafe("UPDATE durable_global_event_capture_requests SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1::uuid",f.capture.id);
        await prisma.globalEventSummaryWork.update({where:{id:f.work.id},data:{expiresAt:new Date(Date.now()-1000)}});
      } else await prisma.$executeRawUnsafe("UPDATE durable_global_event_capture_requests SET context_digest=repeat('0',64) WHERE id=$1::uuid",f.capture.id);
      await tick(recovery);
      let previous=await pins(f.capture.id);
      assert.equal(before-previous,128,"terminalization must not delete an unbounded owner pin vector");
      assert.ok(previous>0,"remaining pins must be queued for another bounded pass");
      const [status]=await prisma.$queryRawUnsafe("SELECT status FROM durable_global_event_capture_requests WHERE id=$1::uuid",f.capture.id);
      assert.equal(status.status,terminal);
      for(let attempt=0;attempt<10 && previous;attempt++) {
        await tick(recovery); const remaining=await pins(f.capture.id);
        assert.ok(previous-remaining<=128); previous=remaining;
      }
      assert.equal(previous,0,"terminal pins must be eligible immediately, not after30days");
      assert.equal(await pins(healthy.capture.id),healthyPins,"pending owners must retain every pinned revision");
      assert.equal(await prisma.globalEventCaptureArtifact.count({where:{workId:f.work.id}}),0);
      const [prepared]=await prisma.$queryRawUnsafe("SELECT count(*)::int AS n FROM durable_capture_fact_roots WHERE user_id=$1 AND prepared_at IS NOT NULL",f.account.user.id);
      assert.equal(prepared.n,0,"terminalization cannot hydrate source facts");
    });
  }
  it("shares one128pin budget across aged cleanup, new expiry, and new failure in the same pass",async()=>{
    const aged=await fixture(); const expired=await fixture(); const failed=await fixture();
    await prisma.$executeRawUnsafe(`UPDATE durable_global_event_capture_requests SET status='COMPLETE',
      completed_at=clock_timestamp()-interval '31 days' WHERE id=$1::uuid`,aged.capture.id);
    await prisma.$executeRawUnsafe("UPDATE durable_global_event_capture_requests SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1::uuid",expired.capture.id);
    await prisma.globalEventSummaryWork.update({where:{id:expired.work.id},data:{expiresAt:new Date(Date.now()-1000)}});
    await prisma.$executeRawUnsafe("UPDATE durable_global_event_capture_requests SET context_digest=repeat('0',64) WHERE id=$1::uuid",failed.capture.id);
    const ids=[aged.capture.id,expired.capture.id,failed.capture.id];
    const total=async()=>Number((await prisma.$queryRawUnsafe("SELECT count(*)::int AS n FROM durable_capture_fact_pins WHERE owner_id=ANY($1::uuid[])",ids))[0].n);
    const before=await total(); await tick();
    let previous=await total(); assert.equal(before-previous,128,"all three release branches must share one budget");
    const states=await prisma.$queryRawUnsafe("SELECT id,status FROM durable_global_event_capture_requests WHERE id=ANY($1::uuid[])",ids);
    assert.equal(states.find((r)=>r.id===expired.capture.id).status,"EXPIRED");
    assert.equal(states.find((r)=>r.id===failed.capture.id).status,"FAILED");
    for(let attempt=0;attempt<10 && previous;attempt++) {
      await tick(); const remaining=await total(); assert.ok(previous-remaining<=128); previous=remaining;
    }
    assert.equal(previous,0);
    const [queued]=await prisma.$queryRawUnsafe("SELECT count(*)::int AS n FROM durable_capture_pin_releases WHERE owner_id=ANY($1::uuid[])",ids);
    assert.equal(queued.n,0,"empty queue entries must not accumulate or force historical rescans");
  });
});
