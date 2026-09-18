const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "../..");

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), "utf8");
}

test("backend operational docs have one live source of truth", () => {
  const operations = read("OPERATIONS.md");
  const agents = read("AGENTS.md");
  const claude = read("CLAUDE.md");
  const readme = read("README.md");
  const deployment = read("DEPLOYMENT.md");
  const deployRunbook = read("DEPLOY_RUNBOOK.md");
  const backup = read("BACKUP.md");
  const preDeploy = read("PRE_DEPLOY_README.md");
  const postDeploy = read("POST_DEPLOY_README.md");

  assert.match(readme, /OPERATIONS\.md/);
  assert.match(deployment, /OPERATIONS\.md/);
  assert.match(deployRunbook, /OPERATIONS\.md/);
  assert.match(backup, /OPERATIONS\.md/);
  assert.match(agents, /OPERATIONS\.md/);
  assert.match(claude, /AGENTS\.md/);
  assert.match(claude, /OPERATIONS\.md/);
  assert.match(operations, /PRE_DEPLOY_README\.md/);
  assert.match(operations, /POST_DEPLOY_README\.md/);

  for (const [name, source] of Object.entries({
    README: readme,
    DEPLOYMENT: deployment,
    DEPLOY_RUNBOOK: deployRunbook,
    BACKUP: backup,
  })) {
    assert.doesNotMatch(
      source,
      /pm2\s+(?:restart|reload)\s+\d+\b/i,
      `${name} must never direct operators to a numeric PM2 id`,
    );
  }

  assert.match(operations, /QUEUE_REDIS_URL/);
  assert.match(operations, /steps-tracker-notification/);
  assert.match(operations, /Reviewed aggregate database pool budget: \*\*39\*\*/);
  assert.match(operations, /ecosystem\.config\.js/);
  assert.match(operations, /pm2-safe-prod-reload\.sh/);

  assert.match(preDeploy, /queue Redis/i);
  assert.match(preDeploy, /DATABASE_POOL_TOTAL_BUDGET=39/);
  assert.match(preDeploy, /queues:preflight/);
  assert.match(preDeploy, /production database backup/i);
  assert.match(postDeploy, /queues:health/);
  assert.match(postDeploy, /steps-tracker-notification/);
  assert.match(postDeploy, /Daily 2x event checkpoint/);
});

test("archive is explicitly non-authoritative", () => {
  const archive = read("docs/archive/README.md");
  assert.match(archive, /historical/i);
  assert.match(archive, /Do \*\*not\*\* use archived documents as current/i);
});

test("current specialized runbooks do not point back to retired root runbooks", () => {
  for (const file of [
    "docs/capacity-load-runbook.md",
    "docs/redis-cache-runbook.md",
    "docs/race-experience-identity-search-index-runbook.md",
  ]) {
    const source = read(file);
    assert.doesNotMatch(source, /DEPLOY_RUNBOOK\.md|BACKUP\.md/);
  }
});
