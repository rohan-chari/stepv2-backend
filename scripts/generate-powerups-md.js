const fs = require("node:fs");
const path = require("node:path");
const { snapshotConfig } = require("../src/modules/economy/balanceSnapshot");

// Regenerates the BALANCE-DERIVED section of POWERUPS.md from the committed
// balance snapshot (falling back to code defaults).
//
// Only the block between the two markers is generated — the hand-written prose
// about targeting, shields, step maths and feed events is untouched. That prose
// is not derivable from balance config and rewriting the whole file would
// destroy it.
//
// It reads the COMMITTED SNAPSHOT rather than the database on purpose: the
// `--check` mode runs in CI, which has no DB. Refresh the snapshot with
// `npm run balance:pull` after tuning, then re-run this.
//
// This exists because the doc rotted: it advertised a 70/25/5 leader curve while
// the code rolled 48/25/27 — a documented rare rate more than 5x off the real
// one, for a long time, with nothing to catch it.

const DOC_FILE = path.join(__dirname, "..", "POWERUPS.md");
const BEGIN = "<!-- BEGIN GENERATED: balance (npm run powerups:docs) -->";
const END = "<!-- END GENERATED: balance -->";

const RARITIES = ["COMMON", "UNCOMMON", "RARE"];

function titleCase(type) {
  return type
    .split("_")
    .map((w) => w[0] + w.slice(1).toLowerCase())
    .join(" ");
}

function pct(n) {
  return `${(n * 100).toFixed(1)}%`;
}

function generateSection(config) {
  const lines = [];

  lines.push(BEGIN);
  lines.push("");
  lines.push("## Odds (Rubber Banding)");
  lines.push("");
  lines.push(
    "Rarity odds depend on your position in the race. Trailing players get better drops."
  );
  lines.push("");
  lines.push("| Position | Common | Uncommon | Rare |");
  lines.push("|---|---|---|---|");
  lines.push(
    `| 1st (leader) | ${config.positionOdds.first.map(pct).join(" | ")} |`
  );
  lines.push(`| Last place | ${config.positionOdds.last.map(pct).join(" | ")} |`);
  lines.push("");
  lines.push("Middle positions are interpolated linearly between these extremes.");
  lines.push("");

  const weights = config.typeWeights || {};
  if (Object.keys(weights).length === 0) {
    lines.push("Within a rarity tier, each powerup has equal odds.");
  } else {
    lines.push(
      "Within a rarity tier each powerup has equal odds, except for these weighted types (1.0 = a normal share):"
    );
    lines.push("");
    lines.push("| Powerup | Weight |");
    lines.push("|---|---|");
    for (const [type, weight] of Object.entries(weights)) {
      lines.push(`| **${titleCase(type)}** | ${weight} |`);
    }
  }
  lines.push("");

  lines.push("## Drop Pool");
  lines.push("");
  lines.push(
    "What a mystery box can actually roll. A powerup having a rarity does not make it droppable — it must be listed here."
  );
  lines.push("");
  for (const rarity of RARITIES) {
    const pool = config.dropPool[rarity] || [];
    lines.push(
      `- **${titleCase(rarity)}** — ${pool.map(titleCase).join(", ") || "_(empty)_"}`
    );
  }
  lines.push("");
  lines.push(
    `Store-only (bought with coins, never rolled from a mystery box): ${(
      config.storeOnlyTypes || []
    )
      .map(titleCase)
      .join(", ")}.`
  );
  const teamOnly = config.teamOnlyTypes || [];
  if (teamOnly.length > 0) {
    lines.push("");
    lines.push(
      `Team races only (droppable, but a solo race never rolls them): ${teamOnly
        .map(titleCase)
        .join(", ")}.`
    );
  }
  lines.push("");
  lines.push(
    "**Daily reward box** powerup prizes are the shop catalog as the spinning " +
      "client sees it (active, channel-appropriate, client-feature-gated items) " +
      "— available in the shop means winnable from the daily spin."
  );
  lines.push("");

  lines.push("## Upgrade Costs");
  lines.push("");
  lines.push("Coin cost by rarity and level. Level 0 is the base form and is free.");
  lines.push("");
  lines.push("| Rarity | Lvl 1 | Lvl 2 | Lvl 3 |");
  lines.push("|---|---|---|---|");
  for (const rarity of RARITIES) {
    const ladder = config.upgradeCosts.byRarity[rarity];
    lines.push(`| ${titleCase(rarity)} | ${ladder.slice(1).join(" | ")} |`);
  }
  lines.push("");
  const byType = config.upgradeCosts.byType || {};
  if (Object.keys(byType).length > 0) {
    lines.push("Per-type overrides:");
    lines.push("");
    for (const [type, ladder] of Object.entries(byType)) {
      lines.push(`- **${titleCase(type)}** — ${ladder.slice(1).join(" / ")}`);
    }
    lines.push("");
  }
  lines.push(
    `Upgradeable: ${config.upgradeableTypes.map(titleCase).join(", ")}.`
  );
  lines.push("");

  lines.push("## Lucky Horseshoe");
  lines.push("");
  lines.push(
    "Chance that the next mystery box is forced to RARE, by upgrade level. On a miss the floor is UNCOMMON. The rarity is rolled when the Horseshoe is USED and stored on the effect, so an upgrade never changes a Horseshoe already in flight."
  );
  lines.push("");
  lines.push("| Level | Chance of RARE |");
  lines.push("|---|---|");
  config.luckyHorseshoe.rareChanceByLevel.forEach((p, level) => {
    lines.push(`| ${level} | ${pct(p)} |`);
  });
  lines.push("");

  lines.push("## Daily Reward Box");
  lines.push("");
  lines.push(
    `Odds interpolate on your consecutive-day login streak, capped at **${config.dailyBox.streakCap} days**.`
  );
  lines.push("");
  lines.push("| Streak | Common | Uncommon | Rare |");
  lines.push("|---|---|---|---|");
  lines.push(`| 1 day | ${config.dailyBox.odds.first.map(pct).join(" | ")} |`);
  lines.push(
    `| ${config.dailyBox.streakCap}+ days | ${config.dailyBox.odds.last
      .map(pct)
      .join(" | ")} |`
  );
  lines.push("");
  lines.push("Coin payouts per tier, interpolated by streak progress:");
  lines.push("");
  lines.push("| Tier | Min | Max |");
  lines.push("|---|---|---|");
  for (const [key, range] of Object.entries(config.dailyBox.coinRanges)) {
    lines.push(`| ${key} | ${range[0]} | ${range[1]} |`);
  }
  lines.push("");
  lines.push(
    `A RARE hit pays coins instead of a prize ${pct(
      config.dailyBox.rareCoinsShare
    )} of the time (displacing the powerup slice only). Accessory weighting mode: \`${
      config.dailyBox.accessoryWeightMode
    }\`.`
  );
  lines.push("");
  lines.push(END);

  return lines.join("\n");
}

// Replace the marked block, or — on first run — the legacy hand-written
// "## Odds (Rubber Banding)" section it supersedes.
function render(existing, section) {
  const beginIndex = existing.indexOf(BEGIN);
  if (beginIndex !== -1) {
    const endIndex = existing.indexOf(END, beginIndex);
    return (
      existing.slice(0, beginIndex) +
      section +
      existing.slice(endIndex + END.length)
    );
  }

  const legacyStart = existing.indexOf("## Odds (Rubber Banding)");
  if (legacyStart === -1) {
    throw new Error(
      "POWERUPS.md has neither the generated markers nor the legacy Odds section; refusing to guess where to write."
    );
  }
  const legacyEnd = existing.indexOf("\n## ", legacyStart + 1);
  return (
    existing.slice(0, legacyStart) +
    section +
    (legacyEnd === -1 ? "\n" : existing.slice(legacyEnd))
  );
}

function generate() {
  const existing = fs.readFileSync(DOC_FILE, "utf8");
  return render(existing, generateSection(snapshotConfig()));
}

function main() {
  const check = process.argv.includes("--check");
  const expected = generate();
  const actual = fs.readFileSync(DOC_FILE, "utf8");

  if (check) {
    if (expected !== actual) {
      console.error(
        "POWERUPS.md is out of date with the balance config. Run `npm run powerups:docs`."
      );
      process.exit(1);
    }
    console.log("POWERUPS.md matches the balance config.");
    return;
  }

  if (expected === actual) {
    console.log("POWERUPS.md already up to date.");
    return;
  }
  fs.writeFileSync(DOC_FILE, expected);
  console.log("Regenerated the balance section of POWERUPS.md.");
}

if (require.main === module) main();

module.exports = { generate, generateSection, render, DOC_FILE, BEGIN, END };
