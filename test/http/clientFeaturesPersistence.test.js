const assert = require("node:assert/strict");
const test = require("node:test");

const { buildRequireAuth } = require("../../src/middleware/requireAuth");

// TR-706: authenticated requests persist the user's last-seen X-Client-Features
// tokens — written only when the value changes (no hot write path).
function makeCtx({ storedFeatures = [], headerFeatures = null } = {}) {
  const state = { updates: [] };
  const user = {
    id: "user-1",
    displayName: "Tester",
    clientFeatures: storedFeatures,
  };
  const deps = {
    verifySessionToken: () => ({ sub: "user-1" }),
    User: {
      async findById() {
        return user;
      },
      async updateClientFeatures(id, features) {
        state.updates.push({ id, features });
        return { ...user, clientFeatures: features };
      },
    },
  };
  const req = {
    headers: { authorization: "Bearer session-token" },
    clientFeatures:
      headerFeatures === null ? new Set() : new Set(headerFeatures),
  };
  const res = {
    statusCode: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json() {},
  };
  return { state, deps, req, res };
}

function runMiddleware(requireAuth, req, res) {
  return new Promise((resolve) => {
    requireAuth(req, res, resolve).then?.(() => {});
    // requireAuth calls next() synchronously after awaits; resolve via next.
    setTimeout(resolve, 20);
  });
}

test("TR-706 first request with team_races persists the tokens", async () => {
  const ctx = makeCtx({ storedFeatures: [], headerFeatures: ["team_races"] });
  const requireAuth = buildRequireAuth(ctx.deps);
  await runMiddleware(requireAuth, ctx.req, ctx.res);
  assert.equal(ctx.state.updates.length, 1);
  assert.deepEqual(ctx.state.updates[0].features, ["team_races"]);
});

test("TR-706 a cached user does not rewrite the same new tokens on every launch request", async () => {
  const ctx = makeCtx({ storedFeatures: [], headerFeatures: ["team_races"] });
  const requireAuth = buildRequireAuth(ctx.deps);
  await runMiddleware(requireAuth, ctx.req, ctx.res);
  await runMiddleware(requireAuth, ctx.req, ctx.res);
  assert.equal(ctx.state.updates.length, 1);
});

test("TR-706 unchanged tokens are NOT rewritten (no hot write path)", async () => {
  const ctx = makeCtx({
    storedFeatures: ["team_races"],
    headerFeatures: ["team_races"],
  });
  const requireAuth = buildRequireAuth(ctx.deps);
  await runMiddleware(requireAuth, ctx.req, ctx.res);
  assert.equal(ctx.state.updates.length, 0);
});

test("TR-706 order/duplicates don't cause a rewrite", async () => {
  const ctx = makeCtx({
    storedFeatures: ["characters", "team_races"],
    headerFeatures: ["team_races", "characters", "team_races"],
  });
  const requireAuth = buildRequireAuth(ctx.deps);
  await runMiddleware(requireAuth, ctx.req, ctx.res);
  assert.equal(ctx.state.updates.length, 0);
});

// TR-706 is STICKY/UNION (product ruling 2026-07-15): once a token has been
// seen for a user it is never dropped. A stray header-less authed request must
// not flicker a friend to "needs update" (TR-707/708); a genuine app downgrade
// is rare and is still caught at accept time by TR-703's UPDATE_REQUIRED.
test("TR-706 a request with NO header does not clear previously-seen tokens", async () => {
  const ctx = makeCtx({
    storedFeatures: ["team_races"],
    headerFeatures: [], // header absent entirely
  });
  const requireAuth = buildRequireAuth(ctx.deps);
  await runMiddleware(requireAuth, ctx.req, ctx.res);
  assert.equal(ctx.state.updates.length, 0, "no write: nothing new to add");
});

test("TR-706 a request with FEWER tokens keeps the union (no downgrade)", async () => {
  const ctx = makeCtx({
    storedFeatures: ["characters", "team_races"],
    headerFeatures: ["characters"], // team_races missing this time
  });
  const requireAuth = buildRequireAuth(ctx.deps);
  await runMiddleware(requireAuth, ctx.req, ctx.res);
  assert.equal(ctx.state.updates.length, 0, "stored set already covers header");
});

test("TR-706 a NEW token is unioned onto the stored set", async () => {
  const ctx = makeCtx({
    storedFeatures: ["characters"],
    headerFeatures: ["team_races"],
  });
  const requireAuth = buildRequireAuth(ctx.deps);
  await runMiddleware(requireAuth, ctx.req, ctx.res);
  assert.equal(ctx.state.updates.length, 1);
  assert.deepEqual(
    ctx.state.updates[0].features,
    ["characters", "team_races"],
    "union, sorted — the old token is retained"
  );
});

test("TR-706 a persistence failure never breaks the request", async () => {
  const ctx = makeCtx({ storedFeatures: [], headerFeatures: ["team_races"] });
  ctx.deps.User.updateClientFeatures = async () => {
    throw new Error("db down");
  };
  const requireAuth = buildRequireAuth(ctx.deps);
  let nexted = false;
  await new Promise((resolve) => {
    requireAuth(ctx.req, ctx.res, () => {
      nexted = true;
      resolve();
    });
    setTimeout(resolve, 30);
  });
  assert.equal(nexted, true, "request proceeds despite write failure");
  assert.equal(ctx.res.statusCode, null);
});

test("admin metrics eligibility is stamped only once across a cached launch burst", async () => {
  const ctx = makeCtx({
    storedFeatures: ["admin_metrics_v2"],
    headerFeatures: ["admin_metrics_v2"],
  });
  let epochReads = 0;
  let stamps = 0;
  ctx.req.clientFeatures = new Set(["admin_metrics_v2"]);
  ctx.deps.appSettings = {
    async getFlag(name) {
      assert.equal(name, "adminMetricsV2TelemetryEnabled");
      return true;
    },
  };
  ctx.deps.prisma = {
    adminMetricsCollectionEpoch: {
      async findFirst() {
        epochReads += 1;
        return { id: "epoch-1" };
      },
    },
  };
  ctx.deps.User.stampMetricsV2Eligibility = async (id, epochId) => {
    assert.equal(id, "user-1");
    assert.equal(epochId, "epoch-1");
    stamps += 1;
  };
  const requireAuth = buildRequireAuth(ctx.deps);

  await runMiddleware(requireAuth, ctx.req, ctx.res);
  await runMiddleware(requireAuth, ctx.req, ctx.res);

  assert.equal(stamps, 1, "the first request owns the durable stamp");
  assert.equal(epochReads, 1, "the cached user suppresses later epoch reads");
});
