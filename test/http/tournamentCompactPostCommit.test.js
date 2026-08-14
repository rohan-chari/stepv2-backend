const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");

const { startServer, request } = require("../integration/setup");

let server;
let detailCalls = 0;
let walletCalls = 0;

before(async () => {
  server = await startServer({
    requireAuth(req, _res, next) {
      req.user = { id: "viewer-1" };
      next();
    },
    appSettings: {
      async getFlag(key) {
        return key === "apiTournamentDetailV1Enabled";
      },
    },
    joinTournament: async () => ({ id: "tournament-1", legacy: true }),
    getTournamentDetail: async () => {
      detailCalls += 1;
      throw new Error("projection unavailable");
    },
    getTournamentActionWallet: async () => {
      walletCalls += 1;
      throw new Error("wallet unavailable");
    },
    logger: { log() {}, error() {}, warn() {} },
  });
});

after(async () => server.close());

test("committed compact join keeps 201 when both independent enrichments fail", async () => {
  const response = await request(
    server.baseUrl,
    "POST",
    "/tournaments/tournament-1/join?view=detail-v1"
  );
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    contract: "tournament-action-v1",
    tournament: null,
    projectionError: { code: "DETAIL_UNAVAILABLE" },
    wallet: null,
    walletError: { code: "WALLET_UNAVAILABLE" },
  });
  assert.equal(detailCalls, 1);
  assert.equal(walletCalls, 1);
});

test("legacy join remains byte-shaped and runs no optional enrichment", async () => {
  const response = await request(
    server.baseUrl,
    "POST",
    "/tournaments/tournament-1/join"
  );
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    tournament: { id: "tournament-1", legacy: true },
  });
  assert.equal(detailCalls, 1);
  assert.equal(walletCalls, 1);
});
