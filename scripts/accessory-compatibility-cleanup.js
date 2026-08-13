require("dotenv").config();
const {
  cleanupAccessoryCompatibility,
} = require("../src/modules/cosmetics/cleanupAccessoryCompatibility");

// Usage (after the additive migration has deployed, before enabling the flag):
//   node scripts/accessory-compatibility-cleanup.js          # report only
//   node scripts/accessory-compatibility-cleanup.js --apply  # remove conflicts
// The command is idempotent. Never run `--apply` against production without
// the explicit deploy approval required by AGENTS.md.
async function main() {
  const apply = process.argv.includes("--apply");
  const summary = await cleanupAccessoryCompatibility({ apply });
  console.log(
    `${apply ? "Applied" : "Dry run"}: checked ${summary.usersChecked} users; ` +
      `${summary.conflictingRows} conflicting equipped row(s)` +
      (apply ? `; removed ${summary.removed}.` : ".")
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error("accessory compatibility cleanup failed:", error);
    process.exit(1);
  });
}

module.exports = { main };
