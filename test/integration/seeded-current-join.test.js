const { buildRaceExpiryRunner } = require('../../src/modules/races/jobs/raceExpiry');
const { buildRaceResolutionWorkerV2 } = require('../../src/modules/races/jobs/raceResolutionQueueV2');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { describe, it, before, beforeEach, after } = require('node:test');
const { cleanDatabase, createTestUser, startServer, prisma, request } = require('./setup');
const HEADERS = { 'X-Client-Features': 'seeded_race_buckets' };
// Only the application clock is injected: authentication, routes, admission,
// score reads and PostgreSQL writes run through their production handlers.
describe('immediate current seeded Join HTTP contract', () => {
  let server, at;
  before(async () => { server = await startServer({ now: () => new Date(at), verifyAppleIdentityToken: async token => ({sub:token,email:`${token}@example.com`}), verifyGoogleIdentityToken: async token => ({sub:token,email:`${token}@example.com`}) }); });
  after(async () => server.close());
  beforeEach(async () => { await cleanDatabase(); await prisma.onboardingBoxGrant.deleteMany(); at = '2026-09-09T16:00:00Z'; });
  const join = (token, kind = 'DAILY_10K', body = { requestId: randomUUID() }, headers = HEADERS) => request(server.baseUrl, 'POST', `/races/seeded/${kind}/join-current`, { token, headers, body });
  for (const kind of ['DAILY_10K', 'WEEKLY_50K']) it(`${kind}: joins immediately, is readable, projects JOINED and preserves preference`, async () => {
    const { user, token } = await createTestUser({ autoJoinFeaturedRaces: false });
    const response = await join(token, kind);
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    assert.equal(result.joined, true); assert.equal(result.alreadyJoined, false);
    assert.equal(result.raceStatus, 'ACTIVE'); assert.equal(result.joinedAt, new Date(at).toISOString());
    assert.equal(result.scoringStartsAt, result.joinedAt);
    assert.equal((await request(server.baseUrl, 'GET', `/races/${result.raceId}`, { token, headers: HEADERS })).status, 200);
    const featured = await request(server.baseUrl, 'GET', '/races/featured', { token, headers: HEADERS }).then(r => r.json());
    const card = featured.races.find(r => r.seedKind === kind);
    assert.equal(card.currentJoin.state, 'JOINED'); assert.equal(card.currentJoin.raceId, result.raceId);
    assert.equal((await prisma.user.findUnique({ where: { id: user.id } })).autoJoinFeaturedRaces, false);
    assert.equal(await prisma.onboardingBoxGrant.count(), 0);
  });
  it('replays receipts across midnight without joining the new day, and prevents seed reuse', async () => {
    const { token, user } = await createTestUser(); const requestId = randomUUID();
    const first = await join(token, 'DAILY_10K', { requestId }); assert.equal(first.status, 200);
    const original = await first.json(); at = '2026-09-10T04:01:00Z';
    const replay = await join(token, 'DAILY_10K', { requestId }); assert.equal(replay.status, 200);
    const replayed = await replay.json(); assert.equal(replayed.raceId, original.raceId); assert.equal(replayed.joinedAt, original.joinedAt); assert.equal(replayed.alreadyJoined, true);
    assert.equal(await prisma.raceParticipant.count({ where: { userId: user.id } }), 1);
    const conflict = await join(token, 'WEEKLY_50K', { requestId }); assert.equal(conflict.status, 409); assert.equal((await conflict.json()).code, 'IDEMPOTENCY_CONFLICT');
  });
  it('two devices and parallel retries produce one participant and preserve join time', async () => {
    const { token, user } = await createTestUser();
    const responses = await Promise.all(Array.from({ length: 8 }, () => join(token)));
    for (const response of responses) assert.equal(response.status, 200, await response.clone().text());
    const results = await Promise.all(responses.map(r => r.json()));
    assert.equal(new Set(results.map(r => r.raceId)).size, 1); assert.equal(new Set(results.map(r => r.joinedAt)).size, 1);
    assert.equal(await prisma.raceParticipant.count({ where: { userId: user.id } }), 1);
  });
  it('fills the current group to its hard cap then reuses one overflow group', async () => {
    const users = await Promise.all(Array.from({ length: 38 }, () => createTestUser()));
    const results = [];
    for (const account of users.slice(0, 34)) { const response = await join(account.token); assert.equal(response.status, 200); results.push(await response.json()); }
    for (const response of await Promise.all(users.slice(34).map(u => join(u.token)))) { assert.equal(response.status, 200, await response.clone().text()); results.push(await response.json()); }
    const groups = new Map(); for (const result of results) groups.set(result.raceId, (groups.get(result.raceId) || 0) + 1);
    assert.deepEqual([...groups.values()].sort((a,b) => a-b), [3,35]);
  });
  it('rejects placement/backdating inputs and incapable clients before writing membership', async () => {
    const { token } = await createTestUser();
    for (const body of [{}, { requestId: 'bad' }, { requestId: randomUUID(), joinedAt: at }, { requestId: randomUUID(), raceId: randomUUID() }]) {
      const r = await join(token, 'DAILY_10K', body); assert.equal(r.status, 400); assert.equal((await r.json()).code, 'INVALID_REQUEST');
    }
    const incapable = await join(token, 'DAILY_10K', { requestId: randomUUID() }, {}); assert.equal(incapable.status, 400); assert.equal((await incapable.json()).code, 'UPDATE_REQUIRED');
    const invalid = await join(token, 'NOPE'); assert.equal(invalid.status, 400); assert.equal((await invalid.json()).code, 'INVALID_SEED_KIND');
    assert.equal(await prisma.seededRaceWindowMembership.count(), 0);
  });
  it('private race IDs remain inaccessible to strangers', async () => {
    const owner = await createTestUser(); const stranger = await createTestUser();
    const joined = await join(owner.token); assert.equal(joined.status, 200); const { raceId } = await joined.json();
    const denied = await request(server.baseUrl, 'POST', `/races/${raceId}/join`, { token: stranger.token, headers: HEADERS });
    assert.equal(denied.status, 403); assert.equal((await denied.json()).code, 'RACE_PRIVATE');
  });
  it('system-pruned empty participants may explicitly return with a fresh scoring instant and audit', async()=>{
    const {token,user}=await createTestUser();const first=await join(token);assert.equal(first.status,200);const original=await first.json();
    await prisma.raceParticipant.update({where:{id:original.participantId},data:{status:'DECLINED'}});
    await prisma.seededRaceBucketAssignment.updateMany({where:{raceParticipantId:original.participantId},data:{state:'PRUNED'}});
    await prisma.seededRaceWindowMembership.updateMany({where:{userId:user.id},data:{admissionSource:'AUTOMATIC',manualJoinedAt:null}});
    at='2026-09-09T18:00:00Z';const returned=await join(token);assert.equal(returned.status,200,await returned.clone().text());const current=await returned.json();
    assert.equal(current.raceId,original.raceId);assert.equal(current.joinedAt,new Date(at).toISOString());assert.equal(current.alreadyJoined,false);
    assert.equal(await prisma.seededChallengeTransfer.count({where:{userId:user.id}}),1);
    assert.equal((await prisma.seededRaceWindowMembership.findFirst({where:{userId:user.id}})).admissionSource,'MANUAL_CURRENT');
  });
  it('pruned participants with raw activity are retained and receive a durable retryable repair, never reset',async()=>{
    const {token,user}=await createTestUser();const first=await join(token);assert.equal(first.status,200);const original=await first.json();
    await prisma.raceParticipant.update({where:{id:original.participantId},data:{status:'DECLINED'}});
    await prisma.seededRaceBucketAssignment.updateMany({where:{raceParticipantId:original.participantId},data:{state:'PRUNED'}});
    await prisma.step.create({data:{userId:user.id,date:new Date('2026-09-09'),steps:1000}});
    const returned=await join(token);assert.equal(returned.status,503);assert.equal(returned.headers.get('retry-after'),'1');assert.equal((await returned.json()).retryable,true);
    assert.equal(await prisma.seededChallengeMembershipRepair.count({where:{userId:user.id}}),1);
    assert.equal((await prisma.raceParticipant.findUnique({where:{id:original.participantId}})).status,'DECLINED');
    assert.equal(await prisma.seededChallengeTransfer.count(),0);
  });
  it('deliberate forfeit cannot reenter or reset its join time',async()=>{
    const {token}=await createTestUser();const first=await join(token);assert.equal(first.status,200);const original=await first.json();
    await prisma.raceParticipant.update({where:{id:original.participantId},data:{forfeitedAt:new Date(at)}});
    const returned=await join(token);assert.equal(returned.status,409);assert.equal((await returned.json()).code,'CHALLENGE_FORFEITED');
    assert.equal(await prisma.seededChallengeTransfer.count(),0);
  });

  for(const provider of ['apple','google']) it(`${provider} signup immediately enters both current challenges and commits next intents with once-only welcome boxes`,async()=>{
    await prisma.raceSeed.updateMany({data:{powerupsEnabled:true}});
    const identityToken=`immediate-signup-${randomUUID()}`;
    const signed=await request(server.baseUrl,'POST',`/auth/${provider}`,{headers:HEADERS,body:provider==='apple'?{identityToken}:{idToken:identityToken}});
    assert.equal(signed.status,200,await signed.clone().text());const auth=await signed.json();
    const entries=await prisma.raceParticipant.findMany({where:{userId:auth.user.id,status:'ACCEPTED'},include:{race:true}});
    assert.equal(entries.filter(p=>p.race.status==='ACTIVE').length,2);
    assert.ok(entries.every(p=>p.joinedAt.toISOString()===new Date(at).toISOString()));
    assert.equal(await prisma.seededChallengeEnrollmentRequest.count({where:{userId:auth.user.id}}),4);
    assert.equal(await prisma.onboardingBoxGrant.count(),1);
    const again=await join(auth.sessionToken);assert.equal(again.status,200);
    assert.equal(await prisma.onboardingBoxGrant.count(),1);
  });

  for (const interval of ['five-minute','hourly']) it(`${interval} sample crossing Join is proportioned through HTTP sync, worker, progress and settlement`,async()=>{
    await prisma.raceSeed.updateMany({data:{powerupsEnabled:false,timeBased:true}});
    const {token,user}=await createTestUser();
    at=interval==='hourly'?'2026-09-09T16:30:00Z':'2026-09-09T16:02:30Z';
    const sample=interval==='hourly'
      ? {periodStart:'2026-09-09T16:00:00Z',periodEnd:'2026-09-09T17:00:00Z',steps:6000}
      : {periodStart:'2026-09-09T16:00:00Z',periodEnd:'2026-09-09T16:05:00Z',steps:1000};
    const pre=await request(server.baseUrl,'POST','/steps/samples',{token,body:{samples:[{periodStart:'2026-09-09T15:00:00Z',periodEnd:'2026-09-09T16:00:00Z',steps:4000}]}});
    assert.equal(pre.status,200,await pre.clone().text());
    const joined=await join(token);assert.equal(joined.status,200);const entry=await joined.json();
    at='2026-09-09T18:00:00Z';
    const synced=await request(server.baseUrl,'POST','/steps/sync-v2',{token,headers:{...HEADERS,'Idempotency-Key':randomUUID()},body:{date:'2026-09-09',steps:10000,samples:[sample]}});
    assert.equal(synced.status,202,await synced.clone().text());
    const worker=buildRaceResolutionWorkerV2({prisma,now:()=>new Date(at),processRole:'all',logger:{log(){},error(){},warn(){}}});
    await worker.processRace({raceId:entry.raceId});
    const expected=interval==='hourly'?3000:500;
    const progress=await request(server.baseUrl,'GET',`/races/${entry.raceId}/progress`,{token,headers:HEADERS}).then(r=>r.json());
    assert.equal(progress.progress.participants.find(p=>p.userId===user.id).totalSteps,expected);
    at='2026-09-10T04:01:00Z';
    // A late authoritative correction wakes the real resolution queue. The
    // worker crosses the stored race deadline and settles using the same join.
    const corrected=await request(server.baseUrl,'POST','/steps/samples',{token,headers:HEADERS,body:{samples:[{...sample,steps:sample.steps+200}]}});
    assert.equal(corrected.status,200);
    const settlementResult=await worker.processRace({raceId:entry.raceId});
    await buildRaceExpiryRunner({now:()=>new Date(at),logger:{log(){}}})();
    const detail=await request(server.baseUrl,'GET',`/races/${entry.raceId}`,{token,headers:HEADERS});assert.equal(detail.status,200);
    const race=await detail.json();
    assert.equal(race.status,'COMPLETED',JSON.stringify(settlementResult));
    assert.equal(race.participants.find(p=>p.userId===user.id).totalSteps,expected+100);
  });

  it('concurrent identical receipts roll back every provisional loser shell',async()=>{
    const {token,user}=await createTestUser();const requestId=randomUUID();
    const responses=await Promise.all(Array.from({length:8},()=>join(token,'DAILY_10K',{requestId})));
    for(const response of responses)assert.equal(response.status,200,await response.clone().text());
    assert.equal(await prisma.race.count(),1);
    assert.equal(await prisma.raceParticipant.count({where:{userId:user.id}}),1);
    assert.equal(await prisma.seededChallengeJoinReceipt.count({where:{userId:user.id}}),1);
  });

  it('a pruned full prepared group transfers only the returning empty slot and preserves declined history',async()=>{
    const account=await createTestUser();const originalResponse=await join(account.token);assert.equal(originalResponse.status,200);const original=await originalResponse.json();
    const originalRace=await prisma.race.findUnique({where:{id:original.raceId}});
    const prep=await prisma.seededChallengePreparation.create({data:{seedId:originalRace.seedId,windowStart:new Date(original.windowStart),windowEnd:new Date(original.windowEnd),generation:randomUUID(),state:'COMPLETE',notBeforeAt:new Date(original.windowStart),publishedAt:new Date(original.windowStart)}});
    const group=await prisma.seededChallengePreparationGroup.create({data:{preparationId:prep.id,generation:prep.generation,ordinal:0,reservedRaceId:original.raceId,reservedBucketId:originalRace.seededBucketId,members:[{userId:account.user.id,matchSteps:0}],state:'MATERIALIZED'}});
    await prisma.seededRaceWindowMembership.updateMany({where:{userId:account.user.id},data:{preparationGroupId:group.id,admissionSource:'AUTOMATIC'}});
    await prisma.raceParticipant.update({where:{id:original.participantId},data:{status:'DECLINED'}});
    await prisma.seededRaceBucketAssignment.updateMany({where:{raceParticipantId:original.participantId},data:{state:'PRUNED'}});
    for(let i=0;i<35;i++){const other=await createTestUser();assert.equal((await join(other.token)).status,200);}
    at='2026-09-09T19:00:00Z';const response=await join(account.token);assert.equal(response.status,200,await response.clone().text());const returned=await response.json();
    assert.notEqual(returned.raceId,original.raceId);assert.equal(returned.joinedAt,new Date(at).toISOString());
    assert.equal((await prisma.raceParticipant.findUnique({where:{id:original.participantId}})).status,'DECLINED');
    assert.equal(await prisma.raceParticipant.count({where:{raceId:original.raceId,status:'ACCEPTED'}}),35);
    const audit=await prisma.seededChallengeTransfer.findFirst({where:{userId:account.user.id}});assert.equal(audit.oldParticipantId,original.participantId);assert.equal(audit.newParticipantId,returned.participantId);
  });

  it('an empty current window still offers both challenges before any group exists', async () => {
    const {token}=await createTestUser({autoJoinFeaturedRaces:false});
    const response=await request(server.baseUrl,'GET','/races/featured',{token,headers:HEADERS});
    assert.equal(response.status,200);const body=await response.json();
    for(const kind of ['DAILY_10K','WEEKLY_50K']){
      const card=body.races.find(row=>row.seedKind===kind);assert.ok(card,kind);
      assert.equal(card.currentJoin.state,'JOINABLE');assert.equal(card.currentJoin.raceId,null);
    }
    assert.equal(await prisma.race.count(),0);
  });
  for (const [instant,start,end] of [
    ['2026-03-08T16:00:00Z','2026-03-08T05:00:00.000Z','2026-03-09T04:00:00.000Z'],
    ['2026-11-01T17:00:00Z','2026-11-01T04:00:00.000Z','2026-11-02T05:00:00.000Z'],
  ]) it(`daily Join preserves the actual ET DST window at ${instant}`,async()=>{
    at=instant;const {token}=await createTestUser();const response=await join(token);
    assert.equal(response.status,200);const body=await response.json();
    assert.equal(body.windowStart,start);assert.equal(body.windowEnd,end);assert.equal(body.scoringStartsAt,new Date(instant).toISOString());
  });

  it('signup crossing midnight keeps its four captured intentions and begins the new daily window at its boundary',async()=>{
    let calls=0;
    const crossed=await startServer({now:()=>new Date(calls++===0?'2026-09-10T03:59:59Z':'2026-09-10T04:00:01Z'),verifyAppleIdentityToken:async token=>({sub:token,email:`${token}@example.com`})});
    try{
      const response=await request(crossed.baseUrl,'POST','/auth/apple',{headers:HEADERS,body:{identityToken:`cross-${randomUUID()}`}});
      assert.equal(response.status,200,await response.clone().text());const auth=await response.json();
      const intents=await prisma.seededChallengeEnrollmentRequest.findMany({where:{userId:auth.user.id}});
      assert.equal(intents.length,4);assert.ok(intents.every(row=>row.requestedAt.toISOString()==='2026-09-10T03:59:59.000Z'));
      const daily=await prisma.raceParticipant.findFirst({where:{userId:auth.user.id,race:{seedId:'seed-daily-10k'}}});
      assert.ok(daily);assert.equal(daily.joinedAt.toISOString(),'2026-09-10T04:00:00.000Z');
    }finally{await crossed.close();}
  });

  it('a Join waiting on the window guard retries into the new day after midnight',async()=>{
    at='2026-09-10T03:59:59Z';const account=await createTestUser();
    let release, locked;
    const held=new Promise(resolve=>{release=resolve;});const ready=new Promise(resolve=>{locked=resolve;});
    const blocker=prisma.$transaction(async tx=>{
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))','seeded-bucket:seed-daily-10k:2026-09-09T04:00:00.000Z');
      locked();await held;
    },{timeout:5000});
    await ready;const pending=join(account.token);
    try{
      let waiting=false;
      for(let i=0;i<50&&!waiting;i++){
        const rows=await prisma.$queryRawUnsafe("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' LIMIT 1");
        waiting=rows.length>0;if(!waiting)await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal(waiting,true);at='2026-09-10T04:00:01Z';
    }finally{release();await blocker;}
    const response=await pending;assert.equal(response.status,200,await response.clone().text());const body=await response.json();
    assert.equal(body.windowStart,'2026-09-10T04:00:00.000Z');assert.equal(body.joinedAt,'2026-09-10T04:00:01.000Z');
    assert.equal(await prisma.race.count(),1);assert.equal(await prisma.seededRaceWindowMembership.count({where:{userId:account.user.id}}),1);
  });

});
