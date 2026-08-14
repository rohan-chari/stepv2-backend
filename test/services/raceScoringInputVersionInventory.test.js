// Structural guard: artifact safety depends on every scorer-source mutation
// bumping the same monotonic token in its DB transaction. No one HTTP case can
// prove the absence of an unversioned writer elsewhere in the source tree.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

test("all step/sample mutation owners name the scoring-input token seam", () => {
  for (const file of [
    "src/modules/steps/models/steps.js",
    "src/modules/steps/models/stepSample.js",
    "src/modules/steps/commands/recordStepSyncV2.js",
    "src/modules/steps/jobs/stepSampleRetention.js",
  ]) {
    assert.match(
      read(file),
      /bumpScoringInputVersion|bumpManyScoringInputVersions/,
      `${file} has scoring-source writes and must bump tokens atomically`
    );
  }
});

test("account deletion relies only on the scoring-token cascade", () => {
  assert.match(
    read("prisma/migrations/20260813120000_api_contract_payload_cleanup_resolution/migration.sql"),
    /user_scoring_input_versions_user_id_fkey[\s\S]*ON DELETE CASCADE/
  );
});
