const assert = require('node:assert/strict');
const { before, after, beforeEach, it } = require('node:test');
const { startServer, cleanDatabase, createTestUser, request, prisma } = require('../setup');
let server;
before(async () => { server = await startServer(); });
after(async () => { await server?.close(); });
beforeEach(cleanDatabase);
async function race(owner) {
  const response = await request(server.baseUrl, 'POST', '/races', {token:owner.token, body:{name:'Realm race',targetSteps:50000,maxDurationDays:7,isPublic:true}});
  assert.equal(response.status,201,JSON.stringify(await response.clone().json()));
  return (await response.json()).race;
}
it('isolates sandbox race creation, cross-realm joins and invitations without charging', async () => {
  const sandbox = await createTestUser({billingRealm:'sandbox',coins:500});
  const player = await createTestUser({coins:100});
  const sandboxRace = await race(sandbox), productionRace = await race(player);
  assert.equal((await prisma.race.findUnique({where:{id:sandboxRace.id}})).economicRealm,'sandbox');
  for (const [actor,target] of [[player,sandboxRace],[sandbox,productionRace]]) {
    const result = await request(server.baseUrl,'POST',`/races/${target.id}/join`,{token:actor.token,body:{}});
    assert.equal(result.status,409);
    assert.equal((await result.json()).code,'BILLING_REALM_MISMATCH');
  }
  const invited = await request(server.baseUrl,'POST',`/races/${sandboxRace.id}/invite`,{token:sandbox.token,body:{inviteeIds:[player.user.id]}});
  assert.equal(invited.status,409);
  assert.equal(await prisma.raceParticipant.count({where:{raceId:sandboxRace.id,userId:player.user.id}}),0);
  assert.equal((await prisma.user.findUnique({where:{id:player.user.id}})).coins,100);
});
it('allows same-realm sandbox play while keeping production accounts defaulted', async () => {
  const a = await createTestUser({billingRealm:'sandbox'}), b = await createTestUser({billingRealm:'sandbox'});
  const r = await race(a);
  const result = await request(server.baseUrl,'POST',`/races/${r.id}/join`,{token:b.token,body:{}});
  assert.equal(result.status,201,JSON.stringify(await result.clone().json()));
  assert.equal((await createTestUser()).user.billingRealm,'production');
});
it('provisions only empty accounts and preserves sandbox identity after account recreation', async () => {
  const {spawnSync} = require('node:child_process');
  const empty = await createTestUser(), funded = await createTestUser({coins:1});
  const provision = (userId,apply) => spawnSync(process.execPath,['scripts/billing-provision-sandbox.js',`--user-id=${userId}`,...(apply?['--apply']:[])],{cwd:process.cwd(),env:process.env,encoding:'utf8'});
  const dry = provision(empty.user.id,false); assert.equal(dry.status,0,dry.stderr);
  assert.equal((await prisma.user.findUnique({where:{id:empty.user.id}})).billingRealm,'production');
  const applied = provision(empty.user.id,true); assert.equal(applied.status,0,applied.stderr);
  assert.equal((await prisma.user.findUnique({where:{id:empty.user.id}})).isReviewAccount,true);
  assert.notEqual(provision(funded.user.id,true).status,0);
  assert.equal((await prisma.user.findUnique({where:{id:funded.user.id}})).billingRealm,'production');
  const deleted = await request(server.baseUrl,'DELETE','/auth/account',{token:empty.token}); assert.equal(deleted.status,204);
  const recreated = await createTestUser({appleId:empty.user.appleId});
  assert.equal(recreated.user.billingRealm,'sandbox');
  assert.equal(recreated.user.isReviewAccount,true);
});
it('blocks worker-style direct mixed admission and realm relabelling at the database boundary', async () => {
  const a = await createTestUser({billingRealm:'sandbox'}), b = await createTestUser();
  const r = await race(a);
  await assert.rejects(prisma.raceParticipant.create({data:{raceId:r.id,userId:b.user.id,status:'ACCEPTED'}}),/BILLING_REALM_MISMATCH/);
  await assert.rejects(prisma.user.update({where:{id:a.user.id},data:{billingRealm:'production'}}),/BILLING_REALM_IMMUTABLE/);
  await assert.rejects(prisma.race.update({where:{id:r.id},data:{economicRealm:'production'}}),/BILLING_REALM_IMMUTABLE/);
  await prisma.race.update({where:{id:r.id},data:{creatorId:null}});
  assert.equal((await prisma.race.findUnique({where:{id:r.id}})).economicRealm,'sandbox');
});
it('rejects a contest insert using eligibility read before sandbox conversion', async () => {
  const {user} = await createTestUser();
  const contest = await prisma.giveawayContest.create({data:{slug:'realm-test',title:'Realm',governingTimeZone:'UTC',startsAt:new Date(),endsAt:new Date(Date.now()+86400000),sponsor:{},rulesVersion:'1',rulesSections:[],rulesHash:'hash',bannerMessage:'Realm'}});
  assert.equal((await prisma.user.findUnique({where:{id:user.id}})).isReviewAccount,false);
  await prisma.user.update({where:{id:user.id},data:{billingRealm:'sandbox'}});
  await assert.rejects(prisma.giveawayEntrant.create({data:{contestId:contest.id,userId:user.id,entrantIdentityHash:'test-identity',rulesAcceptedAt:new Date(),acceptedRulesVersion:'1',acceptedRulesHash:'hash',displayNameConsentedAt:new Date()}}),/BILLING_REALM_MISMATCH/);
});
it('stamps tournament rounds and rejects cross-realm bracket admission', async () => {
  const a = await createTestUser({billingRealm:'sandbox'}), b = await createTestUser();
  const tournament = await prisma.tournament.create({data:{creatorId:a.user.id,name:'Sandbox bracket',bracketSize:4,matchupDurationDays:1,totalRounds:2}});
  assert.equal(tournament.economicRealm,'sandbox');
  const round = await prisma.race.create({data:{tournamentId:tournament.id,name:'Round',targetSteps:1000}});
  assert.equal(round.economicRealm,'sandbox');
  const result = await request(server.baseUrl,'POST',`/tournaments/${tournament.id}/join`,{token:b.token,body:{}});
  assert.equal(result.status,409);
  assert.equal((await result.json()).code,'BILLING_REALM_MISMATCH');
  await assert.rejects(prisma.tournamentParticipant.create({data:{tournamentId:tournament.id,userId:b.user.id,status:'ACCEPTED'}}),/BILLING_REALM_MISMATCH/);
});
it('allows concurrent worker creation followed by wallet updates', async () => {
  const {user} = await createTestUser();
  const createAndLockWallet = () => prisma.$transaction(async tx => {
    await tx.race.create({data:{creatorId:user.id,name:'Concurrent worker',targetSteps:1000}});
    // Match the canonical coin-only UPDATE lock strength. FOR UPDATE would
    // unnecessarily upgrade the race creator FK lock and deadlock even
    // without any realm guard; no wallet operation changes user key columns.
    await new Promise(resolve=>setTimeout(resolve,80));
    await tx.$queryRawUnsafe('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE',user.id);
  });
  const results = await Promise.allSettled([createAndLockWallet(),createAndLockWallet()]);
  assert.deepEqual(results.map(result=>result.status),['fulfilled','fulfilled'],results.map(result=>result.reason?.message||'ok').join('\n'));
  assert.equal(await prisma.race.count({where:{creatorId:user.id}}),2);
});
it('seeds a fresh reviewer and supporting cast in the same sandbox realm', async () => {
  const {spawnSync} = require('node:child_process');
  const seeded = spawnSync(process.execPath,['scripts/seed-app-review-demo.js'],{cwd:process.cwd(),env:{...process.env,APP_REVIEW_EMAIL:'realm-review@example.com'},encoding:'utf8'});
  assert.equal(seeded.status,0,seeded.stderr);
  const users = await prisma.user.findMany({where:{appleId:{in:['review-account-v1','demo-review-alex','demo-review-maya','demo-review-jordan']}}});
  assert.equal(users.length,4);
  assert.ok(users.every(user=>user.billingRealm==='sandbox'));
  const races = await prisma.race.findMany({where:{creatorId:{in:users.map(user=>user.id)}}});
  assert.ok(races.length>0);
  assert.ok(races.every(race=>race.economicRealm==='sandbox'));
});
it('does not deliver sandbox friend requests to ordinary players', async () => {
  const a = await createTestUser({billingRealm:'sandbox'}), b = await createTestUser();
  for (const [sender,target] of [[a,b],[b,a]]) {
    const response = await request(server.baseUrl,'POST','/friends/request',{token:sender.token,body:{addresseeId:target.user.id}});
    assert.equal(response.status,409);
  }
  assert.equal(await prisma.friendship.count(),0);
});
it('does not couple multi-user admission to batched account metadata row locks', {timeout:10000}, async () => {
  const a=await createTestUser(), b=await createTestUser();
  let created, metadataLocked;
  const createdSignal=new Promise(resolve=>{created=resolve;});
  const metadataSignal=new Promise(resolve=>{metadataLocked=resolve;});
  const admission=prisma.$transaction(async tx=>{
    const r=await tx.race.create({data:{creatorId:a.user.id,name:'Batch lock',targetSteps:1000}});
    created(); await metadataSignal;
    await tx.raceParticipant.create({data:{raceId:r.id,userId:b.user.id,status:'ACCEPTED'}});
  });
  const metadata=prisma.$transaction(async tx=>{
    await createdSignal;
    await tx.user.update({where:{id:b.user.id},data:{lastSeenAt:new Date()}});
    metadataLocked();
    await tx.user.update({where:{id:a.user.id},data:{lastSeenAt:new Date()}});
  });
  const results=await Promise.allSettled([admission,metadata]);
  assert.deepEqual(results.map(result=>result.status),['fulfilled','fulfilled'],results.map(result=>result.reason?.message||'ok').join('\n'));
});
it('rejects realm admission and conversion under stale-snapshot isolation', async () => {
  const {user}=await createTestUser();
  await assert.rejects(prisma.$transaction(tx=>tx.race.create({data:{creatorId:user.id,name:'Old snapshot',targetSteps:1000}}),{isolationLevel:'RepeatableRead'}),error=>error.code==='P2034');
  await assert.rejects(prisma.$transaction(tx=>tx.user.update({where:{id:user.id},data:{billingRealm:'sandbox'}}),{isolationLevel:'RepeatableRead'}),error=>error.code==='P2034');
});

it('rejects conversion promptly while an admission is uncommitted', async () => {
  const {user}=await createTestUser();
  let entered, release;
  const enteredSignal=new Promise(resolve=>{entered=resolve;});
  const releaseSignal=new Promise(resolve=>{release=resolve;});
  const admission=prisma.$transaction(async tx=>{
    await tx.race.create({data:{creatorId:user.id,name:'Held admission',targetSteps:1000}});
    entered(); await releaseSignal;
  });
  try {
    await enteredSignal;
    await assert.rejects(prisma.$transaction(async other=>{
      await other.$executeRawUnsafe("SET LOCAL lock_timeout='500ms'");
      await other.user.update({where:{id:user.id},data:{billingRealm:'sandbox'}});
    }),error=>error.code==='P2034');
  } finally { release(); await admission; }
  assert.equal((await prisma.user.findUnique({where:{id:user.id}})).billingRealm,'production');
});
it('reads the committed realm after waiting behind conversion', async () => {
  const owner=await createTestUser(), entrant=await createTestUser();
  const r=await race(owner);
  let converted, release;
  const convertedSignal=new Promise(resolve=>{converted=resolve;});
  const releaseSignal=new Promise(resolve=>{release=resolve;});
  const conversion=prisma.$transaction(async tx=>{
    await tx.user.update({where:{id:entrant.user.id},data:{billingRealm:'sandbox'}});
    converted(); await releaseSignal;
  });
  let admission;
  try {
    await convertedSignal;
    admission=prisma.raceParticipant.create({data:{raceId:r.id,userId:entrant.user.id,status:'ACCEPTED'}}).then(()=>null,error=>error);
    // The INSERT begins before conversion commits. The helper must refresh
    // the outer statement's old snapshot after acquiring its shared lock.
    let waiting=false;
    for(let i=0;i<100&&!waiting;i++) {
      const rows=await prisma.$queryRawUnsafe("SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=1700090719 AND NOT granted");
      waiting=rows.length>0;
      if(!waiting) await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.ok(waiting,'admission must wait on conversion advisory lock');
  } finally { release(); await conversion; }
  assert.match((await admission)?.message||'',/BILLING_REALM_MISMATCH/);
  assert.equal(await prisma.raceParticipant.count({where:{raceId:r.id,userId:entrant.user.id}}),0);
});
