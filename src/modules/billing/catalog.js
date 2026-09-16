const GOLD_BENEFIT_VERSION = 'bara_gold_v1';
const GOLD_SUBSCRIPTION_GROUP = 'bara_gold_subscription_group_v1';
const GOLD_CHARACTER_PRODUCTS = Object.freeze({
  mouse: 'bara_character_mouse_v1',
  hedgehog: 'bara_character_hedgehog_v1',
  sea_lion: 'bara_character_sea_lion_v1',
});

const PRODUCTS = Object.freeze([
  { id:'coins_500',kind:'coins',coins:500,credits:0,plan:null,ios:'bara_coins_500_v1',android:'bara_coins_500_v1' },
  { id:'coins_2800',kind:'coins',coins:3000,credits:0,plan:null,ios:'bara_coins_2800_v1',android:'bara_coins_2800_v1' },
  { id:'coins_6000',kind:'coins',coins:7500,credits:0,plan:null,ios:'bara_coins_6000_v1',android:'bara_coins_6000_v1' },
  // The legacy amounts remain available only to records that predate the Gold
  // contract. New verified monthly history is stamped Gold by the provider.
  { id:'plus_weekly',kind:'subscription',coins:200,trialCoins:200,credits:0,plan:'weekly',gold:true,subscriptionGroup:GOLD_SUBSCRIPTION_GROUP,ios:'bara_plus_weekly_v1',android:'bara_plus_v1:weekly' },
  { id:'plus_monthly',kind:'subscription',coins:1000,trialCoins:1000,legacyCoins:500,credits:0,legacyCredits:10,plan:'monthly',gold:true,subscriptionGroup:GOLD_SUBSCRIPTION_GROUP,ios:'bara_plus_monthly_v1',android:'bara_plus_v1:monthly' },
  { id:'plus_permanent',kind:'non_consumable',coins:500,credits:10,plan:'permanent',ios:'bara_plus_permanent_v1',android:'bara_plus_permanent_v1' },
  { id:'plus_annual',kind:'subscription',coins:6000,credits:120,plan:'annual',ios:'bara_plus_annual_v1',android:'bara_plus_v1:annual' },
  { id:'character_mouse',kind:'non_consumable',coins:0,credits:0,plan:null,goldCharacterSku:'mouse',ios:GOLD_CHARACTER_PRODUCTS.mouse,android:GOLD_CHARACTER_PRODUCTS.mouse },
  { id:'character_hedgehog',kind:'non_consumable',coins:0,credits:0,plan:null,goldCharacterSku:'hedgehog',ios:GOLD_CHARACTER_PRODUCTS.hedgehog,android:GOLD_CHARACTER_PRODUCTS.hedgehog },
  { id:'character_sea_lion',kind:'non_consumable',coins:0,credits:0,plan:null,goldCharacterSku:'sea_lion',ios:GOLD_CHARACTER_PRODUCTS.sea_lion,android:GOLD_CHARACTER_PRODUCTS.sea_lion },
].map(Object.freeze));
function productForPurchase(product, goldContract) {
 if (goldContract || !product.gold) return product;
 return {...product, coins:product.legacyCoins ?? product.coins, trialCoins:0, credits:product.legacyCredits ?? product.credits};
}
function catalogFor(platform, { gold = false } = {}) {
 const products = gold
  ? PRODUCTS.filter(p => p.id === 'coins_500' || p.id === 'coins_2800' || p.id === 'coins_6000' || (p.gold && !['plus_annual','plus_permanent'].includes(p.id)))
  : PRODUCTS.filter(p => ['coins_500','coins_2800','coins_6000','plus_monthly'].includes(p.id));
 return products.map(p=>{
  const view=productForPurchase(p,gold);
  return {id:view.id,kind:view.kind,coins:view.coins,credits:view.credits,plan:view.plan,storeProductId:view[platform],...(gold&&view.gold?{trialCoins:view.trialCoins||0,benefitVersion:GOLD_BENEFIT_VERSION}: {})};
 });
}
function parseGoldMonthlyContractCutoverAt(value) {
 if (value == null || value === '') return null;
 if (typeof value !== 'string' || !value.endsWith('Z')) {
  throw new Error('BARA_GOLD_MONTHLY_CONTRACT_CUTOVER_AT must be an explicit UTC ISO-8601 timestamp ending in Z');
 }
 const parsed = new Date(value);
 if (!Number.isFinite(parsed.getTime())) {
  throw new Error('BARA_GOLD_MONTHLY_CONTRACT_CUTOVER_AT is not a valid UTC timestamp');
 }
 return parsed.toISOString();
}
function readBillingConfig(env=process.env) {
 return {projectId:env.REVENUECAT_PROJECT_ID,secretApiKey:env.REVENUECAT_SECRET_API_KEY,iosAppId:env.REVENUECAT_IOS_APP_ID,androidAppId:env.REVENUECAT_ANDROID_APP_ID,webhookAuthorization:env.REVENUECAT_WEBHOOK_AUTHORIZATION,termsUrl:env.BILLING_TERMS_URL,privacyUrl:env.BILLING_PRIVACY_URL,monthlyGoldContractCutoverAt:parseGoldMonthlyContractCutoverAt(env.BARA_GOLD_MONTHLY_CONTRACT_CUTOVER_AT)};
}
function configured(config, platform) {
 const present = key => typeof config[key] === 'string' && config[key].trim().length > 0;
 const storeConfigured = platform === undefined
  ? present('iosAppId') || present('androidAppId')
  : ['ios','android'].includes(platform) && present(`${platform}AppId`);
 // Checkout needs this device's store; account sync and background recovery
 // can operate as soon as either real store has been configured.
 return storeConfigured && ['projectId','secretApiKey','webhookAuthorization'].every(present) && ['termsUrl','privacyUrl'].every(k=>{try{return new URL(config[k]).protocol==='https:';}catch{return false;}});
}
module.exports={PRODUCTS,GOLD_BENEFIT_VERSION,GOLD_SUBSCRIPTION_GROUP,GOLD_CHARACTER_PRODUCTS,productForPurchase,catalogFor,parseGoldMonthlyContractCutoverAt,readBillingConfig,configured};
