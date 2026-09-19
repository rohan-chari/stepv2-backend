const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const root = path.resolve(__dirname, "..");
const shardCount = Math.max(
  1,
  Math.min(8, Number.parseInt(process.env.RELIABILITY_SHARDS || "4", 10) || 4),
);
const shardTimeoutMs = Math.max(
  60_000,
  Number.parseInt(process.env.RELIABILITY_SHARD_TIMEOUT_MS || "300000", 10) || 300000,
);
const liveOutput = process.env.RELIABILITY_LIVE_OUTPUT === "1";
const baseDatabaseUrl =
  process.env.DATABASE_URL ||
  "postgresql://rohan@localhost:5432/steps-tracker-integration_test";
const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const queueRedisUrl = process.env.QUEUE_REDIS_URL || redisUrl;
const baseRedisPrefix = process.env.CACHE_ENV_PREFIX || "reliability:";

function walkTestFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTestFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith(".test.js")) {
      out.push(path.relative(root, absolute));
    }
  }
  return out;
}

function shardDatabaseUrl(index) {
  const url = new URL(baseDatabaseUrl);
  const baseName = decodeURIComponent(url.pathname.slice(1));
  if (!/_test$/.test(baseName)) {
    throw new Error(
      'Sharded reliability runner requires a *_test database, got "' + baseName + '"',
    );
  }
  const stem = baseName.replace(/_test$/, "");
  url.pathname = "/" + stem + "_reliability_shard" + (index + 1) + "_test";
  return url.toString();
}

function weightOf(relativePath) {
  return fs.statSync(path.join(root, relativePath)).size;
}

function buildBalancedShards(files) {
  const shards = Array.from({ length: shardCount }, (_, index) => ({
    index,
    weight: 0,
    files: [],
  }));
  const ordered = [...files].sort((a, b) => weightOf(b) - weightOf(a));
  for (const file of ordered) {
    shards.sort((a, b) => a.weight - b.weight || a.index - b.index);
    const target = shards[0];
    const weight = weightOf(file);
    target.files.push(file);
    target.weight += weight;
  }
  return shards.sort((a, b) => a.index - b.index);
}

function pipeWithPrefix(stream, prefix, target) {
  const rl = readline.createInterface({ input: stream });
  rl.on("line", (line) => target.write(prefix + line + "\n"));
}

function parseSummary(output) {
  const read = (label) => {
    const re = new RegExp("(?:^|\\n)\\s*ℹ " + label + " ([0-9.]+)", "g");
    const matches = [...output.matchAll(re)];
    if (!matches.length) return null;
    return Number(matches[matches.length - 1][1]);
  };
  return {
    tests: read("tests"),
    suites: read("suites"),
    pass: read("pass"),
    fail: read("fail"),
    cancelled: read("cancelled"),
    skipped: read("skipped"),
    todo: read("todo"),
    durationMs: read("duration_ms"),
  };
}

function failureExcerpt(output) {
  const marker = "✖ failing tests:";
  const index = output.lastIndexOf(marker);
  if (index >= 0) return output.slice(index).trim();
  const lines = output.trim().split("\n");
  return lines.slice(Math.max(0, lines.length - 160)).join("\n");
}

function formatNumber(value) {
  return value == null || Number.isNaN(value) ? "?" : String(value);
}
function formatSeconds(ms) {
  return ms == null || Number.isNaN(ms) ? "?" : (ms / 1000).toFixed(1) + "s";
}

function runShard(shard, tempDir) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      DATABASE_URL: shardDatabaseUrl(shard.index),
      REDIS_URL: redisUrl,
      QUEUE_REDIS_URL: queueRedisUrl,
      CACHE_ENV_PREFIX: baseRedisPrefix + "shard:" + (shard.index + 1) + ":",
      RELIABILITY_SHARD_INDEX: String(shard.index + 1),
      RELIABILITY_SHARD_COUNT: String(shardCount),
    };
    const logPath = path.join(tempDir, "shard-" + (shard.index + 1) + ".log");
    const log = fs.createWriteStream(logPath, { flags: "w" });
    const child = spawn(
      process.execPath,
      [path.join(root, "scripts/run-local-integration-tests.cjs"), ...shard.files],
      { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    const prefix = "[reliability " + (shard.index + 1) + "/" + shardCount + "] ";

    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    if (liveOutput) {
      pipeWithPrefix(child.stdout, prefix, process.stdout);
      pipeWithPrefix(child.stderr, prefix, process.stderr);
    }

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    }, shardTimeoutMs);
    timeout.unref();

    let settled = false;
    const finish = (code, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      log.end(() => {
        const output = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
        resolve({
          shard,
          code: timedOut ? 124 : code,
          error: timedOut
            ? new Error("Reliability shard exceeded " + formatSeconds(shardTimeoutMs))
            : error,
          output,
          summary: parseSummary(output),
          timedOut,
        });
      });
    };
    child.on("error", (error) => finish(1, error));
    child.on("close", (code) => finish(code ?? 1));
  });
}

function printSummary(results, elapsedMs) {
  const total = results.reduce(
    (acc, result) => {
      for (const key of ["tests", "pass", "fail", "cancelled", "skipped", "todo"]) {
        if (result.summary[key] != null) acc[key] += result.summary[key];
      }
      return acc;
    },
    { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 },
  );

  process.stdout.write("\nReliability results\n\n");
  for (const result of results) {
    const s = result.summary;
    process.stdout.write(
      "Shard " + (result.shard.index + 1) + ": " +
      "tests " + formatNumber(s.tests) + " | " +
      "pass " + formatNumber(s.pass) + " | " +
      "fail " + formatNumber(s.fail) + " | " +
      "duration " + formatSeconds(s.durationMs) + " | " +
      "exit " + result.code + (result.timedOut ? " | TIMEOUT" : "") + "\n",
    );
  }
  process.stdout.write(
    "\nTotal: tests " + total.tests + " | pass " + total.pass + " | fail " + total.fail +
    " | cancelled " + total.cancelled + " | skipped " + total.skipped +
    " | todo " + total.todo + "\n",
  );
  process.stdout.write("Wall time: " + formatSeconds(elapsedMs) + "\n");

  const failed = results.filter(
    (result) => result.code !== 0 || (result.summary.fail || 0) > 0,
  );
  if (!failed.length) {
    process.stdout.write("\nAll reliability shards passed.\n");
    return;
  }

  process.stdout.write("\nFailed shards: " + failed.length + "\n");
  for (const result of failed) {
    process.stdout.write(
      "\n===== Reliability shard " + (result.shard.index + 1) + " failures =====\n",
    );
    if (result.error) process.stdout.write((result.error.stack || result.error.message) + "\n");
    const excerpt = failureExcerpt(result.output);
    if (excerpt) process.stdout.write(excerpt + "\n");
  }
}

async function main() {
  const reliabilityRoot = path.join(root, "test/reliability");
  const files = walkTestFiles(reliabilityRoot).sort();
  if (!files.length) throw new Error("No reliability test files found");

  const shards = buildBalancedShards(files);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bara-reliability-shards-"));
  const startedAt = Date.now();

  console.log(
    "Running " + files.length + " reliability files across " + shardCount +
    " isolated DB shards (timeout " + formatSeconds(shardTimeoutMs) + " each)...\n",
  );

  try {
    const results = await Promise.all(shards.map((shard) => runShard(shard, tempDir)));
    printSummary(results, Date.now() - startedAt);
    if (results.some((result) => result.code !== 0 || (result.summary.fail || 0) > 0)) {
      process.exitCode = 1;
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
