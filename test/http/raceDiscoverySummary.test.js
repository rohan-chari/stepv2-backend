const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");
const express = require("express");
const { createRacesRouter } = require("../../src/routes/races");

function auth(features = []) {
  return (req, _res, next) => {
    req.user = { id: "user-1" };
    req.timeZone = "UTC";
    req.clientFeatures = new Set(features);
    next();
  };
}

async function withServer(deps, features, run) {
  const app = express();
  app.use(express.json());
  app.use("/races", createRacesRouter({ requireAuth: auth(features), ...deps }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

const SUMMARY = {
  publicRaceCount: 12,
  featuredRaces: [{ raceId: "r1", seedKind: "DAILY_10K" }],
  featuredTournaments: [],
  resolved: { publicRaceCount: true, featuredRaces: true, featuredTournaments: true },
};

test("GET /races/discovery-summary returns the compact shape (200)", async () => {
  let received;
  await withServer(
    { getRaceDiscoverySummary: async (args) => { received = args; return SUMMARY; } },
    ["tournaments", "team_races"],
    async (base) => {
      const res = await fetch(`${base}/races/discovery-summary`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), SUMMARY);
    }
  );
  assert.equal(received.supportsTournaments, true);
  assert.equal(received.supportsTeamRaces, true);
});

test("discovery-summary passes capability flags false for old clients", async () => {
  let received;
  await withServer(
    { getRaceDiscoverySummary: async (args) => { received = args; return SUMMARY; } },
    [],
    async (base) => {
      const res = await fetch(`${base}/races/discovery-summary`);
      assert.equal(res.status, 200);
    }
  );
  assert.equal(received.supportsTournaments, false);
  assert.equal(received.supportsTeamRaces, false);
});

test("discovery-summary route error → 500 with the standard shape", async () => {
  await withServer(
    { getRaceDiscoverySummary: async () => { throw new Error("boom"); } },
    [],
    async (base) => {
      const res = await fetch(`${base}/races/discovery-summary`);
      assert.equal(res.status, 500);
      assert.equal((await res.json()).error, "Internal server error");
    }
  );
});
