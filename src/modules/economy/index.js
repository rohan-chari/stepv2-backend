// Public interface of the economy module (audit Phase 9l): daily-reward +
// ad-reward routes/commands/queries, balance config (runtime economy tuning —
// powerups-domain odds/upgrade utils consume balanceConfig by CONCRETE path,
// not this index, per the 9i cycle lesson), box odds, and AdMob SSV.
// NOTE: awardCoins/deductCoinsAtomic are NOT here — they are cross-cutting
// ledger primitives and live in shared/economy (see the Phase 9l disposition).
Object.assign(module.exports, require("./balanceConfig"));
Object.assign(module.exports, require("./balanceConfig.defaults"));
Object.assign(module.exports, require("./balanceSnapshot"));
Object.assign(module.exports, require("./dailyBoxOdds"));
Object.assign(module.exports, require("./admobSsv"));
Object.assign(module.exports, require("./adRewards"));
Object.assign(module.exports, require("./constants/dailyReward"));
Object.assign(module.exports, require("./queries/getDailyRewardStatus"));
Object.assign(module.exports, require("./queries/getAdCoinRewardStatus"));
Object.assign(module.exports, require("./queries/getAdExtraSpinStatus"));
Object.assign(module.exports, require("./commands/claimDailyReward"));
Object.assign(module.exports, require("./commands/claimDailyRewardBox"));
Object.assign(module.exports, require("./commands/claimExtraDailyRewardBox"));
Object.assign(module.exports, require("./commands/claimAdCoinReward"));
Object.assign(module.exports, require("./commands/grantAdReward"));
Object.assign(module.exports, require("./constants/interstitialAds"));
Object.assign(module.exports, require("./errors/interstitialAds"));
Object.assign(module.exports, require("./validation/interstitialAds"));
Object.assign(module.exports, require("./models/interstitialAdState"));
Object.assign(module.exports, require("./queries/getInterstitialEligibility"));
Object.assign(module.exports, require("./commands/issueInterstitialPermit"));
Object.assign(module.exports, require("./commands/confirmInterstitialImpression"));
Object.assign(module.exports, require("./commands/cancelInterstitialPermit"));
Object.assign(module.exports, require("./routes/coins")); // createCoinsRouter
Object.assign(module.exports, require("./routes/dailyReward")); // createDailyRewardRouter
Object.assign(module.exports, require("./routes/ads")); // createAdsRouter
