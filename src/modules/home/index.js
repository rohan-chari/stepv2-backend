// modules/home — the aggregate home-tab endpoint. Composes races
// (getHomeRaceCard → races resolution stack, concrete paths), steps
// (milestones, global step events), and economy (ad extra-spin status).
// Router last, per the standing index-ordering rule.
Object.assign(module.exports, require("./getHomeRaceCard"));
Object.assign(module.exports, require("./routes"));
