const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const express = require("express");

const {
  AppError,
  NotFoundError,
  ValidationError,
  ForbiddenError,
  ConflictError,
} = require("../../src/shared/errors/AppError");
const { errorMiddleware } = require("../../src/shared/http/errorMiddleware");
const { asyncHandler } = require("../../src/shared/http/asyncHandler");

// Exercises the shared error stack through a real Express app over real HTTP,
// the same way a migrated route will use it: async handler throws → asyncHandler
// forwards to next(err) → central errorMiddleware shapes the response.
async function startServer() {
  const app = express();

  app.get(
    "/not-found",
    asyncHandler(async () => {
      throw new NotFoundError("Race not found", "RACE_NOT_FOUND");
    })
  );
  app.get(
    "/invalid",
    asyncHandler(async () => {
      throw new ValidationError("displayName is required");
    })
  );
  app.get(
    "/forbidden",
    asyncHandler(async () => {
      throw new ForbiddenError();
    })
  );
  app.get(
    "/conflict",
    asyncHandler(async () => {
      throw new ConflictError("Display name already taken", "DISPLAY_NAME_TAKEN");
    })
  );
  app.get(
    "/meta",
    asyncHandler(async () => {
      throw new AppError("Not enough coins", "INSUFFICIENT_COINS", 400, {
        required: 75,
        held: 10,
      });
    })
  );
  app.get(
    "/legacy",
    asyncHandler(async () => {
      const err = new Error("Tournament is full");
      err.statusCode = 409;
      throw err;
    })
  );
  app.get(
    "/boom",
    asyncHandler(async () => {
      throw new Error("kaboom");
    })
  );

  app.use(errorMiddleware);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("shared error middleware maps AppError subclasses to status + JSON contract", async () => {
  const server = await startServer();
  try {
    const cases = [
      ["/not-found", 404, { error: "Race not found", code: "RACE_NOT_FOUND" }],
      ["/invalid", 400, { error: "displayName is required", code: "VALIDATION_ERROR" }],
      ["/forbidden", 403, { error: "Forbidden", code: "FORBIDDEN" }],
      ["/conflict", 409, { error: "Display name already taken", code: "DISPLAY_NAME_TAKEN" }],
      [
        "/meta",
        400,
        { error: "Not enough coins", code: "INSUFFICIENT_COINS", required: 75, held: 10 },
      ],
    ];
    for (const [path, status, body] of cases) {
      const response = await fetch(`${server.baseUrl}${path}`);
      assert.equal(response.status, status, path);
      assert.deepEqual(await response.json(), body, path);
    }
  } finally {
    await server.close();
  }
});

test("legacy errors carrying a statusCode keep their status; unknown errors become opaque 500s", async () => {
  const server = await startServer();
  try {
    const legacy = await fetch(`${server.baseUrl}/legacy`);
    assert.equal(legacy.status, 409);
    assert.deepEqual(await legacy.json(), { error: "Tournament is full" });

    const boom = await fetch(`${server.baseUrl}/boom`);
    assert.equal(boom.status, 500);
    // Opaque body — internal message must not leak to the client.
    assert.deepEqual(await boom.json(), { error: "Internal server error" });
  } finally {
    await server.close();
  }
});
