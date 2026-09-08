const PRODUCTS = Object.freeze([
  { id:'coins_500',kind:'coins',coins:500,credits:0,plan:null,ios:'bara_coins_500_v1',android:'bara_coins_500_v1' },
  { id:'coins_2800',kind:'coins',coins:2800,credits:0,plan:null,ios:'bara_coins_2800_v1',android:'bara_coins_2800_v1' },
  { id:'coins_6000',kind:'coins',coins:6000,credits:0,plan:null,ios:'bara_coins_6000_v1',android:'bara_coins_6000_v1' },
  { id:'plus_monthly',kind:'subscription',coins:500,credits:10,plan:'monthly',ios:'bara_plus_monthly_v1',android:'bara_plus_v1:monthly' },
  { id:'plus_permanent',kind:'non_consumable',coins:500,credits:10,plan:'permanent',ios:'bara_plus_permanent_v1',android:'bara_plus_permanent_v1' },
  { id:'plus_annual',kind:'subscription',coins:6000,credits:120,plan:'annual',ios:'bara_plus_annual_v1',android:'bara_plus_v1:annual' },
].map(Object.freeze));
function catalogFor(platform) { return PRODUCTS.filter(p=>p.id!=='plus_annual').map(p=>({id:p.id,kind:p.kind,coins:p.coins,credits:p.credits,plan:p.plan,storeProductId:p[platform]})); }
function readBillingConfig(env=process.env) {
 return {projectId:env.REVENUECAT_PROJECT_ID,secretApiKey:env.REVENUECAT_SECRET_API_KEY,iosAppId:env.REVENUECAT_IOS_APP_ID,androidAppId:env.REVENUECAT_ANDROID_APP_ID,webhookAuthorization:env.REVENUECAT_WEBHOOK_AUTHORIZATION,termsUrl:env.BILLING_TERMS_URL,privacyUrl:env.BILLING_PRIVACY_URL};
}
function configured(config) {
 return ['projectId','secretApiKey','iosAppId','androidAppId','webhookAuthorization'].every(k=>typeof config[k]==='string' && config[k].trim()) && ['termsUrl','privacyUrl'].every(k=>{try{return new URL(config[k]).protocol==='https:';}catch{return false;}});
}
module.exports={PRODUCTS,catalogFor,readBillingConfig,configured};
