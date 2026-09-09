const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { describe, it, before, beforeEach, after } = require('node:test');
const { cleanDatabase, createTestUser, startServer, prisma, request } = require('./setup');
const { buildRaceResolutionWorkerV2 } = require('../../src/modules/races/jobs/raceResolutionQueueV2');
const { buildRaceExpiryRunner } = require('../../src/modules/races/jobs/raceExpiry');
const HEADERS = { 'X-Client-Features': 'seeded_race_buckets,powerups3,powerups4,powerups5' };
describe('current Join preserves scoring, effects and box boundaries', () => {
  let server, clock;
  before(async () => { server = await startServer({ now: () => new Date(clock) }); });
  after(async () => server.close());
  beforeEach(async () => { await cleanDatabase(); clock = '2026-09-09T16:30:00Z'; await prisma.raceSeed.updateMany({data:{powerupsEnabled:true,timeBased:true}}); });
  const worker = () => buildRaceResolutionWorkerV2({prisma,now:()=>new Date(clock),processRole:'all',logger:{log(){},error(){},warn(){}}});
  async function join(account,kind){const response=await request(server.baseUrl,'POST',`/races/seeded/${kind}/join-current`,{token:account.token,headers:HEADERS,body:{requestId:randomUUID()}});assert.equal(response.status,200,await response.clone().text());return response.json();}
  async function sync(account,steps,samples){const response=await request(server.baseUrl,'POST','/steps/sync-v2',{token:account.token,headers:{...HEADERS,'Idempotency-Key':randomUUID()},body:{date:'2026-09-09',steps,samples:samples||[]}});assert.equal(response.status,202,await response.clone().text());}
  async function progress(account,raceId){const response=await request(server.baseUrl,'GET',`/races/${raceId}/progress`,{token:account.token,headers:HEADERS});assert.equal(response.status,200);return (await response.json()).progress;}
  it('HTTP step sync processes its queued score without a seeded membership probe', async () => {
    const account = await createTestUser({ autoJoinFeaturedRaces: false });
    const joined = await join(account, 'DAILY_10K');
    const queuedWorker = buildRaceResolutionWorkerV2({ prisma, bootAt: 0, now: () => new Date(clock), processRole: 'all', logger: { log() {}, error() {}, warn() {} } });
    clock = '2026-09-09T16:31:00Z';
    await queuedWorker.tick();
    clock = '2026-09-09T16:32:00Z';
    await queuedWorker.tick();
    const originalQueryRaw = prisma.$queryRaw;
    let membershipProbes = 0;
    prisma.$queryRaw = function (...args) {
      const sql = Array.isArray(args[0]) ? args[0].join('?') : String(args[0]?.sql || args[0]);
      if (sql.includes('FROM seeded_challenge_preparation_groups g JOIN races')) membershipProbes += 1;
      return originalQueryRaw.apply(this, args);
    };
    try {
      clock = '2026-09-09T16:40:00Z';
      await sync(account, 100, [{ periodStart: '2026-09-09T16:35:00Z', periodEnd: '2026-09-09T16:40:00Z', steps: 100 }]);
      const queued = await prisma.raceResolutionJobV2.findUnique({ where: { raceId: joined.raceId } });
      assert.ok(queued.dirtyReasons.length > 0);
      assert.ok(queued.dirtyReasons.every(reason => ['STEP_SYNC', 'STEP_INPUT_CHANGED'].includes(reason)), JSON.stringify(queued.dirtyReasons));
      clock = new Date(Math.max(new Date(clock).getTime(), new Date(queued.requestedAt).getTime()) + 60000).toISOString();
      const scoreWorker = buildRaceResolutionWorkerV2({ prisma, bootAt: 0, now: () => new Date(clock), processRole: 'all', logger: { log() {}, error() {}, warn() {} } });
      const tickResult = await scoreWorker.tick();
      assert.ok(tickResult > 0, JSON.stringify({ queued, tickResult }));
      assert.equal((await progress(account, joined.raceId)).participants.find(row => row.userId === account.user.id).totalSteps, 100);
      assert.equal(membershipProbes, 0);
    } finally { prisma.$queryRaw = originalQueryRaw; }
  });
  for(const kind of ['DAILY_10K','WEEKLY_50K']) it(`${kind}: daily-only sync never credits an unknowable pre-join day`,async()=>{
    const account=await createTestUser({autoJoinFeaturedRaces:false});
    await sync(account,10000);const joined=await join(account,kind);
    clock='2026-09-09T18:00:00Z';await sync(account,12000);await worker().processRace({raceId:joined.raceId});
    assert.equal((await progress(account,joined.raceId)).participants.find(p=>p.userId===account.user.id).totalSteps,0);
    assert.equal(await prisma.racePowerup.count({where:{userId:account.user.id,status:'MYSTERY_BOX'}}),0);
  });
  for(const kind of ['DAILY_10K','WEEKLY_50K']) it(`${kind}: buff, leech and mystery boxes count only the post-join half of a sample through settlement`,async()=>{
    const alice=await createTestUser({autoJoinFeaturedRaces:false});const bob=await createTestUser({autoJoinFeaturedRaces:false});
    for(const account of [alice,bob])await sync(account,6000,[{periodStart:'2026-09-09T15:00:00Z',periodEnd:'2026-09-09T16:00:00Z',steps:6000}]);
    const joined=await join(alice,kind);const other=await join(bob,kind);assert.equal(other.raceId,joined.raceId);
    for(const [index,type] of ['RUNNERS_HIGH','LEECH'].entries()){
      const held=await prisma.racePowerup.create({data:{raceId:joined.raceId,participantId:joined.participantId,userId:alice.user.id,type,rarity:'UNCOMMON',status:'HELD',earnedAtSteps:90000+index}});
      const used=await request(server.baseUrl,'POST',`/races/${joined.raceId}/powerups/${held.id}/use`,{token:alice.token,headers:HEADERS,body:type==='LEECH'?{targetUserId:bob.user.id}:{}});
      assert.equal(used.status,200,await used.clone().text());
    }
    clock='2026-09-09T18:00:00Z';
    for(const account of [alice,bob])await sync(account,12000,[{periodStart:'2026-09-09T16:00:00Z',periodEnd:'2026-09-09T17:00:00Z',steps:6000}]);
    await worker().processRace({raceId:joined.raceId});
    const board=await progress(alice,joined.raceId);
    const home=await request(server.baseUrl,'GET','/home/race-card?homeActiveRaces=1&homePersistedTotals=1',{token:alice.token,headers:HEADERS});assert.equal(home.status,200);
    const homeRace=(await home.json()).data.races.find(row=>row.raceId===joined.raceId);assert.ok(homeRace);assert.equal(homeRace.top3.find(row=>row.userId===alice.user.id).totalSteps,7500);
    assert.equal(board.participants.find(p=>p.userId===alice.user.id).totalSteps,7500);
    assert.equal(board.participants.find(p=>p.userId===bob.user.id).totalSteps,1500);
    assert.equal(await prisma.racePowerup.count({where:{userId:alice.user.id,raceId:joined.raceId,status:'MYSTERY_BOX'}}),1);
    assert.equal((await prisma.raceParticipant.findUnique({where:{id:joined.participantId}})).nextBoxAtSteps,4000);
    clock=new Date(new Date(joined.windowEnd).getTime()+60000).toISOString();
    await buildRaceExpiryRunner({now:()=>new Date(clock),logger:{log(){}}})();
    const response=await request(server.baseUrl,'GET',`/races/${joined.raceId}`,{token:alice.token,headers:HEADERS});assert.equal(response.status,200);const race=await response.json();
    assert.equal(race.status,'COMPLETED');assert.equal(race.participants.find(p=>p.userId===alice.user.id).totalSteps,7500);assert.equal(race.participants.find(p=>p.userId===bob.user.id).totalSteps,1500);
  });
});
