const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { describe, it, before, beforeEach, after, afterEach } = require('node:test');
const { cleanDatabase, createTestUser, startServer, prisma, request } = require('./setup');
const { scheduleSeededChallengePreparation } = require('../../src/modules/races/jobs/seededChallengePreparation');
const { buildRaceResolutionWorkerV2 } = require('../../src/modules/races/jobs/raceResolutionQueueV2');
const HEADERS = { 'X-Client-Features': 'seeded_race_buckets' };
describe('durable signup recovery through production scheduler and worker', () => {
  let server, clock, scheduler;
  let priorSeeds = [];
  before(async () => {
    server = await startServer({ now: () => new Date(clock),
      verifyAppleIdentityToken: async token => ({ sub: token, email: `${token}@example.com` }),
      // Simulate loss of the best-effort postcommit signup side effect. The
      // actual provisioning transaction must still durably accept intentions.
      autoEnrollNewUser: async () => {},
    });
  });
  after(async () => { scheduler?.stop(); await server.close(); });
  beforeEach(async () => {
    scheduler?.stop(); await cleanDatabase(); await prisma.onboardingBoxGrant.deleteMany(); clock = '2026-09-09T16:00:00Z';
    // cleanDatabase intentionally retains the catalog. Prior suites may leave
    // active custom seeds; this scenario owns the two canonical challenges.
    priorSeeds = await prisma.raceSeed.findMany({ select: { id: true, active: true, powerupsEnabled: true, updatedAt: true } });
    await prisma.raceSeed.updateMany({ where: { id: { notIn: ['seed-daily-10k', 'seed-weekly-50k'] } }, data: { active: false } });
    await prisma.raceSeed.updateMany({ where: { id: { in: ['seed-daily-10k', 'seed-weekly-50k'] } }, data: { active: true } });
    scheduler = scheduleSeededChallengePreparation({ prisma, now: () => new Date(clock),
      setInterval: () => ({ unref() {} }), clearInterval() {}, startImmediately: false,
      logger: { log() {}, error() {} }, processRole: 'cron', instance: '0' });
  });
  afterEach(async () => {
    scheduler?.stop();
    await prisma.$transaction(priorSeeds.map(({ id, ...data }) => prisma.raceSeed.update({ where: { id }, data })));
  });
  for (const mode of ['LEGACY', 'BUCKET']) it(`${mode}: late signup recovery preserves requested scoring time and enrolls the event active at that time`, async () => {
    if (mode === 'BUCKET') await prisma.seededRaceWindowModeRecord.createMany({data:[{seedId:'seed-daily-10k',windowStart:new Date('2026-09-09T04:00:00Z'),windowEnd:new Date('2026-09-10T04:00:00Z'),mode},{seedId:'seed-weekly-50k',windowStart:new Date('2026-09-07T04:00:00Z'),windowEnd:new Date('2026-09-14T04:00:00Z'),mode}]});
    await prisma.raceSeed.updateMany({data:{powerupsEnabled:true}});
    const event = await prisma.globalStepEvent.create({ data: { startsAt: new Date('2026-09-09T15:00:00Z'), endsAt: new Date('2026-09-09T17:00:00Z'), multiplier: 2, summaryAttributionVersion: 2 } });
    const signed = await request(server.baseUrl, 'POST', '/auth/apple', { headers: HEADERS, body: { identityToken: `recover-${randomUUID()}` } });
    assert.equal(signed.status, 200, await signed.clone().text()); const auth = await signed.json();
    assert.equal(await prisma.seededChallengeEnrollmentRequest.count({ where: { userId: auth.user.id, source: 'SIGNUP' } }), 4);
    assert.equal(await prisma.raceParticipant.count({ where: { userId: auth.user.id } }), 0);
    clock = '2026-09-09T16:10:00Z';
    for (let i = 0; i < 4; i++) await scheduler.runNow();
    const groups = await prisma.seededChallengePreparationGroup.findMany();
    const worker = buildRaceResolutionWorkerV2({ prisma, now: () => new Date(clock), processRole: 'all', logger: { log() {}, error() {}, warn() {} } });
    for (const group of groups) await worker.processRace({ raceId: group.reservedRaceId });
    const entries = await prisma.raceParticipant.findMany({ where: { userId: auth.user.id, status: 'ACCEPTED', race: { status: 'ACTIVE' } } });
    assert.equal(entries.length, 2);
    assert.equal(await prisma.onboardingBoxGrant.count(),1);
    assert.equal(await prisma.racePowerup.count({where:{userId:auth.user.id,status:'MYSTERY_BOX'}}),3);
    for(const entry of entries) await worker.processRace({raceId:entry.raceId});
    assert.equal(await prisma.racePowerup.count({where:{userId:auth.user.id,status:'MYSTERY_BOX'}}),3);
    for (const entry of entries) {
      const detail = await request(server.baseUrl, 'GET', `/races/${entry.raceId}`, { token: auth.sessionToken, headers: HEADERS });
      assert.equal(detail.status, 200); const race = await detail.json();
      assert.equal(new Date(race.participants.find(p => p.userId === auth.user.id).joinedAt).toISOString(), '2026-09-09T16:00:00.000Z');
      assert.equal(await prisma.globalEventRaceImpact.count({ where: { eventId: event.id, raceId: entry.raceId, userId: auth.user.id } }), 1);
    }
  });
  it('retention deletes at most 500 expired receipts per tick and retains fresh receipts and incomplete intents', async () => {
    const signed = await request(server.baseUrl, 'POST', '/auth/apple', { body: { identityToken: `retention-${randomUUID()}` } });
    assert.equal(signed.status, 200); const auth = await signed.json();
    await prisma.seededChallengeEnrollmentRequest.deleteMany({where:{userId:auth.user.id}});
    await prisma.jobRun.deleteMany({where:{jobName:'seeded_challenge_receipt_retention'}});
    const oldEnd = new Date('2026-08-01T04:00:00Z');
    await prisma.seededChallengeJoinReceipt.createMany({data:Array.from({length:501},()=>({userId:auth.user.id,requestId:randomUUID(),seedId:'seed-daily-10k',windowStart:new Date('2026-07-31T04:00:00Z'),windowEnd:oldEnd,raceId:randomUUID(),participantId:randomUUID(),joinedAt:new Date('2026-07-31T12:00:00Z')}))});
    const fresh = await prisma.seededChallengeJoinReceipt.create({data:{userId:auth.user.id,requestId:randomUUID(),seedId:'seed-daily-10k',windowStart:new Date('2026-09-01T04:00:00Z'),windowEnd:new Date('2026-09-02T04:00:00Z'),raceId:randomUUID(),participantId:randomUUID(),joinedAt:new Date('2026-09-01T12:00:00Z')}});
    const incomplete = await prisma.seededChallengeEnrollmentRequest.create({data:{userId:auth.user.id,seedId:'seed-daily-10k',windowStart:new Date('2026-07-31T04:00:00Z'),windowEnd:oldEnd,source:'PREFERENCE',requestedAt:new Date('2026-07-30T12:00:00Z'),availableAt:new Date('2027-01-01T00:00:00Z')}});
    clock = '2026-09-10T07:01:00Z';
    await scheduler.runNow();
    assert.equal(await prisma.seededChallengeJoinReceipt.count(),2);
    assert.ok(await prisma.seededChallengeEnrollmentRequest.findUnique({where:{id:incomplete.id}}));
    await scheduler.runNow();
    assert.equal(await prisma.seededChallengeJoinReceipt.count(),1);
    assert.ok(await prisma.seededChallengeJoinReceipt.findUnique({where:{id:fresh.id}}));
    assert.equal((await prisma.seededChallengeEnrollmentRequest.findUnique({where:{id:incomplete.id}})).state,'PENDING');
  });

  it('weekly inactivity maintenance keeps an explicit current Join while pruning the equivalent automatic empty member',async()=>{
    const manual=await createTestUser({createdAt:new Date('2026-08-01T00:00:00Z'),autoJoinFeaturedRaces:false});
    const automatic=await createTestUser({createdAt:new Date('2026-08-01T00:00:00Z'),autoJoinFeaturedRaces:false});
    async function join(account){const response=await request(server.baseUrl,'POST','/races/seeded/WEEKLY_50K/join-current',{token:account.token,headers:HEADERS,body:{requestId:randomUUID()}});assert.equal(response.status,200);return response.json();}
    const first=await join(manual);const second=await join(automatic);assert.equal(first.raceId,second.raceId);
    await prisma.seededRaceWindowMembership.updateMany({where:{userId:automatic.user.id},data:{admissionSource:'AUTOMATIC',manualJoinedAt:null}});
    scheduler.stop();scheduler=scheduleSeededChallengePreparation({prisma,now:()=>new Date(clock),appSettings:{getFlag:async key=>key==='seededInactivityPruneEnabled'},setInterval:()=>({unref(){}}),clearInterval(){},startImmediately:false,logger:{log(){},error(){}},processRole:'cron',instance:'0'});
    await scheduler.runNow();
    const detail=await request(server.baseUrl,'GET',`/races/${first.raceId}`,{token:manual.token,headers:HEADERS});assert.equal(detail.status,200);
    const race=await detail.json();assert.equal(race.participants.find(p=>p.userId===manual.user.id).status,'ACCEPTED');
    assert.equal((await prisma.raceParticipant.findUnique({where:{id:second.participantId}})).status,'DECLINED');
  });

  for(const recovery of ['same-window','later-window','discard']) it(`${recovery}: lost signup side effect followed by manual Join delivers all welcome boxes as inventory space becomes available`,async()=>{
    await prisma.raceSeed.updateMany({data:{powerupsEnabled:true}});
    const signed=await request(server.baseUrl,'POST','/auth/apple',{headers:HEADERS,body:{identityToken:`partial-gift-${randomUUID()}`}});assert.equal(signed.status,200);const auth=await signed.json();
    const response=await request(server.baseUrl,'POST','/races/seeded/DAILY_10K/join-current',{token:auth.sessionToken,headers:HEADERS,body:{requestId:randomUUID()}});assert.equal(response.status,200);const joined=await response.json();
    const held=await prisma.racePowerup.create({data:{raceId:joined.raceId,participantId:joined.participantId,userId:auth.user.id,type:'RUNNERS_HIGH',rarity:'UNCOMMON',status:'HELD',earnedAtSteps:90000}});
    const worker=buildRaceResolutionWorkerV2({prisma,bootAt:0,now:()=>new Date(clock),processRole:'all',logger:{log(){},error(){},warn(){}}});
    await worker.processRace({raceId:joined.raceId});
    assert.equal(await prisma.racePowerup.count({where:{userId:auth.user.id,status:'MYSTERY_BOX'}}),2);
    let ledger=await prisma.onboardingBoxGrant.findFirst();assert.equal(ledger.targetBoxCount,3);assert.equal(ledger.grantedBoxCount,2);
    let recoveryRaceId=joined.raceId;
    if(recovery==='later-window'){
      // The original enrollment intention can be retained/cleaned independently
      // after its accepted windows expire; the human gift balance stays durable.
      await prisma.seededChallengeEnrollmentRequest.deleteMany({where:{userId:auth.user.id}});
      clock='2026-09-25T16:00:00Z';
      const later=await request(server.baseUrl,'POST','/races/seeded/DAILY_10K/join-current',{token:auth.sessionToken,headers:HEADERS,body:{requestId:randomUUID()}});assert.equal(later.status,200);recoveryRaceId=(await later.json()).raceId;
    }else if(recovery==='discard'){
      const discarded=await request(server.baseUrl,'POST',`/races/${joined.raceId}/powerups/${held.id}/discard`,{token:auth.sessionToken,headers:HEADERS,body:{}});assert.equal(discarded.status,200,await discarded.clone().text());
    }else{
      const used=await request(server.baseUrl,'POST',`/races/${joined.raceId}/powerups/${held.id}/use`,{token:auth.sessionToken,headers:HEADERS,body:{}});assert.equal(used.status,200,await used.clone().text());
    }
    if(recovery==='discard'){clock=new Date(new Date(clock).getTime()+10000).toISOString();assert.ok(await worker.tick()>0);await worker.tick();}
    else{await worker.processRace({raceId:recoveryRaceId});await worker.processRace({raceId:recoveryRaceId});}
    assert.equal(await prisma.racePowerup.count({where:{userId:auth.user.id,status:'MYSTERY_BOX'}}),3);
    ledger=await prisma.onboardingBoxGrant.findFirst();assert.equal(ledger.grantedBoxCount,3);
  });

});
