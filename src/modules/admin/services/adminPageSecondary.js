// Pure planning and incremental calculation for the three smaller admin pages.
// No application, DB client or cache imports: also loaded inside the worker.
const inWindow=column=>`${column} >= (($1::date::timestamp AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC') AND ${column} < ((($2::date+1)::timestamp AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC')`;
function secondarySources({view,start,end,generatedAt,identity}){
 const sources=[],add=(name,text,values=[])=>sources.push({name,text,values});
 const eligible="r.seed_id IS NULL AND r.tournament_id IS NULL AND r.status<>'cancelled' AND c.is_review_account=false";
 if(view==='races'){
  add('raceUsers','SELECT id FROM users WHERE is_review_account=false');
  add('raceCore',`SELECT r.id,r.created_at,r.started_at,r.completed_at,r.status,r.is_public FROM races r JOIN users c ON c.id=r.creator_id WHERE ${eligible}`);
  add('raceMembers',`SELECT rp.user_id,rp.race_id FROM race_participants rp JOIN races r ON r.id=rp.race_id JOIN users c ON c.id=r.creator_id JOIN users u ON u.id=rp.user_id WHERE ${eligible} AND rp.status='accepted' AND u.is_review_account=false`);
  add('raceFeatured',`SELECT r.id,r.status,r.started_at,r.completed_at,s.cadence,rp.user_id,rp.joined_at,u.is_review_account FROM races r JOIN race_seeds s ON s.id=r.seed_id LEFT JOIN race_participants rp ON rp.race_id=r.id AND rp.status='accepted' LEFT JOIN users u ON u.id=rp.user_id WHERE r.status<>'cancelled' AND s.cadence IN ('daily','weekly')`);
  add('raceRanked',`SELECT m.user_id FROM ranked_cohort_members m JOIN ranked_weeks w ON w.id=m.week_id JOIN users u ON u.id=m.user_id WHERE u.is_review_account=false AND w.starts_on<$2::date+1 AND w.ends_on>$1::date`,[start,end]);
  add('friends',"SELECT requester_id,addressee_id FROM friendships WHERE status='ACCEPTED'");
 }
 if(view==='invites'){
  const version=identity?.referralHmacVersion??-1;
  if(version>=1)add('inviteOpens',`SELECT lo.code,lo.ip_hash,lo.created_at FROM link_opens lo JOIN users owner ON owner.referral_code=lo.code WHERE owner.is_review_account=false AND lo.kind='referral' AND lo.ip_hash_version=$3 AND ${inWindow('lo.created_at')}`,[start,end,version]);
  add('invites',`SELECT r.referee_id,r.status FROM referrals r JOIN users u ON u.id=r.referee_id JOIN users owner ON owner.id=r.referrer_id WHERE u.is_review_account=false AND owner.is_review_account=false AND ${inWindow('u.created_at')}`,[start,end]);
  add('inviteJoined',`SELECT rp.user_id FROM race_participants rp JOIN referrals r ON r.referee_id=rp.user_id JOIN users u ON u.id=r.referee_id JOIN users owner ON owner.id=r.referrer_id WHERE rp.status='accepted' AND u.is_review_account=false AND owner.is_review_account=false AND ${inWindow('u.created_at')}`,[start,end]);
 }
 if(view==='onboarding'){
  add('onboardingStarts',`SELECT e.onboarding_session_id,e.user_id,e.occurred_at FROM activation_events e JOIN users u ON u.id=e.user_id WHERE e.name='onboarding_started' AND e.platform='ios' AND e.onboarding_session_id IS NOT NULL AND u.is_review_account=false AND e.occurred_at<=$3::timestamp-interval '24 hours' AND ${inWindow('e.occurred_at')}`,[start,end,generatedAt]);
  add('onboardingStages',`SELECT e.onboarding_session_id,e.user_id,e.occurred_at,CASE WHEN e.name='health_result' AND e.context->>'result'='granted' THEN 'health_granted' ELSE e.name END name FROM activation_events e JOIN users u ON u.id=e.user_id WHERE e.platform='ios' AND e.onboarding_session_id IS NOT NULL AND u.is_review_account=false AND e.name IN ('onboarding_started','health_cta_tapped','health_granted','health_result','health_escaped','health_probe_inconclusive','daily_intro_viewed','tutorial_opened','tutorial_skipped','demo_box_opened','demo_powerup_used','demo_won','tutorial_completed','home_reached') AND e.occurred_at >= (($1::date::timestamp AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC') AND e.occurred_at<=$2::timestamp`,[start,generatedAt]);
 }
 return sources;
}
function createSecondaryAccumulator({view,start,end,generatedAt,identity,budget,day,midnight,shift,ratio}){
 const put=(map,key,value,bytes=192)=>{if(!map.has(key))budget.charge(bytes+String(key).length*2);map.set(key,value);};
 const add=(set,key)=>{if(!set.has(key)){budget.charge(96+String(key).length*2);set.add(key);}};
 const time=v=>v==null?NaN:new Date(v).getTime();
 const users=new Map(),races=new Map(),live=new Map(),activeUsers=new Set(),activeDaily=new Set(),ranked=new Set(),featured={daily:{active:new Set(),joined:new Set()},weekly:{active:new Set(),joined:new Set()}};
 const dates=[];for(let d=start;d<=end;d=shift(d,1)){dates.push(d);if(view==='races')put(live,d,new Set());}budget.charge(dates.length*128);const dateBounds=dates.map(date=>[midnight(date),midnight(shift(date,1))]);
 let activeRaces=0,visibility=0,publicRaces=0,opens=0,nullHashOpens=0,signups=0,qualified=0,rewarded=0;const openGroups=new Map(),referees=new Map(),joined=new Set(),sessions=new Map();
 const stages=['onboarding_started','health_cta_tapped','health_granted','health_escaped','health_probe_inconclusive','daily_intro_viewed','tutorial_opened','tutorial_skipped','demo_box_opened','demo_powerup_used','demo_won','tutorial_completed','home_reached'];
 function consume(source,rows){for(const row of rows){
  if(source==='raceUsers')put(users,row.id,0,80);
  else if(source==='raceCore'){
   const created=day(row.created_at);if(created>=start&&created<=end){visibility++;if(row.is_public)publicRaces++;}if(row.status==='active')activeRaces++;
   put(races,row.id,{started:time(row.started_at),completed:row.completed_at==null?time(generatedAt):time(row.completed_at),active:row.status==='active'},128);
  }else if(source==='raceMembers'){
   const r=races.get(row.race_id);if(!r)continue;if(r.active)add(activeUsers,row.user_id);for(let i=0;i<dates.length;i++)if(r.started<dateBounds[i][1]&&r.completed>dateBounds[i][0])add(live.get(dates[i]),row.user_id);
  }else if(source==='raceFeatured'){
   if(row.cadence==='daily'&&row.status==='active')add(activeDaily,row.id);if(row.is_review_account!==false||!row.user_id)continue;const f=featured[row.cadence];if(!f)continue;
   if(row.started_at!=null&&day(row.started_at)<=end&&(row.completed_at==null||day(row.completed_at)>start))add(f.active,row.user_id);
   if(row.joined_at!=null){const date=day(row.joined_at);if(date>=start&&date<=end)add(f.joined,row.user_id);}
  }else if(source==='raceRanked')add(ranked,row.user_id);
  else if(source==='friends'){if(users.has(row.requester_id))users.set(row.requester_id,users.get(row.requester_id)+1);if(row.addressee_id!==row.requester_id&&users.has(row.addressee_id))users.set(row.addressee_id,users.get(row.addressee_id)+1);}
  else if(source==='inviteOpens'){
   opens++;if(row.ip_hash==null){nullHashOpens++;continue;}const key=JSON.stringify([row.code,row.ip_hash]);if(!openGroups.has(key))put(openGroups,key,[]);budget.charge(24);openGroups.get(key).push(time(row.created_at));
  }else if(source==='invites'){signups++;put(referees,row.referee_id,(referees.get(row.referee_id)||0)+1,80);if(['QUALIFIED','REWARDED'].includes(row.status))qualified++;if(row.status==='REWARDED')rewarded++;}
  else if(source==='inviteJoined')add(joined,row.user_id);
  else if(source==='onboardingStarts'){
   const at=time(row.occurred_at),previous=sessions.get(row.onboarding_session_id);if(!previous||at<previous.at)put(sessions,row.onboarding_session_id,{user:row.user_id,at,mask:0},192+row.user_id.length*2);
  }else if(source==='onboardingStages'){
   const s=sessions.get(row.onboarding_session_id);if(!s||s.user!==row.user_id)continue;const at=time(row.occurred_at),i=stages.indexOf(row.name);if(i>=0&&at>=s.at&&at<=s.at+86400000)s.mask|=1<<i;
  }
 }}
 function finish(){
  if(view==='races'){
   const counts={'0':0,'1':0,'2':0,'3-5':0,'6+':0};for(const n of users.values())counts[n<=2?String(n):n<=5?'3-5':'6+']++;
   return {'dashboard-summary':{summary:{races:{usersInActiveNonFeaturedRaces:activeUsers.size,activeNonFeaturedRaces:activeRaces,activeDailyRaces:activeDaily.size}}},'dashboard-engagement':{raceEngagement:{daily:dates.map(date=>({date,liveRaceParticipants:live.get(date).size})),visibility:{public:ratio(publicRaces,visibility),private:ratio(visibility-publicRaces,visibility)},featuredParticipation:Object.fromEntries(Object.entries(featured).map(([k,f])=>[k,{activeOverlapUsers:f.active.size,joinedWindowUsers:f.joined.size}])),rankedParticipationUsers:ranked.size}},'dashboard-activation':{activation:{friends:Object.entries(counts).map(([bucket,count])=>({bucket,ratio:ratio(count,users.size)}))}}};
  }
  if(view==='invites'){
   const at=identity.coverage.find(c=>c.metric==='referralHmacV'+identity.referralHmacVersion)?.operational_at;const mature=identity.referralHmacVersion>=1&&at!=null&&time(at)<=midnight(start);let unique=nullHashOpens;for(const list of openGroups.values()){list.sort((a,b)=>a-b);for(let i=0;i<list.length;i++)if(i===0||list[i]-list[i-1]>86400000)unique++;}let joinedCount=0;for(const id of joined)joinedCount+=referees.get(id)||0;
   return {'dashboard-funnels':{inviteFunnel:{linkOpens:mature?opens:null,uniqueLinkOpens:mature?unique:null,attributedSignups:signups,joinedRace:joinedCount,qualified,rewarded,openToSignup:ratio(signups,unique,mature),signupToJoinedRace:ratio(joinedCount,signups),joinedRaceToQualified:ratio(qualified,joinedCount),qualifiedToRewarded:ratio(rewarded,qualified)}}};
  }
  const counts=stages.map(()=>0);for(const s of sessions.values())for(let i=0;i<stages.length;i++)if(s.mask&(1<<i))counts[i]++;let previous=null;const side=new Set(['health_escaped','health_probe_inconclusive','tutorial_skipped']);return {'dashboard-funnels':{onboardingFunnel:{cohortWindowDays:dates.length,stages:stages.map((key,i)=>{const count=counts[i],item={key,count,previousSpineConversion:side.has(key)||previous==null?ratio(null,null,false):ratio(count,previous),startConversion:ratio(count,counts[0])};if(!side.has(key))previous=count;return item;})}}};
 }
 return {consume,finish};
}
module.exports={secondarySources,createSecondaryAccumulator};
