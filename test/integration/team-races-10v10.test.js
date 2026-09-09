const assert = require('node:assert/strict');
const { describe, it, before, beforeEach } = require('node:test');
const { cleanDatabase, prisma, request, getSharedServer, createTestUser } = require('./setup');
const NEW = { 'X-Client-Features': 'team_races,team_races_10v10_v1,characters,race_participants_paging,race_preview,race_leave,next_race_v1' };
const OLD = { 'X-Client-Features': 'team_races,characters,race_participants_paging,race_leave' };
let server;
async function call(actor, method, path, body, headers = NEW) {
  const res = await request(server.baseUrl, method, path, { token: actor.token, headers, body });
  return { status: res.status, body: await res.json() };
}
async function create(actor, teamSize = 10, headers = NEW) {
  return call(actor, 'POST', '/races', { name:'Large Team Race', maxDurationDays:7, isPublic:true, isTeamRace:true, teamSize }, headers);
}
async function fixture(teamSize = 10, accepted = 20, invited = 0) {
  const actors = [];
  for(let i=0;i<accepted+invited;i++) actors.push(await createTestUser());
  const race = await prisma.race.create({data:{name:'Large Team Fixture',creatorId:actors[0].user.id,isTeamRace:true,teamSize,maxParticipants:teamSize*2,teamAName:'Alpha',teamBName:'Bravo',isPublic:true,status:'PENDING',maxDurationDays:7,targetSteps:0,timeBased:true}});
  await prisma.raceParticipant.createMany({data:actors.map((a,i)=>({raceId:race.id,userId:a.user.id,status:i<accepted?'ACCEPTED':'INVITED',team:i<accepted?(i%2?'TEAM_B':'TEAM_A'):null,joinedAt:new Date(Date.now()+(i<accepted?1000:0)),totalSteps:i+1}))});
  return {race,actors};
}
describe('10v10 binary compatibility and complete accepted rosters',()=>{
  before(async()=>{server=await getSharedServer();});
  beforeEach(async()=>{
    await cleanDatabase();
    await prisma.appSetting.upsert({where:{key:'apiRaceBootstrapV1Enabled'},create:{key:'apiRaceBootstrapV1Enabled',value:true},update:{value:true}});
    require('../../src/shared/config/appSettings').appSettings.bustCache();
  });
  it('accepts every integer capacity 1..10 for supported binaries and derives total capacity',async()=>{
    for(let size=1;size<=10;size++){
      const actor=await createTestUser();
      const response=await create(actor,size);
      assert.equal(response.status,201,JSON.stringify(response.body));
      assert.equal(response.body.race.teamSize,size);
      assert.equal(response.body.race.maxParticipants,size*2);
    }
  });
  it('rejects malformed/invalid capacities and legacy 6..10 without creating races',async()=>{
    const actor=await createTestUser();
    for(const value of [0,11,-1,1.5,'10',null]) assert.equal((await create(actor,value)).status,400);
    for(const size of [6,10]){
      const response=await create(actor,size,OLD);
      assert.equal(response.status,400);
      assert.equal(response.body.code,'UPDATE_REQUIRED');
    }
    assert.equal(await prisma.race.count({where:{creatorId:actor.user.id}}),0);
  });
  it('details and pending bootstrap return all20 accepted independently of30 earlier invitation rows and page offset',async()=>{
    const {race,actors}=await fixture(10,20,30);
    for(const path of [`/races/${race.id}?view=participants-v1&offset=10&limit=5`,`/races/${race.id}/bootstrap?view=participants-v1&offset=10&limit=5`]){
      const response=await call(actors[0],'GET',path);
      assert.equal(response.status,200,JSON.stringify(response.body));
      const detail=response.body.race||response.body;
      assert.equal(detail.teamRosterComplete,true);
      assert.equal(detail.teamAcceptedParticipants.length,20);
      assert.equal(detail.participants.length,5);
      assert.equal(detail.acceptedCount,20);
      assert.equal(detail.teamAAcceptedCount,10);
      assert.equal(detail.teamBAcceptedCount,10);
      assert.equal(new Set(detail.teamAcceptedParticipants.map(p=>p.userId)).size,20);
      assert.ok(detail.teamAcceptedParticipants.every(p=>p.status==='ACCEPTED'));
    }
  });
  it('blocks downgraded direct reads and join while preserving memberships',async()=>{
    const {race,actors}=await fixture(10,2);
    const outsider=await createTestUser();
    for(const path of [`/races/${race.id}`,`/races/${race.id}/bootstrap`,`/races/${race.id}/progress`]){
      const response=await call(actors[0],'GET',path,undefined,OLD);
      assert.equal(response.status,400,JSON.stringify(response.body));
      assert.equal(response.body.code,'UPDATE_REQUIRED');
    }
    const joined=await call(outsider,'POST',`/races/${race.id}/join`,{team:'TEAM_A'},OLD);
    assert.equal(joined.status,400);
    assert.equal(joined.body.code,'UPDATE_REQUIRED');
    assert.equal(await prisma.raceParticipant.count({where:{raceId:race.id}}),2);
  });
  it('serializes concurrent final-side joins without admitting an eleventh member',async()=>{
    const {race}=await fixture(10,18);
    const a=await createTestUser(), b=await createTestUser();
    const results=await Promise.all([a,b].map(actor=>call(actor,'POST',`/races/${race.id}/join`,{team:'TEAM_A'})));
    assert.deepEqual(results.map(r=>r.status).sort(),[201,409],JSON.stringify(results));
    assert.equal(results.find(r=>r.status===409).body.code,'TEAM_FULL');
    assert.equal(await prisma.raceParticipant.count({where:{raceId:race.id,status:'ACCEPTED',team:'TEAM_A'}}),10);
  });
  it('enlargement refuses legacy accepted members, then allows after actual supported requests',async()=>{
    const {race,actors}=await fixture(5,2);
    const refused=await call(actors[0],'PATCH',`/races/${race.id}`,{teamSize:10});
    assert.equal(refused.status,400);
    assert.equal(refused.body.code,'UPDATE_REQUIRED');
    assert.equal((await prisma.race.findUnique({where:{id:race.id}})).teamSize,5);
    for(const actor of actors) await call(actor,'GET','/auth/me');
    const resized=await call(actors[0],'PATCH',`/races/${race.id}`,{teamSize:10});
    assert.equal(resized.status,200,JSON.stringify(resized.body));
    assert.equal(resized.body.race.teamSize,10);
  });
  it('accepts supported invites and rejects downgraded acceptance without consuming invitation',async()=>{
    const {race,actors}=await fixture(10,2,1);
    const invitee=actors[2];
    const bad=await call(invitee,'PUT',`/races/${race.id}/respond`,{accept:true,team:'TEAM_B'},OLD);
    assert.equal(bad.status,400);
    assert.equal(bad.body.code,'UPDATE_REQUIRED');
    assert.equal((await prisma.raceParticipant.findUnique({where:{raceId_userId:{raceId:race.id,userId:invitee.user.id}}})).status,'INVITED');
    const good=await call(invitee,'PUT',`/races/${race.id}/respond`,{accept:true,team:'TEAM_B'});
    assert.equal(good.status,200,JSON.stringify(good.body));
  });
  it('private approval uses actual requester support after resizing, never owner header',async()=>{
    const {race,actors}=await fixture(5,2);
    const requester=await createTestUser();
    await prisma.race.update({where:{id:race.id},data:{isPublic:false}});
    const linked=await call(actors[0],'POST',`/races/${race.id}/share-link`,undefined,{'X-Client-Features':NEW['X-Client-Features']+',privatejoinapproval'});
    assert.equal(linked.status,201,JSON.stringify(linked.body));
    const token=linked.body.shareToken;
    const requested=await call(requester,'POST',`/races/share/${token}/join-requests`,{team:'TEAM_B'},OLD);
    assert.equal(requested.status,202,JSON.stringify(requested.body));
    for(const actor of actors)await call(actor,'GET','/auth/me');
    const resized=await call(actors[0],'PATCH',`/races/${race.id}`,{teamSize:10});
    assert.equal(resized.status,200,JSON.stringify(resized.body));
    const approved=await call(actors[0],'POST',`/races/${race.id}/join-requests/${requested.body.joinRequest.id}/respond`,{action:'ACCEPT'});
    assert.equal(approved.status,400,JSON.stringify(approved.body));
    assert.equal(approved.body.code,'UPDATE_REQUIRED');
    assert.equal(await prisma.raceParticipant.count({where:{raceId:race.id,userId:requester.user.id}}),0);
  });
  it('supports share join and rejects old shared preview/admission',async()=>{
    const {race,actors}=await fixture(10,2);
    const linked=await call(actors[0],'POST',`/races/${race.id}/share-link`);
    assert.equal(linked.status,201,JSON.stringify(linked.body));
    const token=linked.body.shareToken;
    const actor=await createTestUser();
    const bad=await call(actor,'GET',`/races/share/${token}`,undefined,OLD);
    assert.equal(bad.status,400);
    assert.equal(bad.body.code,'UPDATE_REQUIRED');
    const join=await call(actor,'POST',`/races/share/${token}/join`,{team:'TEAM_B'});
    assert.equal(join.status,201,JSON.stringify(join.body));
  });
  it('allows equal smaller sides to start and rejects uneven sides or undersized edits',async()=>{
    const {race,actors}=await fixture(10,4);
    const shrink=await call(actors[0],'PATCH',`/races/${race.id}`,{teamSize:1});
    assert.equal(shrink.status,400);
    assert.equal(shrink.body.code,'TEAM_SIZE_TOO_SMALL');
    await prisma.raceParticipant.delete({where:{raceId_userId:{raceId:race.id,userId:actors[3].user.id}}});
    const uneven=await call(actors[0],'POST',`/races/${race.id}/start`);
    assert.equal(uneven.body.code,'TEAMS_UNEVEN');
    await prisma.raceParticipant.delete({where:{raceId_userId:{raceId:race.id,userId:actors[2].user.id}}});
    const start=await call(actors[0],'POST',`/races/${race.id}/start`);
    assert.equal(start.status,200,JSON.stringify(start.body));
    assert.equal((await prisma.race.findUnique({where:{id:race.id}})).status,'ACTIVE');
  });
  it('keeps downgrade leave available for a noncreator and preserves all other members',async()=>{
    const {race,actors}=await fixture(10,4);
    const result=await call(actors[1],'POST',`/races/${race.id}/leave`,undefined,OLD);
    assert.equal(result.status,200,JSON.stringify(result.body));
    assert.equal(await prisma.raceParticipant.count({where:{raceId:race.id,status:'ACCEPTED'}}),3);
  });

  it('rematches preserve size10 and invite only former members with verified support',async()=>{
    const {race,actors}=await fixture(10,4);
    await prisma.race.update({where:{id:race.id},data:{status:'COMPLETED',completedAt:new Date()}});
    for(const actor of actors.slice(0,3))await call(actor,'GET','/auth/me');
    await call(actors[3],'GET','/auth/me',undefined,OLD);
    const headers={...NEW,'Idempotency-Key':require('node:crypto').randomUUID()};
    const response=await call(actors[0],'POST',`/races/${race.id}/rematch`,{},headers);
    assert.equal(response.status,201,JSON.stringify(response.body));
    const rematch=await prisma.race.findFirst({where:{rematchSourceRaceId:race.id}});
    assert.equal(rematch.teamSize,10);
    assert.equal(await prisma.raceParticipant.count({where:{raceId:rematch.id,userId:actors[3].user.id}}),0);
    assert.equal(await prisma.raceParticipant.count({where:{raceId:rematch.id,status:'INVITED'}}),2);
    const again=await call(actors[0],'POST',`/races/${race.id}/rematch`,{},headers);
    assert.equal(again.status,200,JSON.stringify(again.body));
    assert.equal(await prisma.race.count({where:{rematchSourceRaceId:race.id}}),1);
  });

  it('bounds invitation history even when a supported team detail omits paging parameters',async()=>{
    const {race,actors}=await fixture(10,20,55);
    const response=await call(actors[0],'GET',`/races/${race.id}`);
    assert.equal(response.status,200);
    assert.equal(response.body.teamAcceptedParticipants.length,20);
    assert.ok(response.body.participants.length<=50);
    assert.equal(response.body.participantsPagination.hasMore,true);
  });

  it('autostarts a public10v10 on final invite acceptance with bounded20 accepted despite old invitation history',async()=>{
    const {race,actors}=await fixture(10,19,1);
    // History never consumes an accepted slot or prevents a resolved roster.
    const history=[];for(let i=0;i<5;i++)history.push(await createTestUser());
    await prisma.raceParticipant.createMany({data:history.map(a=>({raceId:race.id,userId:a.user.id,status:'DECLINED'}))});
    const begin=performance.now();
    const result=await call(actors[19],'PUT',`/races/${race.id}/respond`,{accept:true,team:'TEAM_B'});
    assert.equal(result.status,200,JSON.stringify(result.body));
    const detail=await call(actors[0],'GET',`/races/${race.id}`);
    assert.equal(detail.body.status,'ACTIVE');assert.equal(detail.body.teamAcceptedParticipants.length,20);
    console.log('TEAM10_FINAL_ACCEPT_START_MS',Number((performance.now()-begin).toFixed(2)));
  });
  it('preserves a future10v10 schedule and starts all20 through the real scheduled worker when due',async()=>{
    const {race,actors}=await fixture(10,19,1);
    await prisma.race.update({where:{id:race.id},data:{scheduledStartAt:new Date(Date.now()+3600000)}});
    const result=await call(actors[19],'PUT',`/races/${race.id}/respond`,{accept:true,team:'TEAM_B'});
    assert.equal(result.status,200,JSON.stringify(result.body));
    assert.equal((await call(actors[0],'GET',`/races/${race.id}`)).body.status,'PENDING');
    await prisma.race.update({where:{id:race.id},data:{scheduledStartAt:new Date(Date.now()-1000)}});
    await require('../../src/modules/races/jobs/autoStartScheduledRaces').autoStartScheduledRaces();
    const detail=await call(actors[0],'GET',`/races/${race.id}`);
    assert.equal(detail.body.status,'ACTIVE');assert.equal(detail.body.teamAcceptedParticipants.length,20);
  });

});
