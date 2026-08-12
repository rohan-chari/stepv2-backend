// modules/races — the race domain: lifecycle commands, progress/list queries,
// the resolution stack, buy-ins, and race jobs.
//
// Populated incrementally (models → utils → constants → services → queries →
// commands → jobs → router LAST) so cycle-adjacent files never observe a
// half-initialized index. The races ⇄ tournaments cycle (completeRace ⇄
// advanceTournament and friends), the races ⇄ powerups cycle (usePowerup ⇄
// raceStateResolution), and the races ⇄ steps cycle (recordSteps ⇄
// raceStateResolution) are all crossed by CONCRETE file paths in both
// directions — nothing inside the resolution stack imports a module index,
// and other modules import this module's files concretely, never through
// this index. Only top-of-graph consumers (app.js, src/index.js) use it.
Object.assign(module.exports, require("./models/race"));
Object.assign(module.exports, require("./models/raceParticipant"));
Object.assign(module.exports, require("./models/racePayoutDouble"));
Object.assign(module.exports, require("./models/raceResolutionJob"));
Object.assign(module.exports, require("./models/raceResolutionJobV2"));

Object.assign(module.exports, require("./racePayoutPresets"));
Object.assign(module.exports, require("./raceSteps"));
Object.assign(module.exports, require("./raceTimeZone"));
Object.assign(module.exports, require("./teamRaces"));
Object.assign(module.exports, require("./constants/raceFinishReward"));
Object.assign(module.exports, require("./constants/teamNames"));

Object.assign(module.exports, require("./services/raceBaseline"));
Object.assign(module.exports, require("./services/raceBuyIns"));
Object.assign(module.exports, require("./services/raceIllusions"));
Object.assign(module.exports, require("./services/raceJoinLock"));
Object.assign(module.exports, require("./services/enqueueRaceResolution"));
Object.assign(module.exports, require("./services/withRaceResolutionLock"));
Object.assign(module.exports, require("./services/raceStateResolution"));
Object.assign(module.exports, require("./services/computeRaceState"));
Object.assign(module.exports, require("./services/racePowerupStateSync"));
Object.assign(module.exports, require("./services/reconcileUploaderRaces"));
Object.assign(module.exports, require("./services/validateRaceConfig"));
Object.assign(module.exports, require("./services/racePayoutDoublePolicy"));
Object.assign(module.exports, require("./services/withRacePayoutDoubleTransaction"));

Object.assign(module.exports, require("./queries/getRaceProgress"));
Object.assign(module.exports, require("./queries/getRaces"));
Object.assign(module.exports, require("./queries/getRacePayoutDoubleOffer"));
Object.assign(module.exports, require("./queries/getRaceDetails"));
Object.assign(module.exports, require("./queries/getRaceFeed"));
Object.assign(module.exports, require("./queries/getFeaturedRaces"));
Object.assign(module.exports, require("./queries/getPublicRaces"));
Object.assign(module.exports, require("./queries/getPublicRaceCount"));
Object.assign(module.exports, require("./queries/getRaceDiscoverySummary"));
Object.assign(module.exports, require("./queries/getSharedRacePreview"));

Object.assign(module.exports, require("./commands/joinRaceCore"));
Object.assign(module.exports, require("./commands/createRace"));
Object.assign(module.exports, require("./commands/createRaceShareLink"));
Object.assign(module.exports, require("./commands/editRace"));
Object.assign(module.exports, require("./commands/startRace"));
Object.assign(module.exports, require("./commands/completeRace"));
Object.assign(module.exports, require("./commands/forfeitRace"));
Object.assign(module.exports, require("./commands/cancelRace"));
Object.assign(module.exports, require("./commands/leaveRace"));
Object.assign(module.exports, require("./commands/kickRaceParticipant"));
Object.assign(module.exports, require("./commands/inviteToRace"));
Object.assign(module.exports, require("./commands/respondToRaceInvite"));
Object.assign(module.exports, require("./commands/joinPublicRace"));
Object.assign(module.exports, require("./commands/joinRaceByShareToken"));
Object.assign(module.exports, require("./commands/switchRaceTeam"));
Object.assign(module.exports, require("./commands/setRaceChatMute"));
Object.assign(module.exports, require("./commands/setRacePlacementMute"));
Object.assign(module.exports, require("./commands/markRaceResultsSeen"));
Object.assign(module.exports, require("./commands/createRacePayoutDoubleOffer"));
Object.assign(module.exports, require("./commands/claimRacePayoutDouble"));
Object.assign(module.exports, require("./commands/autoEnrollNewUser"));
Object.assign(module.exports, require("./commands/autoJoinFeaturedRaces"));

Object.assign(module.exports, require("./jobs/raceExpiry"));
Object.assign(module.exports, require("./jobs/raceResolutionQueue"));
// C0: the race-keyed worker. The v1 worker above stays exported (and its code
// present) for the reverse-handoff rollback, but src/index.js schedules ONLY v2.
Object.assign(module.exports, require("./jobs/raceResolutionQueueV2"));
Object.assign(module.exports, require("./jobs/autoStartScheduledRaces"));
Object.assign(module.exports, require("./jobs/placementRecompute"));
Object.assign(module.exports, require("./jobs/seededRaceRenewal"));
Object.assign(module.exports, require("./jobs/racePayoutDoubleReconcile"));

Object.assign(module.exports, require("./routes"));
