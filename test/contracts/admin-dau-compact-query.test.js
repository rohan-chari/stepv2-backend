require('./adminRedisFixture.cjs');
const assert=require('node:assert/strict');
const {before,beforeEach,after,it}=require('node:test');
const {cleanDatabase,createTestUser,startServer,prisma,request}=require('./setup');
const {pool}=require('../../src/db');
const {appSettings}=require('../../src/shared/config/appSettings');
let server,admin;const statements=[];
before(async()=>{
  // Supersedes the unpublished aggregate/index-only experiment: the approved
  // page-memory contract requires cursor batches and no DAU aggregate SQL.
  // Observe real pg statements on the real HTTP handler chain.
  const measuredPool={connect:async()=>{const client=await pool.connect();return new Proxy(client,{get(target,key){if(key==='query')return async(sql,...args)=>{statements.push(sql);return target.query(sql,...args);};const value=target[key];return typeof value==='function'?value.bind(target):value;}});}};
  server=await startServer({pool:measuredPool});
});
after(async()=>{await server?.close();});
beforeEach(async()=>{await cleanDatabase();statements.length=0;await appSettings.setFlag('adminMetricsV2TelemetryEnabled',false);admin=await createTestUser({email:'admin@test.com'});});
it('streams legacy DAU repeated events while preserving every exact HTTP metric',async()=>{
  const buyer=await createTestUser({email:'action-buyer@test.com'});
  const race=await prisma.race.create({data:{creatorId:buyer.user.id,name:'Repeated actions',targetSteps:1000,status:'ACTIVE'}});
  await prisma.$executeRaw`INSERT INTO race_powerup_events(id,race_id,actor_user_id,event_type,description,created_at)
    SELECT 'compact-box-'||n,${race.id},${buyer.user.id},'MYSTERY_BOX_OPENED','Repeated box',now() FROM generate_series(1,20000)n`;
  await prisma.$executeRaw`INSERT INTO activation_events(id,user_id,name,app_version,platform,occurred_at,created_at)
    SELECT 'compact-view-'||n,${buyer.user.id},'race_leaderboard_viewed','test','ios',now(),now() FROM generate_series(1,20000)n`;
  const response=await request(server.baseUrl,'GET','/admin/stats?sections=dashboard-dau-engagement&window=7d',{token:admin.token});
  assert.equal(response.status,200);const stats=(await response.json()).stats.metricsDashboard.dauEngagement;
  assert.deepEqual(stats.today.actions.boxOpen,{users:1,events:20000});
  assert.deepEqual(stats.today.actions.leaderboardView,{users:1,events:20000});
  assert.equal(stats.today.usersWithAnyAction,1);assert.equal(stats.today.averageActionReach,0.3);
  assert.ok(statements.some(sql=>typeof sql==='string'&&sql.startsWith('FETCH FORWARD 2000')));
  assert.ok(!statements.some(sql=>typeof sql==='string'&&sql.includes('WITH action_events AS')));
});
