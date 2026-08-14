// Race-scoring dependency classification for the v2 resolver's closure planner.
//
// PHASE 1 SCOPE: this module exports the checked-in classification table and its
// classifier ONLY. Nothing imports it yet; no flag is read; no plan is selected.
// Traversal, fingerprinting, and the subset resolver land in later phases.
//
// The table's key set is exactly POWERUP_SCOPE_BY_TYPE. That registry's values
// describe CAST TARGETING (who a powerup may be aimed at), which is a different
// question from SCORING DEPENDENCY (whose computed total another participant's
// total reads). The two must never be conflated: POWER_OUTAGE is RACE_WIDE
// targeting but scoring-inert, and copying the registry value here would veto
// every closure on exactly the races this planner exists for.

const {
  POWERUP_SCOPE_BY_TYPE,
} = require("./raceResolutionReasonRegistry");
const {
  SETTLEMENT_EFFECT_TYPES,
} = require("./raceScoringEffectTypes");
// Imported from the dependency-free constants module, NOT from
// expireEffects.js: requiring that command would transitively load the model,
// eventBus, and awardCoins graph at module load for a table of strings.
const {
  SNAPSHOT_AT_EXPIRY_TYPES,
  EXPIRY_CONSEQUENCE_TYPES,
} = require("../../powerups/constants/expiryEffectTypes");

// The five authoritative source lists a SCORING_INERT classification must be
// absent from. Derived here, never hand-listed: a type added to any of these
// modules must break the structural test rather than silently become inert.
//   1. SETTLEMENT_EFFECT_TYPES  — raceScoringEffectTypes.js
//   2. {HITCHHIKE}              — collectRaceHitchhikeCopies, hitchhikeCopies.js
//   3. {TRAIL_MINE}             — triggerTrailMines, raceStateResolution.js
//   4. SNAPSHOT_AT_EXPIRY_TYPES — expireEffects.js
//   5. EXPIRY_CONSEQUENCE_TYPES — expireEffects.js
//      ({DRILL_SERGEANT, FANNY_PACK, PIGGY_BANK})
const HITCHHIKE_SCORING_TYPES = Object.freeze(["HITCHHIKE"]);
const TRAIL_MINE_SCORING_TYPES = Object.freeze(["TRAIL_MINE"]);

const NON_INERT_SOURCE_LISTS = Object.freeze([
  Object.freeze(["SETTLEMENT_EFFECT_TYPES", SETTLEMENT_EFFECT_TYPES]),
  Object.freeze(["HITCHHIKE_SCORING_TYPES", HITCHHIKE_SCORING_TYPES]),
  Object.freeze(["TRAIL_MINE_SCORING_TYPES", TRAIL_MINE_SCORING_TYPES]),
  Object.freeze(["SNAPSHOT_AT_EXPIRY_TYPES", SNAPSHOT_AT_EXPIRY_TYPES]),
  Object.freeze(["EXPIRY_CONSEQUENCE_TYPES", EXPIRY_CONSEQUENCE_TYPES]),
]);

// Types provably ineligible for SCORING_INERT. This is a ONE-WAY implication:
// membership here forbids SCORING_INERT, but absence does NOT make a type inert.
const NON_INERT_TYPES = Object.freeze(
  new Set(NON_INERT_SOURCE_LISTS.flatMap(([, list]) => list))
);

const CLASSIFICATIONS = Object.freeze(new Set([
  // The target's score reads only its own participant's inputs. No edge.
  "SELF",
  // Source/target score dependency edge; both ends must be in the closure.
  "DEPENDENCY",
  // Forces FULL: the mechanic reads or writes the whole field.
  "RACE_WIDE",
  // Forces FULL: semantics not modelled in v1.
  "UNSUPPORTED",
  // The scorer never reads this type. No edge, no veto.
  "SCORING_INERT",
  // Closure-eligible, but the generation escalates to FULL when a non-closure
  // participant qualifies as a candidate. TRAIL_MINE only.
  "CLOSURE_ELIGIBLE_WITH_ESCALATION",
]));

// Historical-status needs: which raceActiveEffect statuses the canonical scorer
// consumes for this type. ACTIVE_ONLY rows may be read from the active set;
// ACTIVE_AND_EXPIRED rows require the EXPIRED history too (fingerprint schema 2).
const HISTORY = Object.freeze({
  ACTIVE_ONLY: "ACTIVE",
  ACTIVE_AND_EXPIRED: "ACTIVE+EXPIRED",
  // Scoring input is race_powerup_events rows, not raceActiveEffect rows.
  // NOT "nothing to fence": buildRaceResolutionInputFingerprint does NOT digest
  // race_powerup_events, so these rows are safe only through the POWERUP_MUTATION
  // gate. Phase 2 must not treat this as equivalent to NONE.
  EVENT_ROWS: "EVENT_ROWS",
  // The scorer reads no row of this type at all.
  NONE: "NONE",
});

// Edge direction is PINNED per row so the traversal in Phase 2 reads it rather
// than re-deriving it from the type name.
const EDGE_DIRECTIONS = Object.freeze(new Set([
  // No dependency edge: the row never makes one participant's score read
  // another participant's computed total.
  "NONE",
  // The edge runs from the effect's target to its source: the source's score
  // reads the target's computed total (HITCHHIKE).
  "TARGET_TO_SOURCE",
  // Both ends read each other and transfer ORDER matters, so the whole
  // connected component must be resolved together (LEECH).
  "BIDIRECTIONAL",
]));

function row({
  classification,
  history,
  edgeDirection,
  earliestBoundary,
  metadataValidation,
  fallbackCondition,
  note,
}) {
  return Object.freeze({
    classification,
    // Which raceActiveEffect statuses this type's canonical scoring read needs.
    historicalStatus: history,
    // Pinned traversal edge direction; see EDGE_DIRECTIONS.
    edgeDirection,
    // The earliest time boundary this row contributes to the closure's exclusive
    // validity deadline (multiplierBoundaries semantics). null when the row
    // contributes no boundary.
    earliestBoundary,
    // What the planner must validate on the row's metadata/version before the
    // classification may be trusted. null means the row carries no scoring
    // metadata the closure depends on.
    metadataValidation,
    // The condition under which this row forces FULL despite its classification.
    fallbackCondition,
    note,
  });
}

// The narrowed expiry veto (spec rule 3 / resolver integration item 6). Applies
// to every SNAPSHOT_AT_EXPIRY_TYPES member: expireEffects.js:60-64 SILENTLY
// skips the stepsAtExpiry stamp when participantSteps has no key for the target,
// so a due row targeting a non-closure participant would lose its window end.
const SNAPSHOT_EXPIRY_VETO =
  "A due effect of this type whose targetParticipantId is NOT in the closure forces FULL: expireEffects.js:60-64 silently skips the stepsAtExpiry stamp on a missing participantSteps key rather than failing loudly. Evaluated at plan selection and re-evaluated before the post-commit handoff.";

// Local scoring modifiers: multiplier windows over the holder's own samples.
// Every one is in SETTLEMENT_EFFECT_TYPES, so none may be SCORING_INERT; none
// reads another participant's total, so none creates a dependency edge.
function localModifierRow({ metadataValidation, note }) {
  return row({
    classification: "SELF",
    history: HISTORY.ACTIVE_AND_EXPIRED,
    edgeDirection: "NONE",
    earliestBoundary:
      "min(startsAt, expiresAt, and any intra-effect multiplierBoundaries transition such as startsAt+freezeMs / startsAt+boostMs)",
    metadataValidation,
    fallbackCondition:
      "Missing/unparseable multiplier window metadata, or a multiplierBoundaries transition at or before the claim as-of instant. " +
      SNAPSHOT_EXPIRY_VETO,
    note,
  });
}

// Types the scorer reads NO row of, under any reason. These carry no gate
// condition because there is nothing for a closure to miss.
function neverReadRow(note) {
  return row({
    classification: "SCORING_INERT",
    history: HISTORY.NONE,
    edgeDirection: "NONE",
    earliestBoundary: null,
    metadataValidation: null,
    fallbackCondition: null,
    note,
  });
}

// Types that MUTATE rows the scorer does read (expiresAt, status, or spawned
// effect rows), and are inert ONLY because every such cast is a
// POWERUP_MUTATION dirty reason -> FULL, so a full generation always observes
// the mutation before any closure reads the mutated rows.
const MUTATION_GATE_CLAUSE =
  "Inert ONLY under the POWERUP_MUTATION gate: if this type ever becomes castable under a closure-eligible reason, or gains a deferred/scheduled application, this row is WRONG and the type must be reclassified UNSUPPORTED.";

function mutationGatedInertRow(note) {
  return row({
    classification: "SCORING_INERT",
    history: HISTORY.NONE,
    edgeDirection: "NONE",
    earliestBoundary: null,
    metadataValidation: null,
    fallbackCondition:
      "None while every cast of this type is a POWERUP_MUTATION dirty reason. " +
      MUTATION_GATE_CLAUSE,
    note,
  });
}

// Immutable RacePowerupEvent bonus-timeline contributors (buildBonusTimeline,
// raceStateResolution.js:314-364). The event row is written at cast time and
// never mutated; each participant folds only the entries naming their own
// userId, so the contribution is self-local even for the two-sided SHORTCUT.
function bonusTimelineRow(note) {
  return row({
    classification: "SELF",
    // EVENT_ROWS, not NONE: the scoring input is race_powerup_events, which the
    // pinned buildRaceResolutionInputFingerprint does NOT digest. These rows are
    // safe only because every cast that writes one is POWERUP_MUTATION -> FULL.
    history: HISTORY.EVENT_ROWS,
    edgeDirection: "NONE",
    earliestBoundary: "event.createdAt (folded into the timeline at that instant)",
    metadataValidation:
      "Bonus/penalty magnitude must be a finite number on the event metadata; a non-numeric value is ignored by the scorer and must not be reinterpreted here.",
    fallbackCondition:
      "An event of this type created at or after the graph read instant.",
    note,
  });
}

const SCORING_CLASSIFICATION_BY_TYPE = Object.freeze({
  BOUNTY: neverReadRow(
    "Placement wager settled in coins. Never touches steps or bonusSteps."
  ),

  CAMPFIRE_REST: localModifierRow({
    metadataValidation: "multiplier + window; stepsAtStart/stepsAtExpiry snapshot.",
    note: "Self-applied rest debuff over the holder's own window.",
  }),

  CLEANSE: mutationGatedInertRow(
    "Rewrites OTHER rows the scorer reads: usePowerup.js:2851-2875 sets status=EXPIRED AND truncates expiresAt to now on every opponent-inflicted ACTIVE debuff on the caster (the truncation is deliberate — step resolution reads EXPIRED rows and computes the window from [startsAt, expiresAt]). Inert only because the cast is POWERUP_MUTATION -> FULL; the cleared rows carry their own classifications."
  ),

  COIN_FLIP: localModifierRow({
    metadataValidation:
      "metadata.multiplier must be the stored server roll (2 or 0.5); it is NEVER re-rolled here.",
    note:
      "Verified self-targeted: usePowerup.js writes targetParticipantId = myParticipant.id and it is absent from TARGETED_TYPES. Both win and lose rows are self.",
  }),

  COMPRESSION_SOCKS: neverReadRow(
    "Shield row. Read only by triggerTrailMines' per-victim findActiveByTypeForParticipant lookup at detonation, never by the scorer."
  ),

  DECOY: mutationGatedInertRow(
    "Redirects an incoming offensive cast, so the effect row that lands names a different target than it otherwise would. Inert only because the redirect resolves inside the POWERUP_MUTATION cast; the redirected effect carries its own classification."
  ),

  DEFENSE_SCAN: neverReadRow("Reveals defensive rows to the caster. Display only."),

  DETOUR_SIGN: neverReadRow(
    "Hides the target's leaderboard. Display only — no score term."
  ),

  DRILL_SERGEANT: row({
    classification: "SELF",
    history: HISTORY.ACTIVE_ONLY,
    edgeDirection: "NONE",
    earliestBoundary: "expiresAt (the dare is judged only at expiry)",
    metadataValidation:
      "goalSteps/penaltySteps must be finite; the dare judgement reads participantSteps[targetParticipantId].",
    fallbackCondition:
      "A due DRILL_SERGEANT whose targetParticipantId is NOT in the closure forces FULL: expireEffects.js:165 silently skips the dare judgement on a missing key.",
    note:
      "Not scoring-inert (EXPIRY_CONSEQUENCE_TYPES). Its bonusSteps penalty is written at expiry and lands on the target only.",
  }),

  FANNY_PACK: row({
    classification: "SELF",
    history: HISTORY.ACTIVE_ONLY,
    edgeDirection: "NONE",
    earliestBoundary: null,
    metadataValidation: null,
    fallbackCondition: null,
    note:
      "Not scoring-inert (EXPIRY_CONSEQUENCE_TYPES). Its expiry reverts a powerupSlots count, not a score, and expireEffects re-reads the participant itself — no closure input needed.",
  }),

  GHOST_PEPPER: localModifierRow({
    metadataValidation:
      "boostMs, freezeMs, multiplier, stepsAtBoostStart; the startsAt+boostMs intra-effect transition is a deadline boundary.",
    note:
      "Verified self-targeted: usePowerup.js writes targetParticipantId = myParticipant.id and it is absent from TARGETED_TYPES.",
  }),

  HITCHHIKE: row({
    classification: "DEPENDENCY",
    history: HISTORY.ACTIVE_AND_EXPIRED,
    edgeDirection: "TARGET_TO_SOURCE",
    earliestBoundary:
      "min(startsAt, expiresAt, the legacy top-of-hour copy boundary for the legacy scoring version, and the next closed-sample boundary)",
    metadataValidation:
      "Stored scoring version and copy ratio must be a supported version per hitchhikeCopies.js; an unrecognized version forces FULL.",
    fallbackCondition:
      "Unsupported stored scoring version, or the copied target's required effect/sample inputs absent from the closure.",
    note:
      "Edge target->source: the caster's score copies the target's recorded raw steps. collectRaceHitchhikeCopies reads rows on finished/forfeited targets too, so EXPIRED history is required.",
  }),

  IMPOSTER: neverReadRow(
    "Swaps leaderboard DISPLAY only; never touches the target's participant row or steps."
  ),

  LEECH: row({
    classification: "DEPENDENCY",
    history: HISTORY.ACTIVE_AND_EXPIRED,
    edgeDirection: "BIDIRECTIONAL",
    earliestBoundary:
      "min(startsAt, expiresAt, the next closed hourly-bucket boundary consumed by leechTransfers.js)",
    metadataValidation:
      "Transfer rate/window metadata must come from the same source leechTransfers.js reads; never inferred from powerup type.",
    fallbackCondition:
      "Any ordered transfer in the connected component, or any affected active participant, absent from the closure. A frozen/unaccepted/inactive source still drains its victim, so its input is retained rather than dropped.",
    note:
      "Bidirectional edge: the victim's walked steps feed the caster, and transfer ORDER is significant.",
  }),

  LEG_CRAMP: localModifierRow({
    metadataValidation: "multiplier + window; stepsAtStart/stepsAtExpiry snapshot.",
    note: "Opponent-cast, but the score term is entirely the target's own window.",
  }),

  LUCKY_HORSESHOE: neverReadRow(
    "Raises the caster's next box rarity floor. Box roll only, no score term. Its effect row is expired by openMysteryBox.js:292 under a BOX_OPEN reason — NOT a POWERUP_MUTATION — which is safe precisely because the scorer never reads this row; it must therefore stay in the never-read set, not the mutation-gated set."
  ),

  MIRROR: neverReadRow(
    "Reflects an incoming offensive cast at cast time; the reflected effect carries its own classification."
  ),

  MYSTERY_POTION: mutationGatedInertRow(
    "Rolls and writes OTHER effect rows at cast time. Inert only because every cast is POWERUP_MUTATION -> FULL, so the rows it spawns are always observed by a full generation before any closure reads them; the spawned rows carry their own classification."
  ),

  PIGGY_BANK: row({
    classification: "SELF",
    history: HISTORY.ACTIVE_ONLY,
    edgeDirection: "NONE",
    earliestBoundary: "expiresAt (the mint window end, capped by race endsAt)",
    metadataValidation: "stepsPerCoin/coinCap finite; both <= 0 is the env kill switch.",
    fallbackCondition: null,
    note:
      "Not scoring-inert (EXPIRY_CONSEQUENCE_TYPES). Its expiry mints coins from StepSample.sumStepsInWindow directly, not from a closure-computed total, and is idempotent via refId = effect.id.",
  }),

  PINECONE_TOSS: bonusTimelineRow(
    "Penalty subtracted from the named target's own bonus timeline."
  ),

  POCKET_WATCH: mutationGatedInertRow(
    "MANDATORY CONDITIONAL RATIONALE (spec rule 3): Pocket Watch is inert ONLY because it mutates OTHER rows' expiresAt at cast time (usePowerup.js:3294) and every cast is a POWERUP_MUTATION dirty reason -> FULL. A full generation therefore always observes the rewritten expiries before any closure reads them."
  ),

  POWER_OUTAGE: neverReadRow(
    "Blocks the victim's powerup USE for the window; no score term. The registry's RACE_WIDE value describes cast targeting and must not be copied here — prod forensics 2026-08-14 recorded 331 casts/24h on the Weekly Challenge, so a RACE_WIDE scoring row would veto every closure."
  ),

  PROTEIN_SHAKE: bonusTimelineRow("Flat bonus on the caster's own bonus timeline."),

  QUICK_RINSE: mutationGatedInertRow(
    "NOT a clear: usePowerup.js:2684-2703 HALVES the remaining duration of every eligible active timed effect on the caster, rewriting expiresAt on rows the scorer reads while leaving them ACTIVE. Strictly non-retroactive (the new expiresAt is always > now), so no closed Hitchhike copy or Leech transfer is clawed back — but the multiplier-window ends move. Inert only because the cast is POWERUP_MUTATION -> FULL."
  ),

  QUICKSAND: localModifierRow({
    metadataValidation: "multiplier + window; stepsAtStart/stepsAtExpiry snapshot.",
    note: "AoE cast, but each victim row scores that victim's own window.",
  }),

  RAINSTORM: localModifierRow({
    metadataValidation:
      "multiplier + window; the holder's own UMBRELLA row adjusts this term and must be read with it.",
    note: "AoE cast writes one row per rival; each row scores that rival's own window.",
  }),

  RALLY_FLAG: row({
    classification: "RACE_WIDE",
    history: HISTORY.ACTIVE_AND_EXPIRED,
    edgeDirection: "NONE",
    earliestBoundary: "min(startsAt, expiresAt)",
    metadataValidation: null,
    fallbackCondition:
      "Any RALLY_FLAG row in the scoring graph forces FULL in v1.",
    note:
      "Team-scoped buff. v1 does not model team membership in the graph, and isTeamRace is an independent explicit FULL condition (the worker's retainTeamAsOfHeartbeat/buildTeamsBlock assume a full field).",
  }),

  RED_CARD: bonusTimelineRow(
    "Penalty subtracted from the named target's own bonus timeline."
  ),

  RUNNERS_HIGH: localModifierRow({
    metadataValidation: "multiplier + window; stepsAtStart/stepsAtExpiry snapshot.",
    note: "Self buff over the holder's own window.",
  }),

  SECOND_WIND: bonusTimelineRow("Flat bonus on the caster's own bonus timeline."),

  SHORTCUT: bonusTimelineRow(
    "Two-sided steal: +stolen for the actor, -stolen for the target. NOT a dependency edge — the magnitude is frozen in the event row at cast time, so each side folds a constant, not the other side's computed total."
  ),

  SIGNAL_JAMMER: neverReadRow(
    "Blocks the target's powerup use. No score term."
  ),

  SNEAKY_SWAP: neverReadRow(
    "Moves inventory rows between participants at cast time. No score term; the stolen powerup carries its own classification when later used."
  ),

  STEALTH_MODE: neverReadRow(
    "Hides the holder from targeting/display. No score term."
  ),

  TRAIL_MAGNET: neverReadRow(
    "Lowers the caster's nextBoxAtSteps threshold. Box cadence only, no score term."
  ),

  TRAIL_MINE: row({
    classification: "CLOSURE_ELIGIBLE_WITH_ESCALATION",
    history: HISTORY.ACTIVE_ONLY,
    edgeDirection: "NONE",
    earliestBoundary:
      "None from time: a mine is threshold-triggered, not time-triggered. Its boundary is the escalation predicate below, re-evaluated every generation.",
    metadataValidation:
      "positionSteps and penaltyPercent must both be numbers (triggerTrailMines skips the mine otherwise); metadata.aheadParticipantIds when present replaces the previous-total heuristic.",
    fallbackCondition:
      "MANDATORY ESCALATION (spec rule 3, architecture review 3): evaluate triggerTrailMines' candidate predicate over a FULL-FIELD projection — newly computed totals for closure participants, persisted race_participants.total_steps for every other accepted row from the same fingerprint read. If ANY non-closure participant qualifies as a candidate for ANY active mine, escalate the generation to FULL before the fence, with no closure write. Required because reconcileUploaderRaces (recordSteps.js:193-211) persists a syncing user's total OUTSIDE the worker, so a participant absent from this dirty set can have crossed a threshold since the last full run; candidates[0] is the LOWEST-total crosser, so omitting them changes which player the mine hits and the mine then EXPIREs.",
    note:
      "Never SCORING_INERT: it reads every participant's total. Not a hard veto either — prod forensics 2026-08-14 measured ~5.6h mine lifetimes on the Weekly Challenge, so a veto makes the v1 production gate unachievable on the target race. When the victim is a closure participant and no non-closure participant qualifies, the detonation proceeds inside the closure (its only writes are the victim's bonusSteps, the mine row, and one feed event).",
  }),

  TRAIL_MIX: bonusTimelineRow("Flat bonus on the caster's own bonus timeline."),

  UMBRELLA: localModifierRow({
    metadataValidation:
      "Immunity/reduction metadata; consumed alongside the holder's own RAINSTORM rows.",
    note:
      "SELF: it adjusts only its holder's Rainstorm math. It never reads or alters another participant's term.",
  }),

  UPRISING: row({
    classification: "RACE_WIDE",
    history: HISTORY.ACTIVE_AND_EXPIRED,
    edgeDirection: "NONE",
    earliestBoundary: "min(startsAt, expiresAt)",
    metadataValidation: null,
    fallbackCondition: "Any UPRISING row in the scoring graph forces FULL in v1.",
    note:
      "Team-scoped buff whose magnitude depends on team standing. v1 does not model team membership in the graph.",
  }),

  WRONG_TURN: localModifierRow({
    metadataValidation:
      "multiplier + window; signed-sum stacking with concurrent buffs is the scorer's concern, not a cross-participant edge.",
    note: "Opponent-cast, but the score term is entirely the target's own window.",
  }),
});

// Classifications that force FULL when present in the relevant graph component.
const FULL_FORCING_CLASSIFICATIONS = Object.freeze(new Set(["RACE_WIDE", "UNSUPPORTED"]));

class UnclassifiedPowerupTypeError extends Error {
  constructor(type) {
    super(
      `raceScoringDependencyClosure: no scoring classification row for powerup type "${type}". ` +
        "A new PowerupType is unsafe until deliberately classified; add a row before shipping the type."
    );
    this.name = "UnclassifiedPowerupTypeError";
    this.powerupType = type;
  }
}

// Throws on an unknown/unclassified type. Callers must treat the throw as FULL;
// it may never be swallowed into a default classification.
function classifyPowerupTypeForScoring(type) {
  const entry = SCORING_CLASSIFICATION_BY_TYPE[type];
  if (!entry || !Object.hasOwn(SCORING_CLASSIFICATION_BY_TYPE, type)) {
    throw new UnclassifiedPowerupTypeError(type);
  }
  return entry;
}

// Structural guard. Verifies the checked-in table against its authoritative
// sources and returns the list of problems; empty means the table is coherent.
// Both `scopeTable` and `sourceLists` are injectable so a test can simulate a
// newly added PowerupType and a type entering one of the five source lists.
function findClassificationTableProblems(
  scopeTable = POWERUP_SCOPE_BY_TYPE,
  sourceLists = NON_INERT_SOURCE_LISTS
) {
  const problems = [];
  const scopeKeys = Object.keys(scopeTable);
  const tableKeys = Object.keys(SCORING_CLASSIFICATION_BY_TYPE);
  const nonInert = new Set(sourceLists.flatMap(([, list]) => list));

  for (const type of scopeKeys) {
    if (!Object.hasOwn(SCORING_CLASSIFICATION_BY_TYPE, type)) {
      problems.push(`missing classification row for POWERUP_SCOPE_BY_TYPE key "${type}"`);
    }
  }
  for (const type of tableKeys) {
    if (!Object.hasOwn(scopeTable, type)) {
      problems.push(`classification row "${type}" is not a POWERUP_SCOPE_BY_TYPE key`);
    }
  }

  for (const [type, entry] of Object.entries(SCORING_CLASSIFICATION_BY_TYPE)) {
    if (!CLASSIFICATIONS.has(entry.classification)) {
      problems.push(`"${type}" has unknown classification "${entry.classification}"`);
    }
    if (entry.classification === "SCORING_INERT" && nonInert.has(type)) {
      const lists = sourceLists
        .filter(([, list]) => list.includes(type))
        .map(([name]) => name)
        .join(", ");
      problems.push(`"${type}" is SCORING_INERT but appears in ${lists}`);
    }
    if (
      entry.classification === "CLOSURE_ELIGIBLE_WITH_ESCALATION" &&
      type !== "TRAIL_MINE"
    ) {
      problems.push(
        `"${type}" is CLOSURE_ELIGIBLE_WITH_ESCALATION; only TRAIL_MINE may carry that classification in v1`
      );
    }
    // Spec rule 3 requires every row to pin all seven fields. Phase 2 reads
    // edgeDirection off the row; it may not re-derive it from the type.
    if (!EDGE_DIRECTIONS.has(entry.edgeDirection)) {
      problems.push(`"${type}" has unknown edgeDirection "${entry.edgeDirection}"`);
    }
    if (entry.classification === "DEPENDENCY" && entry.edgeDirection === "NONE") {
      problems.push(`"${type}" is DEPENDENCY but pins no edge direction`);
    }
    if (entry.classification !== "DEPENDENCY" && entry.edgeDirection !== "NONE") {
      problems.push(
        `"${type}" pins edgeDirection "${entry.edgeDirection}" without a DEPENDENCY classification`
      );
    }
    if (!Object.hasOwn(entry, "earliestBoundary")) {
      problems.push(`"${type}" is missing earliestBoundary`);
    } else if (
      entry.earliestBoundary !== null &&
      typeof entry.earliestBoundary !== "string"
    ) {
      problems.push(`"${type}" has a non-string earliestBoundary`);
    }
  }

  return problems;
}

module.exports = {
  SCORING_CLASSIFICATION_BY_TYPE,
  CLASSIFICATIONS,
  EDGE_DIRECTIONS,
  HISTORY,
  NON_INERT_TYPES,
  NON_INERT_SOURCE_LISTS,
  FULL_FORCING_CLASSIFICATIONS,
  UnclassifiedPowerupTypeError,
  classifyPowerupTypeForScoring,
  findClassificationTableProblems,
};
