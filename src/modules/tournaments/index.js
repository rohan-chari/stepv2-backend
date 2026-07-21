// Public interface of the tournaments module (audit Phase 9n-2, first half of
// the finale). The four tournaments→races imports (raceBaseline,
// completeRace, validateRaceConfig, raceIllusions) intentionally still point at
// the OLD src/ paths until modules/races lands (9n-3) — they are the sanctioned
// half of the kept races⇄tournaments cycle and must stay CONCRETE paths, never
// index-level (9m lesson). Incremental exports, router last; races-domain
// consumers (completeRace, raceExpiry, getRaceProgress/Details, routes/races)
// import this module's files by concrete path for the same reason.
Object.assign(module.exports, require("./models/tournament"));
Object.assign(module.exports, require("./constants/tournaments"));
Object.assign(module.exports, require("./services/tournamentErrors"));
Object.assign(module.exports, require("./services/tournamentAccess"));
Object.assign(module.exports, require("./services/tournamentLock"));
Object.assign(module.exports, require("./services/tournamentBuyIns"));
Object.assign(module.exports, require("./services/tournamentParticipants"));
Object.assign(module.exports, require("./services/tournamentRounds"));
Object.assign(module.exports, require("./services/tournamentStart"));
Object.assign(module.exports, require("./queries/serializeTournament"));
Object.assign(module.exports, require("./queries/getTournament"));
Object.assign(module.exports, require("./queries/getTournamentsForUser"));
Object.assign(module.exports, require("./queries/getPublicTournaments"));
Object.assign(module.exports, require("./queries/getSharedTournamentPreview"));
Object.assign(module.exports, require("./commands/joinTournamentCore"));
Object.assign(module.exports, require("./commands/createTournament"));
Object.assign(module.exports, require("./commands/joinTournament"));
Object.assign(module.exports, require("./commands/joinTournamentByShareToken"));
Object.assign(module.exports, require("./commands/respondToTournamentInvite"));
Object.assign(module.exports, require("./commands/inviteToTournament"));
Object.assign(module.exports, require("./commands/leaveTournament"));
Object.assign(module.exports, require("./commands/kickTournamentParticipant"));
Object.assign(module.exports, require("./commands/startTournament"));
Object.assign(module.exports, require("./commands/forfeitTournament"));
Object.assign(module.exports, require("./commands/cancelTournament"));
Object.assign(module.exports, require("./commands/createTournamentShareLink"));
Object.assign(module.exports, require("./commands/advanceTournament"));
Object.assign(module.exports, require("./jobs/tournamentSeedRenewal"));
Object.assign(module.exports, require("./routes")); // createTournamentsRouter — LAST
