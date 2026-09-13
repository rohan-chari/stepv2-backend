// Deliberately DB-free: do not import the app, Prisma, settings, or cache here.
const { parentPort, workerData } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const formatter = new Intl.DateTimeFormat('en-CA', {timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
// Many users share the same first race; format each input timestamp only once.
// This worker handles one bounded build and exits, so this memo dies with it.
const dates = new Map();
const day = value => {
  const timestamp=value instanceof Date?value.getTime():Date.parse(value);
  if(!dates.has(timestamp))dates.set(timestamp,formatter.format(new Date(timestamp)));
  return dates.get(timestamp);
};
const shift = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`)+n*86400000).toISOString().slice(0,10);
const midnightDates=new Map();
const hourFormatter=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',hourCycle:'h23'});
function midnight(date) {
  if(midnightDates.has(date))return midnightDates.get(date);
  // At 00:00 UTC it is still the preceding ET evening. Its offset is the
  // offset at the requested ET midnight, including spring/fall transitions.
  const anchor = new Date(`${date}T00:00:00Z`);
  const hour = Number(hourFormatter.format(anchor));
  const value=anchor.getTime()+(24-hour)*3600000;
  midnightDates.set(date,value);return value;
}

function summarize(input) {
  const started=performance.now();
  const {users,races,participants,activity,tokens,identity,generatedAt}=input;
  const epoch=identity.epoch; const coverage=identity.coverage;
  const end=day(generatedAt); const userMap=new Map(users.map(u=>[u.id,u]));
  const reviewFree=users.filter(u=>!u.is_review_account);
  const fields=new Map();
  for(const p of participants) fields.set(p.race_id,(fields.get(p.race_id)||0)+1);
  const eligibleRaces=new Map(races.filter(r=>r.seed_id==null&&r.tournament_id==null&&r.status!=='cancelled'&&userMap.get(r.creator_id)?.is_review_account===false).map(r=>[r.id,r]));
  const memberships=new Map(); const racers=new Set(); const firstPower=new Map();
  const raceOrder=(a,b)=>Date.parse(a.started_at||a.created_at)-Date.parse(b.started_at||b.created_at)||a.id.localeCompare(b.id);
  for(const p of participants){
    const r=eligibleRaces.get(p.race_id); if(!r||userMap.get(p.user_id)?.is_review_account!==false)continue;
    racers.add(p.user_id);
    if(!memberships.has(p.user_id))memberships.set(p.user_id,[]);
    memberships.get(p.user_id).push({p,r});
    if(r.powerups_enabled&&(fields.get(r.id)||0)>=2){const prev=firstPower.get(p.user_id);if(!prev||raceOrder(r,prev)<0)firstPower.set(p.user_id,r);}
  }
  for(const list of memberships.values())list.sort((a,b)=>raceOrder(a.r,b.r));
  const activityDays=new Map();
  for(const a of activity){if(!activityDays.has(a.user_id))activityDays.set(a.user_id,new Set());activityDays.get(a.user_id).add(String(a.activity_date).slice(0,10));}
  const cohortRows=new Map(); const signups=reviewFree.map(u=>({u,date:day(u.created_at),eligible:Boolean(epoch&&u.metrics_v2_signup_eligible&&u.metrics_v2_signup_epoch_id===epoch.id)}));
  for(const {u,date,eligible} of signups){if(!eligible||date>end)continue; let row=cohortRows.get(date);if(!row){row={signup_date:date,eligible:0,d1:0,d7:0,d30:0};cohortRows.set(date,row);}row.eligible++;for(const h of [1,7,30])if(activityDays.get(u.id)?.has(shift(date,h)))row[`d${h}`]++;}
  const retention=[...cohortRows.values()].sort((a,b)=>a.signup_date.localeCompare(b.signup_date));
  const notificationUsers=new Set(tokens.filter(t=>epoch&&t.admin_metrics_open_epoch_id===epoch.id&&userMap.get(t.user_id)?.is_review_account===false).map(t=>t.user_id));
  const windows={};
  for(const days of [7,30,90]){
    const start=shift(end,1-days); const row={epoch_id:epoch?.id||null,epoch_started_at:epoch?.started_at||null,epoch_started_et_date:epoch?day(epoch.started_at):null,total:reviewFree.length,notification_eligible:notificationUsers.size,leaderboard_total:racers.size};
    for(const [metric,prefix] of [['boxOpen','box_open'],['firstRacePowerUse','first_power']]){const at=coverage.find(c=>c.metric===metric)?.operational_at;row[`${prefix}_at`]=at||null;row[`${prefix}_et_date`]=at?day(at):null;row[`${prefix}_full_window`]=at?Date.parse(at)<=midnight(start):null;}
    const fg={dau:0,wau:0,mau:0};
    for(const [h,name] of [[1,'dau'],[7,'wau'],[30,'mau']]){
      const boundary=shift(end,1-h);const at=midnight(boundary);
      row[`epoch_covers_${name}`]=Boolean(epoch&&Date.parse(epoch.started_at)<=at);
      const eligible=reviewFree.filter(u=>epoch&&u.metrics_v2_eligible_epoch_id===epoch.id&&u.metrics_v2_eligible_at&&Date.parse(u.metrics_v2_eligible_at)<=at);
      row[`capable_d${h}`]=eligible.length;
      fg[name]=eligible.filter(u=>[...(activityDays.get(u.id)||[])].some(d=>d>=start&&d>=boundary&&d<=end)).length;
      const mature=shift(end,-h-1);const cohortDates=new Set([...new Set(signups.filter(c=>c.eligible&&c.date<=mature).map(c=>c.date))].sort().slice(-30));
      row[`epoch_covers_signup_d${h}`]=Boolean(epoch&&Date.parse(epoch.started_at)<=midnight(mature));
      row[`signup_total_d${h}`]=signups.filter(c=>cohortDates.has(c.date)).length;
      row[`signup_eligible_d${h}`]=signups.filter(c=>c.eligible&&cohortDates.has(c.date)).length;
    }
    row.epoch_covers_selected_window=Boolean(epoch&&Date.parse(epoch.started_at)<=midnight(start));
    row.leaderboard_eligible=[...racers].filter(id=>{const u=userMap.get(id);return epoch&&u.metrics_v2_eligible_epoch_id===epoch.id&&u.metrics_v2_eligible_at&&Date.parse(u.metrics_v2_eligible_at)<=midnight(start);}).length;
    const selected=[...firstPower.values()].filter(r=>day(r.started_at||r.created_at)>=start&&day(r.started_at||r.created_at)<=end);
    row.first_power_total=selected.length;row.first_power_eligible=selected.filter(r=>row.first_power_at&&Date.parse(r.started_at||r.created_at)>=Date.parse(row.first_power_at)).length;
    const repeat={d7_den:0,d7_num:0,d30_den:0,d30_num:0};
    for(const list of memberships.values()){
      const first=list[0];if(!first.p.finished_at||first.p.forfeited_at||!first.r.completed_at||first.r.status!=='completed')continue;
      const completed=Date.parse(first.r.completed_at),date=day(first.r.completed_at);if(date<start||date>end)continue;
      for(const h of [7,30])if(completed<=Date.parse(generatedAt)-h*86400000){repeat[`d${h}_den`]++;if(list.some(({p,r})=>r.id!==first.r.id&&Date.parse(p.joined_at)>completed&&Date.parse(p.joined_at)<=completed+h*86400000))repeat[`d${h}_num`]++;}
    }
    windows[start]={coverage:row,foreground:fg,repeat};
  }
  return {generatedAt,end,windows,retention,diagnostics:{workerMs:performance.now()-started,workerHeapBytes:process.memoryUsage().heapUsed}};
}
if(parentPort){try{parentPort.postMessage({value:summarize(workerData)});}catch(error){parentPort.postMessage({error:error.message});}}
module.exports={summarize};
