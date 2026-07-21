// modules/steps — step recording/sync, streaks, milestones, global step events.
//
// Populated incrementally (models → utils → queries → commands → jobs →
// routers LAST) so cycle-adjacent races-domain files that require concrete
// files inside this module never observe a half-initialized index. The races
// domain (raceStateResolution, getRaceProgress, raceExpiry, …) imports this
// module's models by concrete path, never through this index — the
// steps ⇄ races cycle (recordSteps → raceStateResolution → models/steps)
// makes an index-level edge unsafe.
Object.assign(module.exports, require("./models/steps"));
Object.assign(module.exports, require("./models/stepSample"));
Object.assign(module.exports, require("./models/stepSyncRequest"));
Object.assign(module.exports, require("./models/globalStepEvent"));

Object.assign(module.exports, require("./streak"));
Object.assign(module.exports, require("./stepSyncCanonical"));
Object.assign(module.exports, require("./globalStepEvent"));
Object.assign(module.exports, require("./constants/stepMilestones"));

Object.assign(module.exports, require("./queries/getSteps"));
Object.assign(module.exports, require("./queries/getStepCalendar"));
Object.assign(module.exports, require("./queries/getStepMilestonesToday"));

Object.assign(module.exports, require("./commands/recordSteps"));
Object.assign(module.exports, require("./commands/recordStepSamples"));
Object.assign(module.exports, require("./commands/recordStepSyncV2"));
Object.assign(module.exports, require("./commands/claimStepMilestone"));

Object.assign(module.exports, require("./jobs/globalStepEventScheduler"));

Object.assign(module.exports, require("./routes/steps"));
Object.assign(module.exports, require("./routes/stepMilestones"));
