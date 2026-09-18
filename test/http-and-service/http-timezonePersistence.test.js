const assert = require("node:assert/strict");
const test = require("node:test");

const { buildRequireAuth } = require("../../src/middleware/requireAuth");

// §7: authenticated requests sticky-write the user's IANA timezone from a valid
// X-Timezone header — written only when it changed, never when the header is
// absent/invalid (which would clobber a real zone with the default).
function makeCtx({ storedTimezone = null, header = undefined } = {}) {
  const state = { updates: [] };
  const user = { id: "user-1", displayName: "Tester", clientFeatures: [], timezone: storedTimezone };
  const deps = {
    verifySessionToken: () => ({ sub: "user-1" }),
    User: {
      async findById() {
        return user;
      },
      async updateTimezone(id, timezone) {
        state.updates.push({ id, timezone });
        return { ...user, timezone };
      },
    },
  };
  // extractTimezone normally sets req.timeZone; emulate it here.
  const isValid = (tz) => {
    if (!tz) return false;
    try {
      Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  };
  const req = {
    headers: { authorization: "Bearer session-token" },
    timeZone: isValid(header) ? header : "America/New_York",
  };
  if (header !== undefined) req.headers["x-timezone"] = header;
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
    setTimeout(resolve, 20);
  });
}

test("a valid new timezone is persisted", async () => {
  const ctx = makeCtx({ storedTimezone: null, header: "Asia/Kolkata" });
  await runMiddleware(buildRequireAuth(ctx.deps), ctx.req, ctx.res);
  assert.equal(ctx.state.updates.length, 1);
  assert.equal(ctx.state.updates[0].timezone, "Asia/Kolkata");
});

test("an unchanged timezone is NOT rewritten (no hot write path)", async () => {
  const ctx = makeCtx({ storedTimezone: "Asia/Kolkata", header: "Asia/Kolkata" });
  await runMiddleware(buildRequireAuth(ctx.deps), ctx.req, ctx.res);
  assert.equal(ctx.state.updates.length, 0);
});

test("a header-less request never clobbers a stored real zone with the default", async () => {
  const ctx = makeCtx({ storedTimezone: "Asia/Kolkata", header: undefined });
  await runMiddleware(buildRequireAuth(ctx.deps), ctx.req, ctx.res);
  assert.equal(ctx.state.updates.length, 0, "no write when the header is absent");
});

test("an invalid header does not write (extractTimezone squashed it to default)", async () => {
  const ctx = makeCtx({ storedTimezone: "Asia/Kolkata", header: "Not/AZone" });
  await runMiddleware(buildRequireAuth(ctx.deps), ctx.req, ctx.res);
  assert.equal(ctx.state.updates.length, 0);
});

test("a genuine change from one real zone to another is persisted", async () => {
  const ctx = makeCtx({ storedTimezone: "America/New_York", header: "Europe/London" });
  await runMiddleware(buildRequireAuth(ctx.deps), ctx.req, ctx.res);
  assert.equal(ctx.state.updates.length, 1);
  assert.equal(ctx.state.updates[0].timezone, "Europe/London");
});

test("a timezone write failure never breaks the request", async () => {
  const ctx = makeCtx({ storedTimezone: null, header: "Asia/Kolkata" });
  ctx.deps.User.updateTimezone = async () => {
    throw new Error("db down");
  };
  let nexted = false;
  await new Promise((resolve) => {
    buildRequireAuth(ctx.deps)(ctx.req, ctx.res, () => {
      nexted = true;
      resolve();
    });
    setTimeout(resolve, 30);
  });
  assert.equal(nexted, true);
  assert.equal(ctx.res.statusCode, null);
});
