const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

// Phase 1 gate for the race-resolution dependency-closure spec (R1).
//
// The closure planner is only as safe as its classification table. This suite
// proves the table against its authoritative sources rather than against a
// second hand-written copy of the same lists: a type added to
// POWERUP_SCOPE_BY_TYPE, SETTLEMENT_EFFECT_TYPES, SNAPSHOT_AT_EXPIRY_TYPES, or
// the expiry-consequence set must fail here before it can silently become
// closure-eligible in production.
//
// The inertness implication asserted here is ONE-WAY on purpose. The
// biconditional would force HITCHHIKE inert and delete its dependency edges.

const {
  SCORING_CLASSIFICATION_BY_TYPE,
  CLASSIFICATIONS,
  EDGE_DIRECTIONS,
  NON_INERT_TYPES,
  NON_INERT_SOURCE_LISTS,
  UnclassifiedPowerupTypeError,
  classifyPowerupTypeForScoring,
  findClassificationTableProblems,
} = require("../../src/modules/races/services/raceScoringDependencyClosure");
const {
  POWERUP_SCOPE_BY_TYPE,
} = require("../../src/modules/races/services/raceResolutionReasonRegistry");
const {
  SETTLEMENT_EFFECT_TYPES,
} = require("../../src/modules/races/services/raceScoringEffectTypes");
const {
  SNAPSHOT_AT_EXPIRY_TYPES,
  EXPIRY_CONSEQUENCE_TYPES,
} = require("../../src/modules/powerups/constants/expiryEffectTypes");
const expireEffectsModule = require("../../src/modules/powerups/commands/expireEffects");

test("the checked-in table is coherent against its sources", () => {
  assert.deepEqual(findClassificationTableProblems(), []);
});

test("every POWERUP_SCOPE_BY_TYPE key has exactly one classification row", () => {
  assert.deepEqual(
    Object.keys(SCORING_CLASSIFICATION_BY_TYPE).sort(),
    Object.keys(POWERUP_SCOPE_BY_TYPE).sort()
  );
});

test("a newly added PowerupType fails the guard and throws in the classifier", () => {
  // Simulates Prisma/catalog introducing a type without a classification row.
  const withNewType = { ...POWERUP_SCOPE_BY_TYPE, GRAVITY_BOOTS: "SELF" };
  const problems = findClassificationTableProblems(withNewType);

  assert.equal(problems.length, 1);
  assert.match(problems[0], /missing classification row .*GRAVITY_BOOTS/);

  assert.throws(
    () => classifyPowerupTypeForScoring("GRAVITY_BOOTS"),
    UnclassifiedPowerupTypeError
  );
});

test("the classifier rejects prototype keys and nullish input", () => {
  for (const bogus of ["toString", "constructor", "__proto__", "", undefined, null]) {
    assert.throws(() => classifyPowerupTypeForScoring(bogus), UnclassifiedPowerupTypeError);
  }
});

test("the inert set is derived from the five source lists, not hand-listed", () => {
  const derivedNonInert = new Set([
    ...SETTLEMENT_EFFECT_TYPES,
    "HITCHHIKE",
    "TRAIL_MINE",
    ...SNAPSHOT_AT_EXPIRY_TYPES,
    ...EXPIRY_CONSEQUENCE_TYPES,
  ]);

  assert.deepEqual([...NON_INERT_TYPES].sort(), [...derivedNonInert].sort());

  for (const type of derivedNonInert) {
    // A type may only be absent from the table if it is also absent from the
    // registry; anything the registry knows must carry a row.
    if (!Object.hasOwn(POWERUP_SCOPE_BY_TYPE, type)) continue;
    assert.notEqual(
      SCORING_CLASSIFICATION_BY_TYPE[type].classification,
      "SCORING_INERT",
      `${type} is read by a scoring/expiry source list and must not be SCORING_INERT`
    );
  }
});

test("HITCHHIKE, TRAIL_MINE, snapshot-at-expiry and expiry-consequence types are provably not inert", () => {
  const mustNotBeInert = [
    "HITCHHIKE",
    "TRAIL_MINE",
    ...SNAPSHOT_AT_EXPIRY_TYPES,
    "DRILL_SERGEANT",
    "FANNY_PACK",
    "PIGGY_BANK",
  ];

  // The named types are what the spec pins; assert they really are in the
  // derived sources so the list cannot rot into a hand-maintained duplicate.
  assert.deepEqual(EXPIRY_CONSEQUENCE_TYPES.slice().sort(), [
    "DRILL_SERGEANT",
    "FANNY_PACK",
    "PIGGY_BANK",
  ]);

  for (const type of mustNotBeInert) {
    assert.ok(NON_INERT_TYPES.has(type), `${type} missing from the derived non-inert set`);
    assert.notEqual(
      classifyPowerupTypeForScoring(type).classification,
      "SCORING_INERT",
      `${type} must not be SCORING_INERT`
    );
  }
});

test("an inert row IS rejected once it enters a source list", () => {
  // Proves the guard has teeth by actually injecting the mutation: POWER_OUTAGE
  // is inert today, and the guard must flag it the moment a scoring/expiry
  // source list starts reading it.
  assert.equal(
    SCORING_CLASSIFICATION_BY_TYPE.POWER_OUTAGE.classification,
    "SCORING_INERT"
  );
  assert.equal(NON_INERT_TYPES.has("POWER_OUTAGE"), false);

  const mutated = NON_INERT_SOURCE_LISTS.map(([name, list]) =>
    name === "SETTLEMENT_EFFECT_TYPES" ? [name, [...list, "POWER_OUTAGE"]] : [name, list]
  );
  const problems = findClassificationTableProblems(POWERUP_SCOPE_BY_TYPE, mutated);

  assert.equal(problems.length, 1);
  assert.match(problems[0], /POWER_OUTAGE.*SCORING_INERT.*SETTLEMENT_EFFECT_TYPES/);
});

test("the Prisma PowerupType enum cannot drift ahead of the table", () => {
  const schema = fs.readFileSync(
    path.join(__dirname, "..", "..", "prisma", "schema.prisma"),
    "utf8"
  );
  const block = schema.match(/enum PowerupType \{([\s\S]*?)\n\}/);
  assert.ok(block, "PowerupType enum found");
  const enumTypes = [...block[1].matchAll(/^\s{2}([A-Z_]+)\s+@map/gm)].map((m) => m[1]);
  assert.ok(enumTypes.length > 30, "enum parse produced a plausible list");

  // MYSTERY_BOX is a container, never an effect the scorer classifies.
  const missing = enumTypes
    .filter((t) => t !== "MYSTERY_BOX")
    .filter((t) => !Object.hasOwn(SCORING_CLASSIFICATION_BY_TYPE, t));
  assert.deepEqual(
    missing,
    [],
    "a PowerupType shipped without a scoring classification row is closure-unsafe"
  );
});

test("expireEffects still re-exports the expiry type lists it acts on", () => {
  // The constants moved to a dependency-free module; existing importers of the
  // command must keep resolving them.
  assert.deepEqual(expireEffectsModule.SNAPSHOT_AT_EXPIRY_TYPES, SNAPSHOT_AT_EXPIRY_TYPES);
  assert.deepEqual(expireEffectsModule.EXPIRY_CONSEQUENCE_TYPES, EXPIRY_CONSEQUENCE_TYPES);
});

test("every SNAPSHOT_AT_EXPIRY_TYPES row carries the narrowed expiry veto", () => {
  for (const type of SNAPSHOT_AT_EXPIRY_TYPES) {
    const entry = SCORING_CLASSIFICATION_BY_TYPE[type];
    if (entry.classification === "RACE_WIDE" || entry.classification === "UNSUPPORTED") {
      continue; // already forces FULL unconditionally
    }
    assert.match(
      entry.fallbackCondition || "",
      /targetParticipantId is NOT in the closure forces FULL/,
      `${type} must state the narrowed expiry veto`
    );
  }

  // DRILL_SERGEANT is the veto's other half (expireEffects.js:165).
  assert.match(
    SCORING_CLASSIFICATION_BY_TYPE.DRILL_SERGEANT.fallbackCondition,
    /NOT in the closure forces FULL/
  );
});

test("edge direction is pinned per row, never derivable from the type", () => {
  assert.equal(SCORING_CLASSIFICATION_BY_TYPE.HITCHHIKE.edgeDirection, "TARGET_TO_SOURCE");
  assert.equal(SCORING_CLASSIFICATION_BY_TYPE.LEECH.edgeDirection, "BIDIRECTIONAL");

  for (const [type, entry] of Object.entries(SCORING_CLASSIFICATION_BY_TYPE)) {
    assert.ok(EDGE_DIRECTIONS.has(entry.edgeDirection), `${type} edgeDirection`);
    if (entry.classification !== "DEPENDENCY") {
      assert.equal(entry.edgeDirection, "NONE", `${type} must pin no edge`);
    }
  }
});

test("mutation-gated inert rows state the gate; never-read rows do not need one", () => {
  const gated = ["POCKET_WATCH", "MYSTERY_POTION", "DECOY", "CLEANSE", "QUICK_RINSE"];
  for (const type of gated) {
    const entry = SCORING_CLASSIFICATION_BY_TYPE[type];
    assert.equal(entry.classification, "SCORING_INERT", type);
    assert.match(
      entry.fallbackCondition || "",
      /reclassified UNSUPPORTED/,
      `${type} must carry the mutation-gate clause`
    );
  }

  // LUCKY_HORSESHOE's row is expired by openMysteryBox.js under BOX_OPEN, NOT
  // POWERUP_MUTATION, so it must NOT claim the mutation gate — it is safe only
  // because the scorer never reads the row at all.
  const horseshoe = SCORING_CLASSIFICATION_BY_TYPE.LUCKY_HORSESHOE;
  assert.equal(horseshoe.classification, "SCORING_INERT");
  assert.equal(horseshoe.fallbackCondition, null);
  assert.match(horseshoe.note, /BOX_OPEN/);
});

test("bonus-timeline rows declare EVENT_ROWS, not NONE", () => {
  // race_powerup_events is NOT digested by buildRaceResolutionInputFingerprint,
  // so Phase 2 must not read these rows as "nothing to fence".
  for (const type of [
    "PROTEIN_SHAKE",
    "SECOND_WIND",
    "TRAIL_MIX",
    "SHORTCUT",
    "RED_CARD",
    "PINECONE_TOSS",
  ]) {
    const entry = SCORING_CLASSIFICATION_BY_TYPE[type];
    assert.equal(entry.classification, "SELF", type);
    assert.equal(entry.historicalStatus, "EVENT_ROWS", type);
  }
});

test("LEECH and HITCHHIKE are DEPENDENCY; TRAIL_MINE escalates", () => {
  assert.equal(classifyPowerupTypeForScoring("LEECH").classification, "DEPENDENCY");
  assert.equal(classifyPowerupTypeForScoring("HITCHHIKE").classification, "DEPENDENCY");
  assert.equal(
    classifyPowerupTypeForScoring("TRAIL_MINE").classification,
    "CLOSURE_ELIGIBLE_WITH_ESCALATION"
  );

  // TRAIL_MINE is the only type allowed to escalate in v1.
  const escalating = Object.entries(SCORING_CLASSIFICATION_BY_TYPE)
    .filter(([, entry]) => entry.classification === "CLOSURE_ELIGIBLE_WITH_ESCALATION")
    .map(([type]) => type);
  assert.deepEqual(escalating, ["TRAIL_MINE"]);
});

test("cross-participant rows require ACTIVE+EXPIRED history", () => {
  // The canonical Leech/Hitchhike helpers read EXPIRED rows; a graph built from
  // "currently active" alone would drop transfers the full scorer applies.
  for (const type of ["LEECH", "HITCHHIKE"]) {
    assert.equal(SCORING_CLASSIFICATION_BY_TYPE[type].historicalStatus, "ACTIVE+EXPIRED");
  }
});

test("local scoring modifiers are SELF and carry no dependency edge", () => {
  for (const type of [
    "LEG_CRAMP",
    "RUNNERS_HIGH",
    "WRONG_TURN",
    "CAMPFIRE_REST",
    "RAINSTORM",
    "QUICKSAND",
    "UMBRELLA",
    "COIN_FLIP",
    "GHOST_PEPPER",
  ]) {
    assert.equal(
      classifyPowerupTypeForScoring(type).classification,
      "SELF",
      `${type} must be SELF`
    );
  }
});

test("team-scoped types force FULL in v1", () => {
  for (const type of ["RALLY_FLAG", "UPRISING"]) {
    assert.equal(classifyPowerupTypeForScoring(type).classification, "RACE_WIDE");
  }
});

test("POCKET_WATCH's inertness carries its mandatory conditional rationale", () => {
  const entry = SCORING_CLASSIFICATION_BY_TYPE.POCKET_WATCH;
  assert.equal(entry.classification, "SCORING_INERT");
  assert.match(entry.note, /POWERUP_MUTATION/);
  assert.match(entry.note, /expiresAt/);
});

test("every row pins the metadata required by spec rule 3", () => {
  for (const [type, entry] of Object.entries(SCORING_CLASSIFICATION_BY_TYPE)) {
    assert.ok(CLASSIFICATIONS.has(entry.classification), `${type} classification`);
    assert.ok(
      ["ACTIVE", "ACTIVE+EXPIRED", "EVENT_ROWS", "NONE"].includes(entry.historicalStatus),
      `${type} historicalStatus`
    );
    assert.ok(EDGE_DIRECTIONS.has(entry.edgeDirection), `${type} edgeDirection`);
    assert.ok(
      entry.earliestBoundary === null || typeof entry.earliestBoundary === "string",
      `${type} earliestBoundary`
    );
    assert.ok(typeof entry.note === "string" && entry.note.length > 0, `${type} note`);
    assert.ok(
      entry.metadataValidation === null || typeof entry.metadataValidation === "string",
      `${type} metadataValidation`
    );
    assert.ok(
      entry.fallbackCondition === null || typeof entry.fallbackCondition === "string",
      `${type} fallbackCondition`
    );
    assert.ok(Object.isFrozen(entry), `${type} row must be frozen`);
  }
});

test("the table does not copy the registry's cast-targeting scopes", () => {
  // POWER_OUTAGE is RACE_WIDE targeting but scoring-inert. Copying the registry
  // value would veto every closure on the races this planner exists for.
  assert.equal(POWERUP_SCOPE_BY_TYPE.POWER_OUTAGE, "RACE_WIDE");
  assert.equal(
    SCORING_CLASSIFICATION_BY_TYPE.POWER_OUTAGE.classification,
    "SCORING_INERT"
  );
});
