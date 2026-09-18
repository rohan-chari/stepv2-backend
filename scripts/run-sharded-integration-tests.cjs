const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const root = path.resolve(__dirname, "..");
const shardCount = Math.max(
  1,
  Math.min(8, Number.parseInt(process.env.INTEGRATION_SHARDS || "4", 10) || 4),
);
const baseDatabaseUrl =
  process.env.DATABASE_URL ||
  "postgresql://rohan@localhost:5432/steps-tracker-integration_test";
const redisUrl = process.env.REDIS_URL || "";
const baseRedisPrefix = process.env.CACHE_ENV_PREFIX || "integration:";

function walkTestFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTestFiles(absolute));
    } else if (entry.isFile() && entry.name.endsWith(".test.js")) {
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
      `Sharded integration runner requires a *_test database, got "${baseName}"`,
    );
  }
  const stem = baseName.replace(/_test$/, "");
  url.pathname = `/${stem}_shard${index + 1}_test`;
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
  rl.on("line", (line) => target.write(`${prefix}${line}\n`));
}

function runShard(shard) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      DATABASE_URL: shardDatabaseUrl(shard.index),
      REDIS_URL: redisUrl,
      CACHE_ENV_PREFIX: `${baseRedisPrefix}shard:${shard.index + 1}:`,
      INTEGRATION_SHARD_INDEX: String(shard.index + 1),
      INTEGRATION_SHARD_COUNT: String(shardCount),
    };
    const child = spawn(
      process.execPath,
      [
        path.join(root, "scripts/run-local-integration-tests.cjs"),
        ...shard.files,
      ],
      {
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const prefix = `[shard ${shard.index + 1}/${shardCount}] `;
    pipeWithPrefix(child.stdout, prefix, process.stdout);
    pipeWithPrefix(child.stderr, prefix, process.stderr);
    child.on("error", (error) => {
      process.stderr.write(`${prefix}${error.stack || error.message}\n`);
      resolve({ shard, code: 1 });
    });
    child.on("close", (code) => resolve({ shard, code: code ?? 1 }));
  });
}

async function main() {
  const integrationRoot = path.join(root, "test/integration");
  const files = walkTestFiles(integrationRoot).sort();
  if (!files.length) throw new Error("No integration test files found");

  const shards = buildBalancedShards(files);
  console.log(
    `[integration-shards] files=${files.length} shards=${shardCount} strategy=file-size-lpt`,
  );
  for (const shard of shards) {
    console.log(
      `[integration-shards] shard=${shard.index + 1} files=${shard.files.length} weightBytes=${shard.weight}`,
    );
    for (const file of shard.files) console.log(`  - ${file}`);
  }

  const startedAt = Date.now();
  const results = await Promise.all(shards.map(runShard));
  const elapsedMs = Date.now() - startedAt;
  const failed = results.filter((result) => result.code !== 0);

  for (const result of results) {
    console.log(
      `[integration-shards] shard=${result.shard.index + 1} exit=${result.code}`,
    );
  }
  console.log(
    `[integration-shards] complete elapsedMs=${elapsedMs} failedShards=${failed.length}`,
  );
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
