// Public interface of the users module (audit Phase 9i): auth router, the User
// model (26 external consumers until their own modules land), identity/session
// services, the provider-sub hash (races' + social's abuse-proof one-time-grant
// key), and profile/account commands.
//
// Exports are populated INCREMENTALLY (mutating module.exports, router last):
// the auth router's dependency graph cycles back into this index (routes →
// services → social/race commands → this index), and mid-cycle consumers must
// already see User/hashAppleSub/the service surfaces on the shared exports
// object. A plain `module.exports = {...}` at the bottom would hand them an
// empty object instead.
Object.assign(module.exports, require("./models/user")); // User
Object.assign(module.exports, require("./appleSubHash")); // hashAppleSub
Object.assign(module.exports, require("./services/sessionToken"));
Object.assign(module.exports, require("./services/appleIdentityToken"));
Object.assign(module.exports, require("./services/googleIdentityToken"));
Object.assign(module.exports, require("./services/serializeAuthenticatedUser"));
Object.assign(module.exports, require("./services/discoverableName"));
Object.assign(module.exports, require("./services/profilePhotoStorage"));
Object.assign(module.exports, require("./services/ensureAppleUser"));
Object.assign(module.exports, require("./services/ensureGoogleUser"));
Object.assign(module.exports, require("./commands/setDisplayName"));
Object.assign(module.exports, require("./commands/setDiscoverableName"));
Object.assign(module.exports, require("./commands/deleteUserAccount"));
Object.assign(module.exports, require("./commands/setLeaderboardVisibility"));
Object.assign(module.exports, require("./commands/profilePhoto"));
Object.assign(module.exports, require("./routes")); // createAuthRouter — LAST
