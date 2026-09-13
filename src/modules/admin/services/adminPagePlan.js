const {buildWindow,AdminStatsRequestError}=require('../adminMetricsDashboard');
const VIEWS={overview:['dashboard-summary','dashboard-growth','dashboard-dau-engagement'],growth:['dashboard-growth'],activity:['dashboard-dau-engagement'],retention:['dashboard-summary','dashboard-retention','dashboard-retention-mature'],races:['dashboard-summary','dashboard-engagement','dashboard-activation'],invites:['dashboard-funnels'],onboarding:['dashboard-funnels'],ads:['dashboard-revenue','ads'],shop:['economy']};
function classifyView(options){if(options.view===undefined)return null;const view=options.view;if(typeof view!=='string'||!Object.hasOwn(VIEWS,view))throw new AdminStatsRequestError('Unknown admin view','INVALID_ADMIN_VIEW');const days=options.window===undefined?30:options.window==='7d'?7:options.window==='30d'?30:null;if(!days)throw new AdminStatsRequestError('Window must be 7d or 30d','INVALID_WINDOW');if(options.sections!==undefined){const hints=String(options.sections).split(',');if(hints.some(s=>!VIEWS[view].includes(s)||s==='dashboard-retention-mature'))throw new AdminStatsRequestError('Section does not belong to admin view','INVALID_ADMIN_VIEW');}return {mode:'view',view,days:view==='shop'?30:days};}
const bound=(column)=>`${column} >= (($1::date::timestamp AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC') AND ${column} < ((($2::date+1)::timestamp AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC')`;
const retained='u.is_review_account=false';
function planPage({view,days,generatedAt,identity}){
 const window=buildWindow(days,new Date(generatedAt)),{start,end}=window;const sources=[];
 const add=(name,text,values=[])=>sources.push({name,text,values});
 const action=['overview','activity','legacyDau'].includes(view);
 const growth=['overview','growth'].includes(view);
 if(growth||view==='retention')add('users',`SELECT id,created_at,${view==='retention'?'metrics_v2_signup_eligible,metrics_v2_signup_epoch_id':'metrics_v2_eligible_at,metrics_v2_eligible_epoch_id'} FROM users WHERE is_review_account=false`);
 if(growth){const activityStart=buildWindow(view==='growth'?30:days,new Date(generatedAt)).start;add('foreground',`SELECT a.user_id,a.activity_date::text FROM user_activity_days a JOIN users u ON u.id=a.user_id WHERE ${retained} AND a.activity_date BETWEEN $1::date AND $2::date`,[activityStart,end]);}
 if(view==='overview')add('currentRacers',`SELECT rp.user_id FROM race_participants rp JOIN races r ON r.id=rp.race_id JOIN users u ON u.id=rp.user_id JOIN users c ON c.id=r.creator_id WHERE rp.status='accepted' AND r.status='active' AND r.seed_id IS NULL AND r.tournament_id IS NULL AND ${retained} AND c.is_review_account=false`);
 if(action){
 const values=[view==='legacyDau'?buildWindow(61,new Date(generatedAt)).start:start,end];
 add('actionParticipation',`SELECT rp.user_id,rp.joined_at occurred_at FROM race_participants rp JOIN races r ON r.id=rp.race_id JOIN users u ON u.id=rp.user_id WHERE rp.status='accepted' AND ${retained} AND r.seed_id IS NULL AND r.tournament_id IS NULL AND r.status<>'cancelled' AND ${bound('rp.joined_at')}`,values);
 add('actionPower',`SELECT e.actor_user_id user_id,e.created_at occurred_at,e.event_type FROM race_powerup_events e JOIN users u ON u.id=e.actor_user_id WHERE e.event_type IN ('MYSTERY_BOX_OPENED','POWERUP_USED') AND ${retained} AND ${bound('e.created_at')}`,values);
 add('actionClaims',`SELECT c.user_id,c.created_at occurred_at FROM daily_reward_claims c JOIN users u ON u.id=c.user_id WHERE ${retained} AND ${bound('c.created_at')}`,values);
 add('actionNotifications',`SELECT d.user_id,d.opened_at occurred_at FROM push_deliveries d JOIN users u ON u.id=d.user_id WHERE d.opened_at IS NOT NULL AND d.provider_accepted_at IS NOT NULL AND ${retained} AND ${bound('d.opened_at')}`,values);
 add('actionAds',`SELECT g.user_id,g.created_at occurred_at FROM ad_reward_grants g JOIN users u ON u.id=g.user_id WHERE ${retained} AND ${bound('g.created_at')}`,values);
 add('actionLeaderboard',`SELECT e.user_id,e.occurred_at FROM activation_events e JOIN users u ON u.id=e.user_id WHERE e.name='race_leaderboard_viewed' AND ${retained} AND ${bound('e.occurred_at')}`,values);
 add('actionCreated',`SELECT r.creator_id user_id,r.created_at occurred_at FROM races r JOIN users u ON u.id=r.creator_id WHERE ${retained} AND r.seed_id IS NULL AND r.tournament_id IS NULL AND ${bound('r.created_at')}`,values);
 add('actionCompleted',`SELECT rp.user_id,rp.finished_at occurred_at FROM race_participants rp JOIN races r ON r.id=rp.race_id JOIN users u ON u.id=rp.user_id WHERE rp.finished_at IS NOT NULL AND r.status='completed' AND r.seed_id IS NULL AND r.tournament_id IS NULL AND ${retained} AND ${bound('rp.finished_at')}`,values);
 }
 if(view==='activity')add('eligibleRacers',`SELECT rp.user_id,u.metrics_v2_eligible_at,u.metrics_v2_eligible_epoch_id FROM race_participants rp JOIN users u ON u.id=rp.user_id JOIN races r ON r.id=rp.race_id JOIN users c ON c.id=r.creator_id WHERE rp.status='accepted' AND r.seed_id IS NULL AND r.tournament_id IS NULL AND r.status<>'cancelled' AND ${retained} AND c.is_review_account=false`);
 if(view==='ads')add('ads',`SELECT g.user_id,g.created_at,g.reward_kind,g.granted_date,u.is_review_account FROM ad_reward_grants g LEFT JOIN users u ON u.id=g.user_id WHERE g.created_at >= LEAST($1::timestamp-interval '30 days',(($2::date::timestamp AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC'))`,[generatedAt,start]);
 if(view==='shop'){
 add('shopPowerups',`SELECT s.sku,p.coins_spent coins FROM powerup_purchase_requests p JOIN powerup_shop_items s ON s.id=p.powerup_shop_item_id WHERE p.status='SUCCEEDED' AND p.created_at >= $1::timestamp-interval '30 days'`,[generatedAt]);
 add('shopItems',`SELECT s.sku,s.price_coins coins FROM user_shop_items p JOIN shop_items s ON s.id=p.shop_item_id WHERE p.purchased_at >= $1::timestamp-interval '30 days'`,[generatedAt]);
 }
 if(view==='retention'){
 // Exact horizon returns only; historical cohort dates are needed to select the
 // last 30 mature eligible dates, not a fixed recent 30-day approximation.
 add('retentionActivity',`SELECT a.user_id,a.activity_date::text FROM user_activity_days a JOIN users u ON u.id=a.user_id WHERE ${retained} AND u.metrics_v2_signup_eligible=true AND a.activity_date IN ((u.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date+1,(u.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date+7,(u.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date+30)`);
 add('repeatRaces',`SELECT rp.user_id,r.id race_id,COALESCE(r.started_at,r.created_at) race_at,r.completed_at,r.status,rp.finished_at,rp.forfeited_at,rp.joined_at FROM race_participants rp JOIN users u ON u.id=rp.user_id JOIN races r ON r.id=rp.race_id JOIN users c ON c.id=r.creator_id WHERE rp.status='accepted' AND r.seed_id IS NULL AND r.tournament_id IS NULL AND r.status<>'cancelled' AND ${retained} AND c.is_review_account=false`);
 }
 if(['races','invites','onboarding'].includes(view))sources.push(...require('./adminPageSecondary').secondarySources({view,start,end,generatedAt,identity}));
 return {view,days,generatedAt,window,sources};
}
module.exports={VIEWS,classifyView,planPage};
