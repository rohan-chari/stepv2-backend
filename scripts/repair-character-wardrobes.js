process.env.DOTENV_CONFIG_QUIET = "true";
require("dotenv").config({ quiet: true });
const { prisma } = require("../src/db");
const {
  repairCharacterWardrobes,
} = require("../src/modules/cosmetics/repairCharacterWardrobes");
async function main() {
  const apply = process.argv.includes("--apply");
  // --apply must be separately authorized for production under AGENTS.md.
  // There is no startup hook; the operator controls bounded checkpoints.
  const after =
    process.argv.find((a) => a.startsWith("--after="))?.slice(8) || null;
  console.log(
    JSON.stringify(await repairCharacterWardrobes({ apply, after }), null, 2),
  );
}
main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(process.exitCode || 0);
  });
