#!/usr/bin/env node
require("dotenv").config();

const {
  STREAMS,
  GROUPS,
  ensureGroup,
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

  const rows = [];
  for (const key of Object.keys(STREAMS)) {
    await ensureGroup(STREAMS[key], GROUPS[key]);
    const length = Number(await withCommandClient(
      (redis) => redis.xlen(streamName(STREAMS[key])),
    ));
    rows.push({
      queue: key,
      stream: streamName(STREAMS[key]),
      group: GROUPS[key],
      streamLength: length,
      groupReady: true,
    });
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    ping: "PONG",
    queues: rows,
  }, null, 2)}\n`);
}

main()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => close().catch(() => {}));
