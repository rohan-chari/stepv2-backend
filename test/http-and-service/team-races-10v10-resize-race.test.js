const assert=require('node:assert/strict');
const {describe,it,beforeEach}=require('node:test');
const {cleanDatabase,prisma,request,startServer,createTestUser}=require('./setup');
const NEW={'X-Client-Features':'team_races,team_races_10v10_v1,race_participants_paging'};
const OLD={'X-Client-Features':'team_races,race_participants_paging'};
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};}
describe('10v10 resize races with frozen request preflight',()=>{
 beforeEach(cleanDatabase);
 for(const operation of ['detail','progress','switch','start','startCommit','nameEdit','concurrentWinner'])it(`rejects old ${operation} after preflight5 then committed resize10`,async()=>{
  const owner=await createTestUser({clientFeatures:['team_races','team_races_10v10_v1']});
  const member=await createTestUser({clientFeatures:['team_races','team_races_10v10_v1']});
  const race=await prisma.race.create({data:{name:'Resize interleave',targetSteps:0,isPublic:true,isTeamRace:true,teamSize:5,maxParticipants:10,teamAName:'Alpha',teamBName:'Bravo',creatorId:owner.user.id,status:'PENDING',maxDurationDays:7,timeBased:true}});
  await prisma.raceParticipant.createMany({data:[owner,member].map((a,i)=>({raceId:race.id,userId:a.user.id,status:'ACCEPTED',team:i?'TEAM_B':'TEAM_A'}))});
  const observed=deferred(),release=deferred();let paused=false;
  // This sole injected seam coordinates the real HTTP preflight SELECT. It
  // returns its real stale snapshot; handlers and all writes still use Postgres.
  const raceDelegate=new Proxy(prisma.race,{get(target,key){if(key==='findUnique')return async args=>{
    const result=await target.findUnique(args);
    if(!['startCommit','concurrentWinner'].includes(operation)&&!paused&&args.where?.id===race.id&&args.select?.isTeamRace&&args.select?.teamSize&&Object.keys(args.select).length===2){paused=true;observed.resolve();await release.promise;}
    return result;
  };const v=target[key];return typeof v==='function'?v.bind(target):v;}});
  const db=new Proxy(prisma,{get(target,key){if(key==='race')return raceDelegate;const v=target[key];return typeof v==='function'?v.bind(target):v;}});
  const server=await startServer({prisma:db,...(['startCommit','concurrentWinner'].includes(operation)?{beforeCommitRaceStart:async()=>{if(!paused){paused=true;observed.resolve();await release.promise;}}}:{})});
  try{
    const suffix={detail:'',progress:'/progress',switch:'/team',start:'/start',startCommit:'/start',nameEdit:'',concurrentWinner:'/start'}[operation];
    const method={detail:'GET',progress:'GET',switch:'PUT',start:'POST',startCommit:'POST',nameEdit:'PATCH',concurrentWinner:'POST'}[operation];
    const pending=request(server.baseUrl,method,`/races/${race.id}${suffix}`,{token:owner.token,headers:OLD,...(operation==='switch'?{body:{team:'TEAM_B'}}:operation==='nameEdit'?{body:{name:'Stale rename'}}:{})});
    await observed.promise;
    const resized=await request(server.baseUrl,'PATCH',`/races/${race.id}`,{token:owner.token,headers:NEW,body:{teamSize:10}});
    assert.equal(resized.status,200,JSON.stringify(await resized.json()));
    if(operation==='concurrentWinner'){const winner=await request(server.baseUrl,'POST',`/races/${race.id}/start`,{token:owner.token,headers:NEW});assert.equal(winner.status,200,JSON.stringify(await winner.json()));}
    release.resolve();
    const response=await pending,body=await response.json();
    assert.equal(response.status,400,JSON.stringify(body));assert.equal(body.code,'UPDATE_REQUIRED');
    assert.equal((await prisma.race.findUnique({where:{id:race.id}})).status,operation==='concurrentWinner'?'ACTIVE':'PENDING');
    assert.equal((await prisma.raceParticipant.findUnique({where:{raceId_userId:{raceId:race.id,userId:owner.user.id}}})).team,'TEAM_A');
  }finally{release.resolve();await server.close();}
 });
 it('retains old request capability through a participant-change start retry',async()=>{
  const actors=[];for(let i=0;i<4;i++)actors.push(await createTestUser({clientFeatures:['team_races','team_races_10v10_v1']}));
  const race=await prisma.race.create({data:{name:'Retry interleave',targetSteps:0,isPublic:true,isTeamRace:true,teamSize:5,maxParticipants:10,teamAName:'Alpha',teamBName:'Bravo',creatorId:actors[0].user.id,status:'PENDING',maxDurationDays:7,timeBased:true}});
  await prisma.raceParticipant.createMany({data:actors.slice(0,2).map((a,i)=>({raceId:race.id,userId:a.user.id,status:'ACCEPTED',team:i?'TEAM_B':'TEAM_A'}))});
  const observed=[deferred(),deferred()],release=[deferred(),deferred()];let calls=0;
  const server=await startServer({beforeCommitRaceStart:async()=>{const i=calls++;if(i<2){observed[i].resolve();await release[i].promise;}}});
  try{
   const pending=request(server.baseUrl,'POST',`/races/${race.id}/start`,{token:actors[0].token,headers:OLD});
   await observed[0].promise;
   for(let i=2;i<4;i++){const r=await request(server.baseUrl,'POST',`/races/${race.id}/join`,{token:actors[i].token,headers:NEW,body:{team:i===2?'TEAM_A':'TEAM_B'}});assert.equal(r.status,201,JSON.stringify(await r.json()));}
   release[0].resolve();await observed[1].promise;
   const resized=await request(server.baseUrl,'PATCH',`/races/${race.id}`,{token:actors[0].token,headers:NEW,body:{teamSize:10}});assert.equal(resized.status,200,JSON.stringify(await resized.json()));
   release[1].resolve();const response=await pending,body=await response.json();assert.equal(response.status,400,JSON.stringify(body));assert.equal(body.code,'UPDATE_REQUIRED');
   assert.equal((await prisma.race.findUnique({where:{id:race.id}})).status,'PENDING');
  }finally{release.forEach(d=>d.resolve());await server.close();}
 });

});
