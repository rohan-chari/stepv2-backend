const assert = require('node:assert/strict');
const { describe, it, before, beforeEach, after } = require('node:test');
const { cleanDatabase, createTestUser, startServer, prisma, request } = require('./setup');
const HEADERS = { 'X-Client-Features': 'seeded_race_buckets' };
describe('durable automatic eligibility transition clock',()=>{
  let server;
  before(async()=>{server=await startServer();});
  after(async()=>server.close());
  beforeEach(async()=>cleanDatabase());
  async function row(id){return (await prisma.$queryRawUnsafe('SELECT seeded_automatic_eligible_at AS "eligibleAt" FROM users WHERE id=$1',id))[0];}
  async function preference(account,enabled){const response=await request(server.baseUrl,'PUT','/auth/me/featured-auto-join',{token:account.token,headers:HEADERS,body:{enabled}});assert.equal(response.status,200);assert.equal((await response.json()).user.autoJoinFeaturedRaces,enabled);}
  it('OFF to ON records the first eligible instant and repeated ON preserves it',async()=>{
    const account=await createTestUser({clientFeatures:['seeded_race_buckets'],autoJoinFeaturedRaces:false});
    assert.equal((await row(account.user.id)).eligibleAt,null);const before=Date.now();
    await preference(account,true);const stamp=(await row(account.user.id)).eligibleAt;
    assert.ok(stamp instanceof Date);assert.ok(stamp.getTime()>=before&&stamp.getTime()<=Date.now()+1);
    await preference(account,true);assert.equal((await row(account.user.id)).eligibleAt.getTime(),stamp.getTime());
    await preference(account,false);assert.equal((await row(account.user.id)).eligibleAt.getTime(),stamp.getTime());
  });
  it('first bucket capability records eligibility while unrelated capability refresh preserves it',async()=>{
    const account=await createTestUser({autoJoinFeaturedRaces:true,clientFeatures:[]});const before=Date.now();
    const response=await request(server.baseUrl,'GET','/auth/me',{token:account.token,headers:HEADERS});assert.equal(response.status,200);
    let stamp=null;for(let i=0;i<50&&!stamp;i++){stamp=(await row(account.user.id)).eligibleAt;if(!stamp)await new Promise(resolve=>setTimeout(resolve,10));}
    assert.ok(stamp instanceof Date);assert.ok(stamp.getTime()>=before&&stamp.getTime()<=Date.now()+1);
    const refreshed=await request(server.baseUrl,'GET','/auth/me',{token:account.token,headers:{'X-Client-Features':'seeded_race_buckets,powerups3'}});assert.equal(refreshed.status,200);
    await new Promise(resolve=>setTimeout(resolve,30));assert.equal((await row(account.user.id)).eligibleAt.getTime(),stamp.getTime());
  });
  it('pre-cutover eligible NULL rows remain NULL through repeated eligible writes',async()=>{
    const account=await createTestUser({autoJoinFeaturedRaces:true,clientFeatures:['seeded_race_buckets']});
    // Fixture for a row already eligible when the additive migration landed.
    await prisma.$executeRawUnsafe('UPDATE users SET seeded_automatic_eligible_at=NULL WHERE id=$1',account.user.id);
    await preference(account,true);assert.equal((await row(account.user.id)).eligibleAt,null);
    await prisma.$executeRawUnsafe("UPDATE users SET client_features=client_features||ARRAY['powerups3']::text[] WHERE id=$1",account.user.id);
    assert.equal((await row(account.user.id)).eligibleAt,null);
  });
  it('older writers that omit the new column still stamp eligibility transitions',async()=>{
    const account=await createTestUser({autoJoinFeaturedRaces:false,clientFeatures:['seeded_race_buckets']});
    const before=Date.now();await prisma.$executeRawUnsafe('UPDATE users SET auto_join_featured_races=true WHERE id=$1',account.user.id);
    const stamp=(await row(account.user.id)).eligibleAt;assert.ok(stamp instanceof Date);assert.ok(stamp.getTime()>=before&&stamp.getTime()<=Date.now()+1);
  });
});
