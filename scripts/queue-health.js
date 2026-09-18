#!/usr/bin/env node
require("dotenv").config();

const {
  STREAMS,
  GROUPS,
  queueHealth,
  withCommandClient,
  streamName,
  close,
} = require("../src/shared/queues/redisStreams");

async function main() {
  if (!process.env.QUEUE_REDIS_URL) {
    throw new Error("QUEUE_REDIS_URL is required");
  }

  const ping = await withCommandClient((redis) => redis.ping());
  if (ping !== "PONG") throw new Error(`queue Redis PING returned ${ping}`);

  const queues = [];
  let healthy = true;
  for (const key of Object.keys(STREAMS)) {
    const health = await queueHealth(STREAMS[key], GROUPS[key]);
    const streamLength = Number(await withCommandClient(
      (redis) => redis.xlen(streamName(STREAMS[key])),
    ));
    const row = {
      queue: key,
      stream: streamName(STREAMS[key]),
      group: GROUPS[key],
      streamLength,
      ...health,
    };
    if (row.consumerCount < 1) healthy = false;
    queues.push(row);
  }

  process.stdout.write(`${JSON.stringify({
    ok: healthy,
    ping: "PONG",
    checkedAt: new Date().toISOString(),
    queues,
  }, null, 2)}\n`);

  if (!healthy) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => close().catch(() => {}));
