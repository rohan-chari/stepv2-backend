// Public interface of the social module (audit Phase 9j): friends + referrals
// routers, the Friendship model (competition invites + leaderboard consume it),
// referral commands (users' sign-in services call recordReferral by CONCRETE
// path, not this index — see the 9i cycle lesson), race chat, and the referral
// preview the web landing page renders.
//
// Populated incrementally, routers LAST (9i lesson): this module both consumes
// and is consumed by modules/users, so mid-cycle requires must see models and
// commands already present on the exports object.
Object.assign(module.exports, require("./models/friendship"));
Object.assign(module.exports, require("./models/raceMessage"));
Object.assign(module.exports, require("./referralRewards"));
Object.assign(module.exports, require("./queries/getFriends"));
Object.assign(module.exports, require("./queries/searchUsers"));
Object.assign(module.exports, require("./queries/getReferralPreview"));
Object.assign(module.exports, require("./queries/getReferralStatus"));
Object.assign(module.exports, require("./queries/getRaceMessages"));
Object.assign(module.exports, require("./commands/sendFriendRequest"));
Object.assign(module.exports, require("./commands/respondToFriendRequest"));
Object.assign(module.exports, require("./commands/removeFriend"));
Object.assign(module.exports, require("./commands/updateRelationshipType"));
Object.assign(module.exports, require("./commands/getOrCreateReferralCode"));
Object.assign(module.exports, require("./commands/recordReferral"));
Object.assign(module.exports, require("./commands/redeemReferralCode"));
Object.assign(module.exports, require("./commands/grantReferralReward"));
Object.assign(module.exports, require("./commands/sendRaceMessage"));
Object.assign(module.exports, require("./commands/deleteRaceMessage"));
Object.assign(module.exports, require("./routes/friends")); // createFriendsRouter
Object.assign(module.exports, require("./routes/referrals")); // createReferralsRouter
