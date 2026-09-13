// This worker imports only pure code / Node built-ins. No DB, Redis or app DI.
const {parentPort,workerData}=require('node:worker_threads');
const {performance}=require('node:perf_hooks');
const fmt=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
const hours=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',hourCycle:'h23'});
const ms=v=>v==null?NaN:v instanceof Date?v.getTime():Date.parse(v);
const day=v=>fmt.format(new Date(v));
const shift=(d,n)=>new Date(Date.parse(d+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
const midnight=d=>{const a=new Date(d+'T00:00:00Z');return a.getTime()+(24-Number(hours.format(a)))*3600000;};
const round=n=>Math.round((n+Number.EPSILON)*10)/10;
const ratio=(n,d,available=true)=>!available||n==null||d==null?{numerator:null,denominator:null,percent:null}:{numerator:n,denominator:d,percent:d?round(n/d*100):null};
const ACTIONS=['raceParticipation','boxOpen','powerupUse','dailyRewardClaim','notificationOpen','rewardedAd','leaderboardView','raceCreated','raceCompleted'];
const KINDS=['coin_reward','extra_daily_spin','box_reroll','race_payout_double','powerup_unlock'];
function createAccumulator(input){
 const {view,window:{start,end},generatedAt,identity}=input;const epoch=identity.epoch;const epochAt=ms(epoch?.started_at);let stateBytes=0,peakHeap=0,peakExternal=0;
 const budget={charge(bytes){if(stateBytes+bytes>64*1024*1024)throw Error('Analytics worker live-state budget exceeded');stateBytes+=bytes;},release(bytes){stateBytes=Math.max(0,stateBytes-bytes);}};
 // Conservative per-entry charging includes hash storage, key strings and values.
 const setAdd=(set,key)=>{if(!set.has(key)){budget.charge(96+String(key).length*2);set.add(key);}};
 const put=(map,key,value,bytes=160)=>{if(!map.has(key))budget.charge(bytes+String(key).length*2);map.set(key,value);};
 const dates=[];for(let d=start;d<=end;d=shift(d,1))dates.push(d);
 const historyStart=view==='legacyDau'?shift(end,-60):start;
 const actionDates=[];const boundaries=[];for(let d=historyStart;d<=shift(end,1);d=shift(d,1)){boundaries.push(midnight(d));if(d<=end)actionDates.push(d);}budget.charge(boundaries.length*32);
 const eventDay=value=>{const t=ms(value);let l=0,r=boundaries.length-1;if(t<boundaries[0]||t>=boundaries[r]||!Number.isFinite(t))return null;while(l+1<r){const m=(l+r)>>1;if(t<boundaries[m])r=m;else l=m;}return actionDates[l];};
 const users=new Map(),signupCounts=new Map(),cohorts=new Map(),fgDaily=new Map(),fgSets={dau:new Set(),wau:new Set(),mau:new Set()},racers=new Set(),currentRacers=new Set(),actions=new Map(),adDays=new Map(),capDays=new Map(),skus=new Map(),repeat=new Map();
 const secondary=['races','invites','onboarding'].includes(view)?require('./adminPageSecondary').createSecondaryAccumulator({view,start,end,generatedAt,identity,budget,day,midnight,shift,ratio}):null;
 const capable=(u,at)=>Boolean(epoch&&u.epoch===epoch.id&&u.eligible<=at);
 function consume(source,rows){
  if(secondary){secondary.consume(source,rows);return sample();}
  for(const row of rows){
   if(source==='users'){
    const date=day(row.created_at),eligible=Boolean(epoch&&row.metrics_v2_signup_eligible&&row.metrics_v2_signup_epoch_id===epoch.id);put(users,row.id,{date,epoch:row.metrics_v2_eligible_epoch_id,eligibleAt:row.metrics_v2_eligible_at,eligible:ms(row.metrics_v2_eligible_at),signupEligible:eligible},320);
    if(['overview','growth'].includes(view)&&date>=start&&date<=end)put(signupCounts,date,(signupCounts.get(date)||0)+1,64);
    if(view==='retention'&&eligible&&date<=end){if(!cohorts.has(date))put(cohorts,date,{eligible:0,d1:0,d7:0,d30:0},160);cohorts.get(date).eligible++;}
   }else if(source==='foreground'){
    const u=users.get(row.user_id),date=String(row.activity_date).slice(0,10);if(!u)continue;
    if(capable(u,midnight(date))){if(!fgDaily.has(date))put(fgDaily,date,new Set());setAdd(fgDaily.get(date),row.user_id);}
    for(const [h,key]of [[1,'dau'],[7,'wau'],[30,'mau']]){const boundary=shift(end,1-h);if(date>=boundary&&date<=end&&capable(u,midnight(boundary)))setAdd(fgSets[key],row.user_id);}
   }else if(source==='currentRacers')setAdd(currentRacers,row.user_id);
   else if(source==='eligibleRacers'){setAdd(racers,row.user_id);put(users,row.user_id,{epoch:row.metrics_v2_eligible_epoch_id,eligible:ms(row.metrics_v2_eligible_at)},192);}
   else if(source.startsWith('action')){
    const date=eventDay(row.occurred_at);if(!date)continue;let action={actionParticipation:'raceParticipation',actionClaims:'dailyRewardClaim',actionNotifications:'notificationOpen',actionAds:'rewardedAd',actionLeaderboard:'leaderboardView',actionCreated:'raceCreated',actionCompleted:'raceCompleted'}[source];if(source==='actionPower')action=row.event_type==='MYSTERY_BOX_OPENED'?'boxOpen':'powerupUse';
    if(!actions.has(date))put(actions,date,{union:new Set(),kinds:new Map()});const d=actions.get(date);setAdd(d.union,row.user_id);if(!d.kinds.has(action))put(d.kinds,action,{users:new Set(),events:0});const a=d.kinds.get(action);setAdd(a.users,row.user_id);a.events++;
   }else if(source==='ads'){
    const t=ms(row.created_at),date=day(row.created_at);
    if(row.is_review_account===false&&date>=start&&date<=end){if(!adDays.has(date))put(adDays,date,{users:new Set(),kinds:new Map()});const d=adDays.get(date);setAdd(d.users,row.user_id);put(d.kinds,row.reward_kind,(d.kinds.get(row.reward_kind)||0)+1,64);}
    if(row.reward_kind==='coin_reward'&&t>=ms(generatedAt)-30*86400000){const granted=String(row.granted_date);if(!capDays.has(granted))put(capDays,granted,new Map());const d=capDays.get(granted);put(d,row.user_id,(d.get(row.user_id)||0)+1,64);}
   }else if(source.startsWith('shop')){if(!skus.has(row.sku))put(skus,row.sku,{sku:row.sku,count:0,coins:0});const s=skus.get(row.sku);s.count++;s.coins+=Number(row.coins||0);}
   else if(source==='retentionActivity'){
    const u=users.get(row.user_id);if(!u?.signupEligible)continue;const date=String(row.activity_date).slice(0,10),c=cohorts.get(u.date);if(c)for(const h of [1,7,30])if(date===shift(u.date,h))c['d'+h]++;
   }else if(source==='repeatRaces'){
    if(!repeat.has(row.user_id))put(repeat,row.user_id,{first:null,joins:[]});const p=repeat.get(row.user_id),order=ms(row.race_at);if(!p.first||order<p.first.order||(order===p.first.order&&row.race_id<p.first.id)){p.first={id:row.race_id,order,completed:ms(row.completed_at),finished:row.finished_at!=null,forfeited:row.forfeited_at!=null,status:row.status};budget.charge(p.firstCharged?0:256);p.firstCharged=true;}budget.charge(112+row.race_id.length*2);p.joins.push([row.race_id,ms(row.joined_at)]);
   }
  }sample();
 }
 function sample(){const m=process.memoryUsage();peakHeap=Math.max(peakHeap,m.heapUsed);peakExternal=Math.max(peakExternal,m.external);}
 function coverageNode(boundary,eligible,total){return {status:epoch?(epochAt<=midnight(boundary)?'mature':'collecting'):'unavailable',collectingSince:epoch?day(epoch.started_at):null,eligible,totalPopulation:total,eligibilityPercent:total?round(eligible/total*100):null};}
 function finish(){
  const blocks={};const metricCoverage={};
  if(secondary)return {blocks:secondary.finish(),diagnostics:diagnostics()};
  if(view==='legacyDau')return {actionRows:actionDates.map(action_date=>{const a=actions.get(action_date);const kinds=Object.fromEntries(ACTIONS.map(id=>[id,{users:a?.kinds.get(id)?.users.size||0,events:a?.kinds.get(id)?.events||0}]));const total=Object.values(kinds).reduce((n,k)=>n+k.users,0);return {action_date,total_users:total,average_users:round(total/9),union_users:a?.union.size||0,actions:kinds};}),diagnostics:diagnostics()};
  if(['overview','growth'].includes(view)){
   for(const [h,key]of [[1,'Dau'],[7,'Wau'],[30,'Mau']]){if(view==='overview'&&input.days===7&&h===30)continue;const boundary=shift(end,1-h);metricCoverage['observedForeground'+key]=coverageNode(boundary,[...users.values()].filter(u=>capable(u,midnight(boundary))).length,users.size);}
   const foreground=(key,source)=>metricCoverage[key]?.status==='mature'?fgSets[source].size:null;
   const growth={daily:dates.map(date=>({date,signups:signupCounts.get(date)||0,observedForegroundUsers:epoch&&epochAt<=midnight(date)?fgDaily.get(date)?.size||0:null})),observedForegroundWau:foreground('observedForegroundWau','wau')};
   if(metricCoverage.observedForegroundMau)growth.observedForegroundMau=foreground('observedForegroundMau','mau');
   blocks['dashboard-growth']={userGrowth:growth,coverage:{metricCoverage}};
   if(view==='overview')blocks['dashboard-summary']={summary:{growth:{totalSignups:users.size,signupsToday:signupCounts.get(end)||0,signupsLast7Days:[...signupCounts].filter(([d])=>d>=shift(end,-6)&&d<=end).reduce((n,[,c])=>n+c,0),observedForegroundDau:foreground('observedForegroundDau','dau')},races:{usersInActiveNonFeaturedRaces:currentRacers.size}},coverage:{metricCoverage:{observedForegroundDau:metricCoverage.observedForegroundDau}}};
  }
  if(['overview','activity'].includes(view)){
   const todayActions=actions.get(end),today={date:end};if(view==='activity')today.actions=Object.fromEntries(ACTIONS.filter(a=>['boxOpen','powerupUse','dailyRewardClaim','leaderboardView'].includes(a)).map(a=>[a,{users:todayActions?.kinds.get(a)?.users.size||0,events:todayActions?.kinds.get(a)?.events||0}]));
   const d={actionBasedDau:{users:todayActions?.union.size||0,status:'available'},today,daily:dates.map(date=>{const a=actions.get(date),r={date,actionBasedDau:a?.union.size||0};if(view==='activity')for(const k of ['boxOpen','powerupUse','dailyRewardClaim','leaderboardView'])r['action_'+k]=a?.kinds.get(k)?.users.size||0;return r;})};blocks['dashboard-dau-engagement']={dauEngagement:d};
   if(view==='activity'){const box=identity.coverage.find(c=>c.metric==='boxOpen')?.operational_at;metricCoverage.boxOpen={status:box?(ms(box)<=midnight(start)?'mature':'collecting'):'unavailable',collectingSince:box?day(box):null,eligible:null,totalPopulation:null,eligibilityPercent:null};metricCoverage.leaderboardViews=coverageNode(start,[...racers].filter(id=>capable(users.get(id)||{},midnight(start))).length,racers.size);blocks['dashboard-dau-engagement'].coverage={metricCoverage};}
  }
  if(view==='ads'){
   blocks['dashboard-revenue']={revenue:{daily:dates.map(date=>{const d=adDays.get(date);const kinds=KINDS.map(rewardKind=>({rewardKind,grants:d?.kinds.get(rewardKind)||0}));return {date,uniqueSsvWatchers:d?.users.size||0,ssvGrants:kinds.reduce((n,k)=>n+k.grants,0),ssvByRewardKind:kinds};})}};
   const latest=[...capDays.keys()].sort().at(-1);blocks.ads={adRevenue:{capUtilization:{usersAtCap:[...(capDays.get(latest)?.values()||[])].filter(n=>n>=input.adCap).length}}};
  }
  if(view==='shop')blocks.economy={coinEconomy:{purchasesBySku:[...skus.values()].sort((a,b)=>b.coins-a.coins||a.sku.localeCompare(b.sku)).map(({sku,count})=>({sku,count}))}};
  if(view==='retention'){
   const summary={};for(const h of [1,7,30]){const mature=shift(end,-h-1),selected=[...cohorts.keys()].filter(d=>d<=mature).sort().slice(-30),chosen=new Set(selected);const eligible=selected.reduce((n,d)=>n+cohorts.get(d).eligible,0);const total=[...users.values()].filter(u=>chosen.has(u.date)).length;const node=coverageNode(mature,eligible,total);metricCoverage['retentionD'+h]=node;summary['d'+h]=ratio(selected.reduce((n,d)=>n+cohorts.get(d)['d'+h],0),eligible,node.status==='mature');}
   blocks['dashboard-summary']={summary:{retention:summary},coverage:{metricCoverage}};
   blocks['dashboard-retention']={retention:{cohorts:dates.map(signupDate=>{const c=cohorts.get(signupDate);const r={signupDate,eligibleSignups:c?.eligible||0};for(const h of [1,7,30])r['d'+h]=ratio(c?.['d'+h]||0,c?.eligible||0,shift(signupDate,h)<end);return r;})}};
   const counts={7:{n:0,d:0},30:{n:0,d:0}};for(const {first:f,joins}of repeat.values()){if(!f?.finished||f.forfeited||f.status!=='completed'||!Number.isFinite(f.completed))continue;const d=day(f.completed);if(d<shift(end,-89)||d>end)continue;for(const h of [7,30])if(f.completed<=ms(generatedAt)-h*86400000){counts[h].d++;if(joins.some(([id,t])=>id!==f.id&&t>f.completed&&t<=f.completed+h*86400000))counts[h].n++;}}
   blocks['dashboard-retention-mature']={retention:{secondRaceWithin7d:ratio(counts[7].n,counts[7].d),secondRaceWithin30d:ratio(counts[30].n,counts[30].d)}};
  }
  return {blocks,diagnostics:diagnostics()};
 }
 function diagnostics(){sample();return {stateBytes,workerPeakHeapBytes:peakHeap,workerPeakExternalBytes:peakExternal};}
 return {consume,finish};
}
if(parentPort){const started=performance.now(),cpuStarted=typeof process.threadCpuUsage==='function'?process.threadCpuUsage():null;let processingMs=0;try{const accumulator=createAccumulator(workerData);parentPort.on('message',message=>{try{if(message.type==='batch'){const at=performance.now();accumulator.consume(message.source,message.rows);processingMs+=performance.now()-at;parentPort.postMessage({id:message.id,ack:true});}else if(message.type==='finish'){const at=performance.now();const value=accumulator.finish();processingMs+=performance.now()-at;const cpu=cpuStarted?process.threadCpuUsage(cpuStarted):null;value.diagnostics.workerMs=processingMs;value.diagnostics.workerElapsedMs=performance.now()-started;value.diagnostics.workerCpuMs=cpu?(cpu.user+cpu.system)/1000:null;parentPort.postMessage({id:message.id,value});}}catch(error){parentPort.postMessage({id:message.id,error:error.message});}});parentPort.postMessage({id:0,ack:true});}catch(error){parentPort.postMessage({id:0,error:error.message});}}
module.exports={createAccumulator};
