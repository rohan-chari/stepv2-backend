const assert = require('node:assert/strict');
const {describe,it,before,beforeEach}=require('node:test');
process.env.PRISMA_QUERY_EVENTS_ENABLED='true';
const {cleanDatabase,prisma,request,getSharedServer,createTestUser}=require('./setup');
// Settlement is worker-owned with no HTTP trigger: exercise the real scheduled
// entrypoint, then assert only public HTTP result/balance views plus SQL metrics.
const {resolveExpiredRaces}=require('../../src/modules/races/jobs/raceExpiry');
const HEADERS={'X-Client-Features':'characters,team_races,team_races_10v10_v1,race_participants_paging,race_leave'};
let server,queries=null;
async function get(actor,path,headers=HEADERS){
 const r=await request(server.baseUrl,'GET',path,{token:actor.token,headers});
 const body=await r.json();assert.equal(r.status,200,JSON.stringify(body));return body;
}
describe('10v10 settlement public results and worker cost',()=>{
 before(async()=>{server=await getSharedServer();prisma.$on('query',event=>{if(queries)queries.push(event.query);});});
 beforeEach(cleanDatabase);
 for(const size of [5,10])for(const tie of [false,true])it(`${size}v${size} ${tie?'tie':'win'} pays every eligible member once and exposes full final roster`,async()=>{
  const actors=[];
  for(let i=0;i<2*size;i++)actors.push(await createTestUser());
  const startedAt=new Date(Date.now()-7*86400000),finishedAt=new Date(Date.now()-120000);
  const race=await prisma.race.create({data:{name:'Large settlement fixture',creatorId:actors[0].user.id,targetSteps:0,status:'ACTIVE',isPublic:true,timeBased:true,maxParticipants:size*2,maxDurationDays:7,payoutPreset:'WINNER_TAKES_ALL',fundedPrize:true,prizeCalculationVersion:2,prizeCoinUnit:10,prizePoolMaxCoins:8000,payoutRoundingVersion:1,isTeamRace:true,teamSize:size,teamAName:'Alpha',teamBName:'Bravo',teamPoolMultBps:15000,teamPayoutVersion:1,teamWinnerRewardCoins:500,startedAt,endsAt:new Date(Date.now()-60000)}});
  await prisma.raceParticipant.createMany({data:actors.map((a,i)=>({raceId:race.id,userId:a.user.id,status:'ACCEPTED',team:i<size?'TEAM_A':'TEAM_B',totalSteps:tie||i<size?1000:100,rawSteps:tie||i<size?1000:100,finishTotalSteps:tie||i<size?1000:100,finishedAt,joinedAt:startedAt}))});
  queries=[];const begin=performance.now();await resolveExpiredRaces();const elapsedMs=performance.now()-begin;const measured=queries;queries=null;
  const sql={SELECT:0,INSERT:0,UPDATE:0,DELETE:0,OTHER:0};for(const q of measured){const kind=q.trim().match(/^(SELECT|INSERT|UPDATE|DELETE)\b/i)?.[1]?.toUpperCase()||'OTHER';sql[kind]++;}
  console.log('TEAM10_SETTLEMENT_METRIC',JSON.stringify({size,tie,elapsedMs:Number(elapsedMs.toFixed(2)),queries:measured.length,sql,coinWrites:measured.filter(q=>/INSERT INTO "(?:public"\.")?coin_transactions"/.test(q)).length}));
  const detail=await get(actors[0],`/races/${race.id}?view=participants-v1&limit=1`);
  assert.equal(detail.status,'COMPLETED');assert.equal(detail.winnerTeam,tie?null:'TEAM_A');
  assert.equal(detail.teamRosterComplete,true);assert.equal(detail.teamAcceptedParticipants.length,size*2);
  assert.equal(detail.teamPayoutVersion,1);assert.equal(detail.teamWinnerRewardCoins,500);
  assert.equal(detail.prizePool.coins,size*500);
  for(let i=0;i<actors.length;i++){
    const me=await get(actors[i],'/auth/me');
    assert.equal((me.user||me).coins,tie?250:i<size?500:0,JSON.stringify(me));
  }
  const progress=(await get(actors[0],`/races/${race.id}/progress?view=participants-v1&limit=1`)).progress;
  assert.equal(progress.participants.length,size*2);assert.equal(progress.prizePool.coins,size*500);
  assert.equal(progress.teams.teamA.totalSteps,size*1000);assert.equal(progress.teams.teamB.totalSteps,size*(tie?1000:100));
  await resolveExpiredRaces();
  for(let i=0;i<actors.length;i++)assert.equal(((await get(actors[i],'/auth/me')).user||{}).coins,tie?250:i<size?500:0);
  const legacy=await get(actors[0],'/races',{'X-Client-Features':'characters,team_races,race_leave'});
  assert.ok(legacy.completed.some(r=>r.id===race.id),'downgrade keeps earned result card');
 });
});
