const http = require("node:http");

async function main() {
  const db = require("../../../src/db");
  const { createApp } = require("../../../src/app");
  const server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const resetPath = "/internal/capacity/db-pool-measurement/reset";
  const requestReset = (runId, measurementId) => fetch(`${baseUrl}${resetPath}`, {
    method: "POST",
    headers: {
      "X-Capacity-Run-Id": runId,
      "X-Capacity-Measurement-Id": measurementId,
    },
  });

  const capacityMode = process.env.CAPACITY_MODE;
  process.env.CAPACITY_MODE = "false";
  const nonCapacityStatus = (await requestReset(process.env.CAPACITY_RUN_ID, "window-one")).status;
  process.env.CAPACITY_MODE = capacityMode;
  const wrongRunStatus = (await requestReset("wrong-run", "window-one")).status;

  if (!db.databasePoolTestSeam) throw new Error("database pool test seam is unavailable");
  const holdingClient = await db.databasePoolTestSeam.connect();
  const crossingCheckout = db.databasePoolTestSeam.connect();
  const waitingDeadline = Date.now() + 2000;
  while (db.getDbPoolPressure().waiting < 1 && Date.now() < waitingDeadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (db.getDbPoolPressure().waiting < 1) {
    throw new Error(`controlled pre-reset checkout did not queue: ${JSON.stringify(db.getDbPoolPressure())}`);
  }

  const firstResponse = await requestReset(process.env.CAPACITY_RUN_ID, "window-one");
  const first = await firstResponse.json();
  const secondResponse = await requestReset(process.env.CAPACITY_RUN_ID, "window-one");
  const second = await secondResponse.json();
  holdingClient.release();
  const crossingClient = await crossingCheckout;
  crossingClient.release();
  const afterCrossing = db.getDbPoolPressure();

  const newClient = await db.databasePoolTestSeam.connect();
  newClient.release();
  const afterNewCheckout = db.getDbPoolPressure();
  const healthResponse = await fetch(`${baseUrl}/health`);
  const health = await healthResponse.json();
  const healthPool = health.capacity.dbPool;

  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await db.prisma.$disconnect();
  process.stdout.write(`${JSON.stringify({
    nonCapacityStatus,
    wrongRunStatus,
    firstStatus: firstResponse.status,
    secondStatus: secondResponse.status,
    firstMeasurement: first.measurement,
    secondMeasurement: second.measurement,
    afterCrossing,
    afterNewCheckout,
    healthMeasurement: { id: healthPool.measurementId,
      generation: healthPool.measurementGeneration,
      startedAtMs: healthPool.measurementStartedAtMs },
  })}\n`);
}

main().then(() => process.exit(0)).catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
