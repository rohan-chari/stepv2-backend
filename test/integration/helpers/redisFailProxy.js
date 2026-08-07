// Test-only TCP proxy in front of a real Redis that can be armed to fail
// SPECIFIC commands while letting everything else through.
//
// Why command-selective and not "just kill Redis": spec §8 test 5c has to prove
// the READ BYPASS breaker specifically. If Redis were simply down, reads would
// fall through to Postgres anyway and the test would pass with no breaker at
// all. The discriminating setup is: the invalidation (EVAL/DEL) fails, so a
// STALE list is still sitting in Redis, and reads must nevertheless serve
// Postgres — which only happens if the bypass is open.
//
// RESP note: we parse only the client -> server direction, and only far enough
// to read the command name of each complete request. Server -> client bytes are
// piped through untouched. When a command is failed we never forward it, so the
// upstream reply stream stays in lockstep with the requests we did forward.
const net = require("node:net");

function parseCommandName(buffer) {
  // Returns { name, length } for the first COMPLETE RESP request in `buffer`,
  // or null if more bytes are needed.
  if (buffer.length === 0) return null;

  // Inline command (e.g. "PING\r\n") — ioredis doesn't send these, but be safe.
  if (buffer[0] !== 0x2a /* '*' */) {
    const end = buffer.indexOf("\r\n");
    if (end === -1) return null;
    const line = buffer.slice(0, end).toString("utf8").trim();
    return { name: line.split(/\s+/)[0].toUpperCase(), length: end + 2 };
  }

  let offset = 0;
  const readLine = () => {
    const end = buffer.indexOf("\r\n", offset);
    if (end === -1) return null;
    const line = buffer.slice(offset, end).toString("utf8");
    offset = end + 2;
    return line;
  };

  const header = readLine();
  if (header === null) return null;
  const argc = Number(header.slice(1));
  if (!Number.isInteger(argc) || argc < 0) return null;

  let name = null;
  for (let i = 0; i < argc; i += 1) {
    const lenLine = readLine();
    if (lenLine === null) return null;
    const len = Number(lenLine.slice(1));
    if (!Number.isInteger(len) || len < 0) return null;
    if (offset + len + 2 > buffer.length) return null;
    if (i === 0) name = buffer.slice(offset, offset + len).toString("utf8").toUpperCase();
    offset += len + 2;
  }
  return { name, length: offset };
}

/**
 * @param {string} upstreamUrl e.g. redis://127.0.0.1:6379/15
 * @returns {Promise<{url: string, arm: (cmds: string[]) => void,
 *                    disarm: () => void, failedCount: () => number,
 *                    close: () => Promise<void>}>}
 *   `url` points at the proxy and keeps the upstream's path (db index).
 */
async function startRedisFailProxy(upstreamUrl) {
  const upstream = new URL(upstreamUrl);
  const upstreamHost = upstream.hostname;
  const upstreamPort = Number(upstream.port || 6379);

  let failCommands = new Set();
  let failed = 0;
  const sockets = new Set();

  const server = net.createServer((client) => {
    const target = net.connect({ host: upstreamHost, port: upstreamPort });
    sockets.add(client);
    sockets.add(target);

    let pending = Buffer.alloc(0);

    client.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const parsed = parseCommandName(pending);
        if (!parsed) break;
        const raw = pending.slice(0, parsed.length);
        pending = pending.slice(parsed.length);
        if (failCommands.has(parsed.name)) {
          failed += 1;
          client.write(`-ERR simulated ${parsed.name} failure\r\n`);
        } else {
          target.write(raw);
        }
      }
    });

    target.on("data", (chunk) => client.write(chunk));

    const teardown = () => {
      client.destroy();
      target.destroy();
      sockets.delete(client);
      sockets.delete(target);
    };
    client.on("error", teardown);
    target.on("error", teardown);
    client.on("close", teardown);
    target.on("close", teardown);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    url: `redis://127.0.0.1:${port}${upstream.pathname || ""}`,
    arm(commands) {
      failCommands = new Set(commands.map((c) => c.toUpperCase()));
    },
    disarm() {
      failCommands = new Set();
    },
    failedCount() {
      return failed;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { startRedisFailProxy };
