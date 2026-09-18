const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");

const { createRacesRouter } = require("../../src/modules/races/routes");
const { TEAM_NAME_POOL } = require("../../src/modules/races/constants/teamNames");
const { censor } = require("../../src/shared/lib/profanity");

// FRONTEND QUESTION 1 (TR-103 + TR-801): the create screen shows the two team
// name plaques with a dice-reroll BEFORE the race exists, so it needs the real
// backend pool. Without this the client ships its own divergent local pool and
// the plaques show names the ≥50-name backend pool doesn't contain.
function startServer() {
  const express = require("express");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "user-1" };
    next();
  });
  app.use(
    "/races",
    createRacesRouter({
      requireAuth: (req, _res, next) => next(),
    })
  );
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      })
    );
  });
}

test("TR-103 GET /races/team-names/suggest returns two distinct names from the pool", async () => {
  const server = await startServer();
  try {
    const res = await fetch(`${server.url}/races/team-names/suggest`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(TEAM_NAME_POOL.includes(body.teamAName), "teamAName from the pool");
    assert.ok(TEAM_NAME_POOL.includes(body.teamBName), "teamBName from the pool");
    assert.notEqual(
      body.teamAName.toLowerCase(),
      body.teamBName.toLowerCase(),
      "the pair must differ"
    );
  } finally {
    await server.close();
  }
});

test("TR-103 each call re-rolls (the dice button gets fresh names)", async () => {
  const server = await startServer();
  try {
    const seen = new Set();
    for (let i = 0; i < 25; i++) {
      const body = await (
        await fetch(`${server.url}/races/team-names/suggest`)
      ).json();
      assert.notEqual(body.teamAName.toLowerCase(), body.teamBName.toLowerCase());
      seen.add(`${body.teamAName}|${body.teamBName}`);
    }
    assert.ok(seen.size > 1, "repeated calls produce varying pairs");
  } finally {
    await server.close();
  }
});

// TR-103: the suggest endpoint feeds the create-screen plaques directly, so
// whatever it hands the client must already be clean — the client shows it
// verbatim and echoes it back as an override.
test("TR-103 suggested names are clean and distinct across many rolls", async () => {
  const server = await startServer();
  try {
    for (let i = 0; i < 30; i++) {
      const body = await (
        await fetch(`${server.url}/races/team-names/suggest`)
      ).json();
      assert.equal(censor(body.teamAName), body.teamAName, `profane: ${body.teamAName}`);
      assert.equal(censor(body.teamBName), body.teamBName, `profane: ${body.teamBName}`);
      assert.notEqual(body.teamAName.toLowerCase(), body.teamBName.toLowerCase());
      assert.ok(body.teamAName.length <= 24 && body.teamBName.length <= 24);
    }
  } finally {
    await server.close();
  }
});
