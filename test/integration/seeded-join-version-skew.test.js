const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { describe, it, before, beforeEach, after } = require('node:test');
const { cleanDatabase, createTestUser, startServer, prisma, request } = require('./setup');
const HEADERS = { 'X-Client-Features': 'seeded_race_buckets' };
describe('current Join mixed-version HTTP compatibility', () => {
  let server;
  const at = new Date('2026-09-09T16:00:00Z');
  before(async () => { server = await startServer({ now: () => at }); });
  after(async () => server.close());
  beforeEach(cleanDatabase);
  const join = token => request(server.baseUrl,'POST','/races/seeded/DAILY_10K/join-current',{ token,headers:HEADERS,body:{requestId:randomUUID()} });
  async function legacy() {
    const seed = await prisma.raceSeed.findUnique({ where:{kind:'DAILY_10K'} });
    return prisma.race.create({data:{name:seed.name,seedId:seed.id,targetSteps:seed.targetSteps,status:'ACTIVE',isPublic:true,startedAt:new Date('2026-09-09T04:00:00Z'),endsAt:new Date('2026-09-10T04:00:00Z'),timeBased:true,maxParticipants:100,maxDurationDays:1}});
  }
  it('an old public request and new Join arbitrate one accepted stream atomically',async()=>{
    const race=await legacy();const {token,user}=await createTestUser();
    const [old,current]=await Promise.all([request(server.baseUrl,'POST',`/races/${race.id}/join`,{token}),join(token)]);
    assert.equal(current.status,200,await current.clone().text());const result=await current.json();
    if(old.status===201) assert.equal(result.raceId,race.id); else { assert.equal(old.status,409);assert.equal((await old.json()).code,'BUCKET_STREAM_ELECTED'); }
    assert.equal(await prisma.raceParticipant.count({where:{userId:user.id,status:'ACCEPTED'}}),1);
  });
  it('failed legacy admission leaves no orphan ledger claim',async()=>{
    const race=await legacy();await prisma.race.update({where:{id:race.id},data:{status:'COMPLETED'}});
    const {token,user}=await createTestUser();const failed=await request(server.baseUrl,'POST',`/races/${race.id}/join`,{token});assert.notEqual(failed.status,201);
    assert.equal(await prisma.seededRaceWindowMembership.count({where:{userId:user.id}}),0);
  });
  it('repairs an orphan LEGACY claim without rewriting the immutable window mode',async()=>{
    const race=await legacy(); const {token,user}=await createTestUser();
    await prisma.seededRaceWindowModeRecord.create({data:{seedId:race.seedId,windowStart:race.startedAt,windowEnd:race.endsAt,mode:'LEGACY'}});
    await prisma.seededRaceWindowMembership.create({data:{seedId:race.seedId,windowStart:race.startedAt,userId:user.id,stream:'LEGACY',raceId:race.id}});
    const response=await join(token);assert.equal(response.status,200,await response.clone().text());const result=await response.json();assert.notEqual(result.raceId,race.id);
    assert.equal((await prisma.seededRaceWindowModeRecord.findFirst()).mode,'LEGACY');
    assert.equal((await prisma.seededRaceWindowMembership.findFirst()).stream,'BUCKET');
  });
  it('old upcoming requests retain 202 and remain accepted after earlier preparation',async()=>{
    const seed=await prisma.raceSeed.findUnique({where:{kind:'DAILY_10K'}});
    const start=new Date('2026-09-10T04:00:00Z'),end=new Date('2026-09-11T04:00:00Z');
    await prisma.seededRaceWindowModeRecord.create({data:{seedId:seed.id,windowStart:start,windowEnd:end,mode:'BUCKET'}});
    const race=await prisma.race.create({data:{name:seed.name,seedId:seed.id,targetSteps:seed.targetSteps,status:'PENDING',isPublic:false,scheduledStartAt:start,endsAt:end,maxParticipants:35}});
    await prisma.seededRaceBucket.create({data:{seedId:seed.id,windowStart:start,windowEnd:end,raceId:race.id,status:'PENDING'}});
    const {token,user}=await createTestUser();const response=await request(server.baseUrl,'POST','/races/seeded/DAILY_10K/assign',{token,headers:HEADERS,body:{window:'UPCOMING'}});
    assert.equal(response.status,202,await response.clone().text()); assert.deepEqual(await response.json(),{elected:true,raceId:null,finalizesAt:start.toISOString()});
    assert.equal(await prisma.seededRaceWindowMembership.count({where:{userId:user.id,windowStart:start}}),1);
    const current=await join(token);assert.equal(current.status,200);assert.equal((await current.json()).windowStart,'2026-09-09T04:00:00.000Z');
  });
  it('ON persists exact next-window intents atomically; OFF never erases accepted intentions',async()=>{
    const {token,user}=await createTestUser({clientFeatures:['seeded_race_buckets']});
    const on=await request(server.baseUrl,'PUT','/auth/me/featured-auto-join',{token,headers:HEADERS,body:{enabled:true}});
    assert.equal(on.status,200);
    const intents=await prisma.seededChallengeEnrollmentRequest.findMany({where:{userId:user.id},orderBy:{windowStart:'asc'}});
    assert.equal(intents.length,2);assert.equal(intents[0].windowStart.toISOString(),'2026-09-10T04:00:00.000Z');
    assert.equal(intents[1].windowStart.toISOString(),'2026-09-14T04:00:00.000Z');
    assert.ok(intents.every(i=>i.requestedAt.getTime()===at.getTime()));
    assert.equal((await request(server.baseUrl,'PUT','/auth/me/featured-auto-join',{token,headers:HEADERS,body:{enabled:false}})).status,200);
    assert.equal(await prisma.seededChallengeEnrollmentRequest.count({where:{userId:user.id}}),2);
    assert.equal((await prisma.user.findUnique({where:{id:user.id}})).autoJoinFeaturedRaces,false);
  });

  it('preference accepted before midnight never elects another day in its delayed postcommit phase',async()=>{
    const seed=await prisma.raceSeed.findUnique({where:{kind:'DAILY_10K'}});
    for(const day of [10,11]) await prisma.seededRaceWindowModeRecord.create({data:{seedId:seed.id,mode:'BUCKET',windowStart:new Date(`2026-09-${day}T04:00:00Z`),windowEnd:new Date(`2026-09-${day+1}T04:00:00Z`)}});
    const {token,user}=await createTestUser({clientFeatures:['seeded_race_buckets']});
    let reads=0;
    const crossing=await startServer({now:()=>new Date(reads++===0?'2026-09-10T03:59:59Z':'2026-09-10T04:00:01Z')});
    try{
      const on=await request(crossing.baseUrl,'PUT','/auth/me/featured-auto-join',{token,headers:HEADERS,body:{enabled:true}});assert.equal(on.status,200);
      const off=await request(crossing.baseUrl,'PUT','/auth/me/featured-auto-join',{token,headers:HEADERS,body:{enabled:false}});assert.equal(off.status,200);
      const elected=await prisma.seededRaceWindowMembership.findMany({where:{userId:user.id,seedId:seed.id}});
      assert.equal(elected.length,1);assert.equal(elected[0].windowStart.toISOString(),'2026-09-10T04:00:00.000Z');
      assert.equal(await prisma.seededChallengeEnrollmentRequest.count({where:{userId:user.id,seedId:seed.id}}),1);
    }finally{await crossing.close();}
  });

});
