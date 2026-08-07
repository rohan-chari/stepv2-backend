// Test-only helper: obtain a REAL local Redis for the cache-wrapper integration
// tests. Never points at prod/staging Redis — it either uses an explicitly
// provided REDIS_TEST_URL, or spawns a throwaway `redis-server` on an ephemeral
// port with persistence disabled. If neither is possible the caller is expected
// to SKIP its live-Redis cases with an explicit reason (CI has no Redis today —
// see the spec's "suite must also pass with REDIS_URL unset" requirement).
const net = require("node:net");
const { spawn } = require("node:child_process");
const fs = require("node:fs");

const CANDIDATE_BINARIES = [
  "redis-server",
  "/opt/homebrew/opt/redis/bin/redis-server",
  "/opt/homebrew/bin/redis-server",
  "/usr/local/bin/redis-server",
  "/usr/bin/redis-server",
];

// Logical DB used by every test. Isolated from db0 (prod) / db1 (staging).
const TEST_DB = 15;

function findBinary() {
  for (const candidate of CANDIDATE_BINARIES) {
    if (candidate.includes("/")) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    // Bare name: rely on PATH resolution at spawn time; probe with `which`.
    const { execFileSync } = require("node:child_process");
    try {
      const resolved = execFileSync("which", [candidate], {
        encoding: "utf8",
      }).trim();
      if (resolved) return resolved;
    } catch {
      // not on PATH
    }
  }
  return null;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function canConnect(host, port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

/**
 * @returns {Promise<{url: string, close: () => Promise<void>} | null>}
 *          null when no local Redis can be made available.
 */
async function startTestRedis() {
  // Escape hatch for a Redis-less CI: forces the live cases to skip while the
  // REDIS_URL-unset cases still run.
  if (process.env.SKIP_LIVE_REDIS === "1") return null;

  if (process.env.REDIS_TEST_URL) {
    const parsed = new URL(process.env.REDIS_TEST_URL);
    const ok = await canConnect(
      parsed.hostname,
      Number(parsed.port || 6379)
    );
    if (ok) {
      return { url: process.env.REDIS_TEST_URL, close: async () => {} };
    }
  }

  // A developer-run local Redis on the default port is fine to borrow — we only
  // ever touch db15 and flush that one DB.
  if (await canConnect("127.0.0.1", 6379)) {
    return { url: `redis://127.0.0.1:6379/${TEST_DB}`, close: async () => {} };
  }

  const binary = findBinary();
  if (!binary) return null;

  const port = await freePort();
  const child = spawn(
    binary,
    [
      "--port",
      String(port),
      "--bind",
      "127.0.0.1",
      "--save",
      "",
      "--appendonly",
      "no",
      "--databases",
      "16",
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  const ready = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 10000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("Ready to accept connections")) {
        clearTimeout(timer);
        resolve(true);
      }
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });

  if (!ready) {
    try {
      child.kill("SIGKILL");
    } catch {}
    return null;
  }

  return {
    url: `redis://127.0.0.1:${port}/${TEST_DB}`,
    async close() {
      await new Promise((resolve) => {
        child.once("exit", resolve);
        child.kill("SIGTERM");
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {}
          resolve();
        }, 2000);
      });
    },
  };
}

/** A port nothing is listening on (bound then released). */
async function closedPort() {
  return freePort();
}

module.exports = { startTestRedis, closedPort, TEST_DB };
