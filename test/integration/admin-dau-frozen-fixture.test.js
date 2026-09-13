require('./adminRedisFixture.cjs');
const assert=require('node:assert/strict');
const {it}=require('node:test');
const {cleanDatabase,createTestUser,startServer,request,prisma}=require('./setup');
const {appSettings}=require('../../src/shared/config/appSettings');
it('preserves the complete released 61-day DAU JSON including all action and comparison fields',async()=>{
 await cleanDatabase();await prisma.metricCoverageStart.deleteMany();await prisma.adminMetricsCollectionEpoch.deleteMany();await appSettings.setFlag('adminMetricsV2TelemetryEnabled',false);const now=new Date('2026-09-13T16:00:00Z'),admin=await createTestUser({email:'admin@test.com'}),a=await createTestUser({email:'golden-a@test.com'}),b=await createTestUser({email:'golden-b@test.com'});
 const race=await prisma.race.create({data:{name:'Golden history',creatorId:a.user.id,status:'ACTIVE',targetSteps:1000,createdAt:new Date('2026-07-15T16:00:00Z')}}),events=[];
 for(let day=0;day<61;day++){const at=new Date(now.getTime()-day*86400000);for(let n=0;n<1+day%3;n++)events.push({raceId:race.id,actorUserId:a.user.id,eventType:'MYSTERY_BOX_OPENED',description:'Golden box',createdAt:at});if(day%2===0)events.push({raceId:race.id,actorUserId:b.user.id,eventType:'POWERUP_USED',description:'Golden power',createdAt:at});}
 await prisma.racePowerupEvent.createMany({data:events});const server=await startServer({adminAnalyticsNow:()=>now});try{const r=await request(server.baseUrl,'GET','/admin/stats?sections=dashboard-dau-engagement&window=90d',{token:admin.token});assert.equal(r.status,200);const actual=(await r.json()).stats;assert.deepEqual(actual,require('../fixtures/admin-page-memory/legacy-dau-61d.json'));}finally{await server.close();}
});
