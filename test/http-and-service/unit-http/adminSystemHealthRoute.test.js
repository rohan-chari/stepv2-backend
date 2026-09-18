const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const test = require("node:test");

const { createAdminRouter } = require("../../src/modules/admin/routes");
const { errorMiddleware } = require("../../src/shared/http/errorMiddleware");

async function withServer(dependencies, run) {
  const app = express();
  app.use(express.json());
  app.use("/admin", createAdminRouter({
    requireAuth(req, _res, next) { req.user = { id: "admin" }; next(); },
    isAdminUser: () => true,
    ...dependencies,
  }));
  app.use(errorMiddleware);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("GET /admin/system-health delegates only the locked 60m window", async () => {
  const calls = [];
  await withServer({
    getSystemHealth: async (input) => {
      calls.push(input);
      return { schema: "admin-system-health-v1", status: "unavailable" };
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/system-health?window=60m`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { schema: "admin-system-health-v1", status: "unavailable" });
  });
  assert.deepEqual(calls, [{ window: "60m" }]);
});

test("GET /admin/system-health returns the standard INVALID_WINDOW envelope", async () => {
  const { ValidationError } = require("../../src/shared/errors/AppError");
  await withServer({
    getSystemHealth: async () => { throw new ValidationError("Unsupported system-health window", "INVALID_WINDOW"); },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/system-health?window=7d`);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "Unsupported system-health window",
      code: "INVALID_WINDOW",
    });
  });
});
