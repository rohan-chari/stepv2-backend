const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");

const {
  generate,
  generateSection,
  render,
  DOC_FILE,
  BEGIN,
  END,
} = require("../../scripts/generate-powerups-md");
const { defaultConfig } = require("../../src/services/balanceConfig.defaults");

// Test #20. POWERUPS.md rotted badly enough to advertise a 5% leader rare rate
// against an actual 27% — this is the check that stops it happening again.
test("the committed POWERUPS.md matches generated output", () => {
  const actual = fs.readFileSync(DOC_FILE, "utf8");
  assert.equal(
    generate(),
    actual,
    "POWERUPS.md is stale — run `npm run powerups:docs`"
  );
});

test("the generated section reports the real odds curve, not the old hardcoded one", () => {
  const config = defaultConfig();
  const section = generateSection(config);
  // The documented leader row must be the configured one (48/25/27), not the
  // 70/25/5 the doc used to claim.
  assert.match(section, /\| 1st \(leader\) \| 48\.0% \| 25\.0% \| 27\.0% \|/);
  assert.doesNotMatch(section, /\| 1st \(leader\) \| 70\.0%/);
});

test("the generated section tracks the config it is given", () => {
  const config = defaultConfig();
  config.positionOdds.first = [0.3, 0.3, 0.4];
  config.upgradeCosts.byRarity.RARE = [0, 20, 60, 180];
  config.luckyHorseshoe.rareChanceByLevel = [0, 0.1, 0.5, 1.0];

  const section = generateSection(config);
  assert.match(section, /\| 1st \(leader\) \| 30\.0% \| 30\.0% \| 40\.0% \|/);
  assert.match(section, /\| Rare \| 20 \| 60 \| 180 \|/);
  assert.match(section, /\| 1 \| 10\.0% \|/);
});

test("regeneration is idempotent and only rewrites the marked block", () => {
  const original = fs.readFileSync(DOC_FILE, "utf8");
  const once = render(original, generateSection(defaultConfig()));
  const twice = render(once, generateSection(defaultConfig()));
  assert.equal(once, twice);

  // The hand-written prose outside the markers survives untouched.
  const preamble = original.slice(0, original.indexOf(BEGIN));
  assert.equal(once.slice(0, once.indexOf(BEGIN)), preamble);
  const tail = original.slice(original.indexOf(END) + END.length);
  assert.equal(once.slice(once.indexOf(END) + END.length), tail);
  assert.match(tail, /## Usage Rules/);
});

test("every droppable and store-only type is documented", () => {
  const config = defaultConfig();
  const section = generateSection(config);
  const documented = section.toLowerCase().replace(/[^a-z]/g, "");
  const all = [
    ...config.dropPool.COMMON,
    ...config.dropPool.UNCOMMON,
    ...config.dropPool.RARE,
    ...config.storeOnlyTypes,
  ];
  for (const type of all) {
    const words = type.toLowerCase().replace(/_/g, "");
    assert.ok(documented.includes(words), `${type} is missing from POWERUPS.md`);
  }
});
