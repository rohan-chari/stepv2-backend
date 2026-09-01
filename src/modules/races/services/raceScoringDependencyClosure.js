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
const { digestPayload } = require("./raceResolutionDisplayArtifact");

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

// ---------------------------------------------------------------------------
// PHASE 2a — the planner.
//
// Standalone: nothing in the worker calls this yet (Phase 2b wires it into the
// shadow log). It reads, it never writes, and every unproven condition returns
// plan FULL with a classified reason from CLOSURE_FALLBACK_REASONS.
// ---------------------------------------------------------------------------

// effectMultiplier is pure (no DB), so it is safe at module load.
const { multiplierBoundaries } = require("./effectMultiplier");

const HOUR_MS = 60 * 60 * 1000;

// Spec rule 5.
// The intake queue already enforces this exact 1,000-participant envelope cap.
// Keeping a smaller planner cap turned a valid coalesced launch wave into a
// 10,000-row FULL recomputation, often repeatedly while uploads continued.
// The closure remains strictly bounded, but can now consume the complete
// durable envelope that upstream is allowed to produce.
const MAX_DEPENDENCY_CLOSURE_PARTICIPANTS = 1000;
// Hard ceiling on the closure's exclusive validity deadline. `validUntil` is a
// NECESSARY condition only — it says "no boundary we can SEE crosses before
// this". Sufficiency comes from the in-fence fingerprint re-verify, never from
// this timestamp. The cap exists because some boundaries are structurally
// invisible to a candidate-time read (a global event created after the read; a
// sample bucket for a user whose row we did not select; an effect cast between
// the read and the fence), so an uncapped deadline derived only from race
// `endsAt` would let a closure claim validity for days.
const MAX_CLOSURE_VALIDITY_MS = 10 * 60 * 1000;

// hitchhikeCopies.js: `Number(effect.metadata?.scoringVersion) || 1`. Version 1
// is the legacy top-of-hour copy; version 2 runs the shared scorer clipped to
// the window. Anything else is an unknown scoring rule -> FULL (spec rule 6).
const SUPPORTED_HITCHHIKE_SCORING_VERSIONS = Object.freeze(new Set([1, 2, 3]));
const LEGACY_HITCHHIKE_SCORING_VERSION = 1;

// Types whose DUE expiry consumes a closure-computed value for its target
// (spec rule 3's narrowed veto): SNAPSHOT_AT_EXPIRY_TYPES stamp stepsAtExpiry
// and DRILL_SERGEANT judges its dare, both by looking the target up in the
// generation's participantSteps map and both SILENTLY skipping a missing key.
const DUE_EXPIRY_VETO_TYPES = Object.freeze(
  new Set([...SNAPSHOT_AT_EXPIRY_TYPES, "DRILL_SERGEANT"])
);
const MULTIPLIER_BOUNDARY_TYPES = Object.freeze(new Set([
  "LEG_CRAMP", "QUICKSAND", "RUNNERS_HIGH", "WRONG_TURN",
  "CAMPFIRE_REST", "RAINSTORM", "UPRISING", "RALLY_FLAG",
  "GHOST_PEPPER", "COIN_FLIP",
]));

// The CLOSED enum of fallback reasons. Never a free-text string: these values
// are the observability dimension the rollout gates are read from.
const CLOSURE_FALLBACK_REASONS = Object.freeze({
  // --- admission (rule 1) ---
  NOT_STEP_SYNC_REASON_SET: "NOT_STEP_SYNC_REASON_SET",
  JOB_ENVELOPE_INVALID: "JOB_ENVELOPE_INVALID",
  DIRTY_PARTICIPANTS_INVALID: "DIRTY_PARTICIPANTS_INVALID",
  UPLOADER_SNAPSHOT_INCOHERENT: "UPLOADER_SNAPSHOT_INCOHERENT",
  // --- reads (rules 2, 7) ---
  GRAPH_READ_FAILED: "GRAPH_READ_FAILED",
  FINGERPRINT_UNAVAILABLE: "FINGERPRINT_UNAVAILABLE",
  // --- race lifecycle (rules 3, 5) ---
  RACE_NOT_ACTIVE: "RACE_NOT_ACTIVE",
  RACE_WINDOW_CLOSED: "RACE_WINDOW_CLOSED",
  TEAM_RACE: "TEAM_RACE",
  // --- graph classification (rules 3, 6) ---
  UNKNOWN_POWERUP_TYPE: "UNKNOWN_POWERUP_TYPE",
  RACE_WIDE_EFFECT_ACTIVE: "RACE_WIDE_EFFECT_ACTIVE",
  UNSUPPORTED_EFFECT_ACTIVE: "UNSUPPORTED_EFFECT_ACTIVE",
  UNSUPPORTED_HITCHHIKE_VERSION: "UNSUPPORTED_HITCHHIKE_VERSION",
  EFFECT_ROW_MALFORMED: "EFFECT_ROW_MALFORMED",
  // A LEECH/HITCHHIKE row whose source (or target) is not an accepted
  // participant. See the veto's rationale at the traversal site: the
  // fingerprint's `members` CTE is accepted-only, so such a source's
  // user_scoring_input_versions generation is never digested.
  RETAINED_SOURCE_UNRESOLVED: "RETAINED_SOURCE_UNRESOLVED",
  // --- boundaries and bounds (rules 5, 7) ---
  GLOBAL_EVENT_ACTIVE: "GLOBAL_EVENT_ACTIVE",
  GLOBAL_BOUNDARY_SCHEDULE_UNAVAILABLE: "GLOBAL_BOUNDARY_SCHEDULE_UNAVAILABLE",
  BOUNDARY_METADATA_UNCLASSIFIABLE: "BOUNDARY_METADATA_UNCLASSIFIABLE",
  CLOSURE_CAP_EXCEEDED: "CLOSURE_CAP_EXCEEDED",
  DUE_EXPIRY_OUTSIDE_CLOSURE: "DUE_EXPIRY_OUTSIDE_CLOSURE",
});

const CLOSURE_FALLBACK_REASON_VALUES = Object.freeze(
  new Set(Object.values(CLOSURE_FALLBACK_REASONS))
);

// The shipped fingerprint module pulls in prisma at require time. Phase 1's
// table (and its structural test) must stay dependency-free, so the default is
// resolved lazily on first planner call instead of at module load.
let cachedFingerprintBuilder = null;
function resolveFingerprintBuilder(injected) {
  if (typeof injected === "function") return injected;
  if (!cachedFingerprintBuilder) {
    ({
      buildRaceResolutionInputFingerprint: cachedFingerprintBuilder,
    } = require("./raceResolutionInputFingerprint"));
  }
  return cachedFingerprintBuilder;
}

// Same lazy-require rationale: raceResolutionStepSyncScope loads the Race model
// (and therefore prisma). The admitted reason SET has exactly ONE definition —
// that module's — so the gatekeeper and the planner can never drift apart.
let cachedStepSyncScopeModule = null;
function stepSyncScopeModule() {
  if (!cachedStepSyncScopeModule) {
    cachedStepSyncScopeModule = require("./raceResolutionStepSyncScope");
  }
  return cachedStepSyncScopeModule;
}

function reasonSetIsClosureEligible(reasons) {
  return stepSyncScopeModule().isClosureEligibleReasonSet(reasons) ||
    stepSyncScopeModule().isSourceInputClosureEligibleReasonSet(reasons);
}

// The dirty-row ceiling is the gatekeeper's, imported rather than re-stated:
// two copies of the same number drift, and the closure must never admit an
// envelope the cheap plan would have refused.
function maxDirtyParticipants() {
  return stepSyncScopeModule().MAX_STEP_SYNC_DIRTY_PARTICIPANTS;
}

function toMsOrNull(value) {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function effectBoundaryMetadataIsClassifiable(effect) {
  if (!effect || toMsOrNull(effect.startsAt) == null) return false;
  if (effect.expiresAt != null && toMsOrNull(effect.expiresAt) == null) return false;
  if (DUE_EXPIRY_VETO_TYPES.has(effect.type) && effect.expiresAt == null) return false;
  if (effect.type === "CAMPFIRE_REST" && effect.metadata?.freezeMs != null) {
    return typeof effect.metadata.freezeMs === "number" &&
      Number.isFinite(effect.metadata.freezeMs) && effect.metadata.freezeMs >= 0;
  }
  if (effect.type === "GHOST_PEPPER" && effect.metadata?.boostMs != null) {
    return typeof effect.metadata.boostMs === "number" &&
      Number.isFinite(effect.metadata.boostMs) && effect.metadata.boostMs >= 0;
  }
  return true;
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

// Effect rows arrive from up to three reads (active set + LEECH history +
// HITCHHIKE history) whose populations overlap on the ACTIVE rows. Dedupe by
// id, preferring the first sighting, so an edge is never counted twice.
function dedupeById(rowLists) {
  const byId = new Map();
  for (const rows of rowLists) {
    for (const row of rows || []) {
      if (!row || !row.id || byId.has(row.id)) continue;
      byId.set(row.id, row);
    }
  }
  return [...byId.values()];
}

// hitchhikeCopies.js reads the version off metadata and defaults an ABSENT
// value to legacy v1. A PRESENT but unrecognized value is the "unknown stored
// scoring version" case the spec sends to FULL — it must not silently adopt
// the legacy default here.
function hitchhikeScoringVersion(effect) {
  const raw = effect?.metadata?.scoringVersion;
  if (raw == null) return LEGACY_HITCHHIKE_SCORING_VERSION;
  const version = Number(raw);
  if (!Number.isFinite(version)) return null;
  return SUPPORTED_HITCHHIKE_SCORING_VERSIONS.has(version) ? version : null;
}

function participantTotalsFrom(rows) {
  const totals = {};
  for (const row of rows || []) {
    if (!row?.id) continue;
    // MUST match what triggerTrailMines actually scores a row at, or the
    // escalation predicate and the detonation disagree about who is a
    // candidate. A FINISHED participant is NOT skipped by triggerTrailMines —
    // only a forfeited one is — and its total in `stepTotals` is the FROZEN
    // `finishTotalSteps ?? totalSteps` (raceStateResolution.js's Phase A frozen
    // branch), which can be strictly GREATER than the persisted `total_steps`.
    //
    // Reading `total_steps` alone would judge a non-closure finished row with
    // finish_total_steps >= positionSteps > total_steps as "not a candidate",
    // report no escalation, and let the closure detonate on the wrong player —
    // after which the mine EXPIREs, which is unrecoverable.
    const finishedAt = row.finishedAt ?? row.finished_at ?? null;
    const finishTotal = row.finishTotalSteps ?? row.finish_total_steps ?? null;
    const persistedTotal = Number(row.totalSteps ?? row.total_steps ?? 0);
    const scoredTotal =
      finishedAt && finishTotal != null ? Number(finishTotal) : persistedTotal;
    totals[row.id] = {
      participantId: row.id,
      totalSteps: scoredTotal,
      // Set only when the row is finished AND the fingerprint did not supply a
      // frozen total to score it at. `wouldTrailMineEscalate` treats this as an
      // unconditional escalation: we cannot compute the number the detonation
      // would compare against, and guessing `total_steps` would be a definite
      // answer to a question we did not answer.
      finishedTotalUnknown: Boolean(finishedAt) && finishTotal == null,
      // DELIBERATELY ABSENT. The persisted total is the value AFTER whatever
      // has already been written this generation (reconcileUploaderRaces
      // persists a syncing user's own row outside the worker), so aliasing it
      // to previousTotalSteps would make the legacy "was below at plant time"
      // heuristic read as a definite NO. Left undefined, the predicate reports
      // UNKNOWN instead — the only honest answer without a pre-generation value.
      forfeitedAt: row.forfeitedAt ?? row.forfeited_at ?? null,
    };
  }
  return totals;
}

// A closure commit must fence every input that can affect the participants it
// writes, but it must not be invalidated by an unrelated runner uploading while
// a 10k-person event race is being processed. The display-artifact digest is
// deliberately race-wide and includes every user's scoring generation and
// mutable total, so it cannot serve that purpose during a launch wave.
//
// This projection is derived from the SAME authoritative fingerprint read:
// membership/race structure and the complete effect graph remain race-wide;
// mutable participant state, user scoring generations, and local-event
// entitlements are retained only for the closure. Trail mines keep the full
// totals projection because their candidate choice is field-wide.
function buildClosureFingerprintDigest(fingerprint, {
  participantIds = [],
  minesActive = false,
  balanceConfigVersion = null,
} = {}) {
  if (!fingerprint?.race || !Array.isArray(fingerprint.participants)) return null;
  const closure = new Set(participantIds);
  const closureUsers = new Set();
  const participants = fingerprint.participants.map((row) => {
    if (closure.has(row.id)) {
      closureUsers.add(row.userId);
      return row;
    }
    const structural = {
      id: row.id,
      userId: row.userId,
      status: row.status,
      finishedAt: row.finishedAt,
      forfeitedAt: row.forfeitedAt,
      joinedAt: row.joinedAt,
      team: row.team,
    };
    return minesActive
      ? {
          ...structural,
          totalSteps: row.totalSteps,
          finishTotalSteps: row.finishTotalSteps,
        }
      : structural;
  });
  const inputs = (fingerprint.inputs || []).filter(
    (row) => closureUsers.has(row.userId),
  );
  const events = (fingerprint.globalEvents || []).filter(
    (row) => row.userId == null || closureUsers.has(row.userId),
  );
  return digestPayload({
    schema: 1,
    race: fingerprint.race,
    participants,
    inputs,
    effects: fingerprint.activeEffects || [],
    expiredScoringEffects: fingerprint.expiredScoringEffects || [],
    events,
    balanceConfigVersion: balanceConfigVersion == null
      ? "code-default"
      : String(balanceConfigVersion),
  });
}

function normalizeTotalsInput(participantTotals) {
  if (participantTotals instanceof Map) {
    return [...participantTotals.entries()].map(([participantId, row]) => ({
      participantId,
      ...(row || {}),
    }));
  }
  if (Array.isArray(participantTotals)) {
    return participantTotals.filter(Boolean);
  }
  return Object.entries(participantTotals || {}).map(([participantId, row]) => ({
    participantId,
    ...(row || {}),
  }));
}

// The TRAIL_MINE escalation predicate (spec rule 3), evaluated over a
// FULL-FIELD projection. It is a faithful transcription of triggerTrailMines'
// candidate filter (raceStateResolution.js:551-566), with the team filter
// omitted — isTeamRace is an independent FULL veto so a team race never reaches
// here, and omitting it only ever escalates MORE.
//
// TRI-STATE, and the third state is load-bearing:
//   true      — a non-closure participant provably qualifies as a candidate.
//   false     — provably none does; the detonation may stay inside the closure.
//   "UNKNOWN" — a legacy mine (no `aheadParticipantIds`, planted before
//               2026-08-07 and still ACTIVE in prod on rows with a null
//               expiresAt) has a non-closure participant at or past its
//               threshold, but the caller supplied no `previousTotalSteps`, so
//               "was they already ahead when it was planted?" is unanswerable.
// CALLERS MUST TREAT "UNKNOWN" AS ESCALATE. Reporting false there would be a
// definite negative for a question we did not answer, and the consequence is
// the wrong player taking the mine (candidates[0] is the LOWEST-total crosser)
// followed by the mine EXPIRING — unrecoverable.
//
// `true` outranks `"UNKNOWN"`: a definite candidate anywhere ends the scan.
const TRAIL_MINE_ESCALATION_UNKNOWN = "UNKNOWN";

function wouldTrailMineEscalate({
  mines = [],
  closureIds = [],
  participantTotals = {},
} = {}) {
  const closure = new Set(closureIds);
  const rows = normalizeTotalsInput(participantTotals);
  let unknown = false;
  for (const mine of mines || []) {
    const metadata = (mine && mine.metadata) || {};
    const positionSteps = metadata.positionSteps;
    const penaltyPercent = metadata.penaltyPercent;
    // triggerTrailMines skips the mine entirely on either non-number.
    if (typeof positionSteps !== "number" || typeof penaltyPercent !== "number") {
      continue;
    }
    const ownerParticipantId =
      metadata.ownerParticipantId || (mine && mine.targetParticipantId) || null;
    const aheadAtPlant = Array.isArray(metadata.aheadParticipantIds)
      ? new Set(metadata.aheadParticipantIds)
      : null;
    for (const row of rows) {
      if (!row?.participantId) continue;
      if (closure.has(row.participantId)) continue;
      if (row.participantId === ownerParticipantId) continue;
      // triggerTrailMines skips forfeited rows (TR-657) and ONLY forfeited
      // rows; a finished row is still a live mine candidate at its frozen total.
      if (row.forfeitedAt) continue;
      // A finished row whose frozen total we could not read is unanswerable,
      // not "no". Same rule as the legacy-mine case below.
      if (row.finishedTotalUnknown) {
        unknown = true;
        continue;
      }
      const total = Number(row.totalSteps);
      if (!Number.isFinite(total) || total < positionSteps) continue;
      if (aheadAtPlant) {
        if (!aheadAtPlant.has(row.participantId)) return true;
        continue;
      }
      if (row.previousTotalSteps == null) {
        // Legacy mine + no pre-generation total: unanswerable, not "no".
        unknown = true;
        continue;
      }
      const previous = Number(row.previousTotalSteps);
      if (!Number.isFinite(previous)) {
        unknown = true;
        continue;
      }
      if (previous < positionSteps) return true;
    }
  }
  return unknown ? TRAIL_MINE_ESCALATION_UNKNOWN : false;
}

// Every multiplier-transition instant strictly after `asOf` that the closure's
// own effect rows can produce, using the PINNED multiplierBoundaries semantics
// (so startsAt+freezeMs / startsAt+boostMs intra-effect transitions are
// included — computeArtifactReuseDeadline's startsAt/expiresAt enumeration is
// not sufficient, spec rule 7).
function nextMultiplierBoundaryMs(effects, asOfMs, horizonMs) {
  const groups = {
    legCramps: [],
    runnersHighs: [],
    wrongTurns: [],
    campfires: [],
    rainstorms: [],
    uprisings: [],
    rallyFlags: [],
    coinFlipWins: [],
    coinFlipLoses: [],
    ghostPeppers: [],
  };
  for (const effect of effects) {
    switch (effect.type) {
      case "LEG_CRAMP":
      case "QUICKSAND":
        groups.legCramps.push(effect);
        break;
      case "RUNNERS_HIGH":
        groups.runnersHighs.push(effect);
        break;
      case "WRONG_TURN":
        groups.wrongTurns.push(effect);
        break;
      case "CAMPFIRE_REST":
        groups.campfires.push(effect);
        break;
      case "RAINSTORM":
        groups.rainstorms.push(effect);
        break;
      case "UPRISING":
        groups.uprisings.push(effect);
        break;
      case "RALLY_FLAG":
        groups.rallyFlags.push(effect);
        break;
      case "GHOST_PEPPER":
        groups.ghostPeppers.push(effect);
        break;
      case "COIN_FLIP": {
        const multiplier = Number((effect.metadata || {}).multiplier);
        if (Number.isFinite(multiplier) && multiplier < 1) {
          groups.coinFlipLoses.push(effect);
        } else {
          groups.coinFlipWins.push(effect);
        }
        break;
      }
      default:
        break;
    }
  }
  if (!(horizonMs > asOfMs)) return null;
  const boundaries = multiplierBoundaries(asOfMs, horizonMs, groups);
  const next = boundaries.find((ms) => ms > asOfMs);
  return next == null ? null : next;
}

async function buildRaceScoringDependencyClosure({
  raceId,
  dirtyParticipantIds,
  job,
  now,
  Race,
  RaceActiveEffect,
  RaceParticipant,
  // Additive, optional, test-injectable. Defaults to the SHIPPED fingerprint —
  // spec rule 7 prohibits a second implementation.
  buildInputFingerprint,
  balanceConfigVersion = null,
  fingerprintClient,
} = {}) {
  const asOf = now instanceof Date ? new Date(now.getTime()) : new Date(now || Date.now());
  const rawSources = Array.isArray(dirtyParticipantIds)
    ? dirtyParticipantIds
    : job && Array.isArray(job.processingDirtyParticipantIds)
      ? job.processingDirtyParticipantIds
      : [];
  const sourceParticipantIds = sortedUnique(
    rawSources.filter((id) => typeof id === "string" && id.length > 0)
  );

  const fallback = (fallbackReason, extra = {}) => ({
    plan: "FULL",
    participantIds: [],
    sourceParticipantIds,
    graphFingerprint: null,
    asOf,
    fallbackReason,
    validUntil: null,
    minesActive: false,
    mines: [],
    participantTotals: {},
    acceptedParticipantCount: null,
    ...extra,
  });

  if (Number.isNaN(asOf.getTime())) {
    return fallback(CLOSURE_FALLBACK_REASONS.JOB_ENVELOPE_INVALID);
  }
  if (!raceId || typeof raceId !== "string") {
    return fallback(CLOSURE_FALLBACK_REASONS.JOB_ENVELOPE_INVALID);
  }
  if (!job || !Array.isArray(job.processingTriggeredByUserIds)) {
    return fallback(CLOSURE_FALLBACK_REASONS.JOB_ENVELOPE_INVALID);
  }
  // Gated on the reason SET, never on resolutionPlanForDirtyReasons' base plan
  // (spec rule 1): that helper returns FULL for RECOVERY/DAILY_MOVER/… and
  // reading it here would make the closure unreachable.
  if (!reasonSetIsClosureEligible(job.processingDirtyReasons)) {
    return fallback(CLOSURE_FALLBACK_REASONS.NOT_STEP_SYNC_REASON_SET);
  }
  const claimStartedAt = new Date(job.startedAt || 0);
  if (Number.isNaN(claimStartedAt.getTime())) {
    return fallback(CLOSURE_FALLBACK_REASONS.JOB_ENVELOPE_INVALID);
  }
  if (
    sourceParticipantIds.length === 0 ||
    sourceParticipantIds.length !== rawSources.length ||
    sourceParticipantIds.length > maxDirtyParticipants()
  ) {
    return fallback(CLOSURE_FALLBACK_REASONS.DIRTY_PARTICIPANTS_INVALID);
  }

  // Fingerprint FIRST, graph reads second. The ordering is deliberate: a row
  // written between the two reads lands in the GRAPH but not the digest, which
  // can only widen the closure or trip a veto (safe), and the fence's re-read
  // in a later phase then mismatches and retries as FULL. The reverse order
  // would let a row be digested yet missing from the graph — an edge the
  // closure never saw, with a digest that still verifies.
  const fingerprintBuilder = resolveFingerprintBuilder(buildInputFingerprint);
  let fingerprint = null;
  let race = null;
  let activeEffects = [];
  let leechHistory = [];
  let hitchhikeHistory = [];
  try {
    fingerprint = await fingerprintBuilder({
      raceId,
      now: asOf,
      balanceConfigVersion,
      ...(fingerprintClient ? { client: fingerprintClient } : {}),
    });
    if (!fingerprint || typeof fingerprint.digest !== "string") {
      return fallback(CLOSURE_FALLBACK_REASONS.FINGERPRINT_UNAVAILABLE);
    }
    // The shipped fingerprint already returns the complete race row, roster,
    // ACTIVE effect set, and retained EXPIRED dependency rows. Reuse that one
    // coherent graph instead of immediately loading the same 10k-person race
    // and effect history a second time. The model path remains a fail-closed
    // compatibility seam for injected/older fingerprint builders.
    const fingerprintHasGraph =
      fingerprint.race &&
      Array.isArray(fingerprint.participants) &&
      Array.isArray(fingerprint.activeEffects) &&
      Array.isArray(fingerprint.expiredScoringEffects);
    if (fingerprintHasGraph) {
      race = { ...fingerprint.race, participants: fingerprint.participants };
      activeEffects = fingerprint.activeEffects;
      const retainedEffects = dedupeById([
        fingerprint.activeEffects,
        fingerprint.expiredScoringEffects,
      ]);
      leechHistory = retainedEffects.filter((effect) => effect.type === "LEECH");
      hitchhikeHistory = retainedEffects.filter(
        (effect) => effect.type === "HITCHHIKE",
      );
    } else {
      const raceModel = Race;
      const effectModel = RaceActiveEffect;
      if (
        !raceModel ||
        typeof raceModel.findById !== "function" ||
        !effectModel ||
        typeof effectModel.findActiveForRace !== "function" ||
        typeof effectModel.findRaceEffectsByType !== "function"
      ) {
        return fallback(CLOSURE_FALLBACK_REASONS.GRAPH_READ_FAILED);
      }
      [race, activeEffects, leechHistory, hitchhikeHistory] = await Promise.all([
        raceModel.findById(raceId),
        effectModel.findActiveForRace(raceId),
        effectModel.findRaceEffectsByType(raceId, "LEECH"),
        effectModel.findRaceEffectsByType(raceId, "HITCHHIKE"),
      ]);
    }
  } catch {
    return fallback(CLOSURE_FALLBACK_REASONS.GRAPH_READ_FAILED);
  }

  if (!race || race.status !== "ACTIVE") {
    return fallback(CLOSURE_FALLBACK_REASONS.RACE_NOT_ACTIVE);
  }
  // Explicit FULL row, not an inference: the worker's team write logic assumes
  // a full field (spec rule 3).
  if (race.isTeamRace === true) {
    return fallback(CLOSURE_FALLBACK_REASONS.TEAM_RACE);
  }
  const asOfMs = asOf.getTime();
  const raceEndsAtMs = toMsOrNull(race.endsAt);
  if (race.endsAt != null && raceEndsAtMs == null) {
    return fallback(CLOSURE_FALLBACK_REASONS.BOUNDARY_METADATA_UNCLASSIFIABLE);
  }
  if (raceEndsAtMs != null && raceEndsAtMs <= asOfMs) {
    return fallback(CLOSURE_FALLBACK_REASONS.RACE_WINDOW_CLOSED);
  }

  // Race.findById already includes the roster, so this costs no extra query on
  // the normal path. The RaceParticipant read is a defensive fallback for a
  // race row that arrives without its participants; a roster we cannot read at
  // all fails closed rather than producing an empty "closure".
  let rosterSource = Array.isArray(race.participants) ? race.participants : null;
  if (rosterSource == null) {
    if (typeof RaceParticipant?.findAcceptedByRace !== "function") {
      return fallback(CLOSURE_FALLBACK_REASONS.GRAPH_READ_FAILED);
    }
    try {
      rosterSource = await RaceParticipant.findAcceptedByRace(raceId);
    } catch {
      return fallback(CLOSURE_FALLBACK_REASONS.GRAPH_READ_FAILED);
    }
    if (!Array.isArray(rosterSource)) {
      return fallback(CLOSURE_FALLBACK_REASONS.GRAPH_READ_FAILED);
    }
  }
  // joinedAt order is preserved wherever current scoring/tie behavior consumes
  // it (spec rule 2); id breaks ties so the userId->participantId map below is
  // deterministic across reads.
  const accepted = rosterSource
    .filter((row) => row && row.status === "ACCEPTED")
    .slice()
    .sort((left, right) => {
      const l = toMsOrNull(left.joinedAt) ?? 0;
      const r = toMsOrNull(right.joinedAt) ?? 0;
      if (l !== r) return l - r;
      return String(left.id).localeCompare(String(right.id));
    });
  const acceptedById = new Map(accepted.map((row) => [row.id, row]));
  const participantIdByUserId = new Map();
  for (const row of accepted) {
    if (!participantIdByUserId.has(row.userId)) {
      participantIdByUserId.set(row.userId, row.id);
    }
  }

  // Coherent committed uploader snapshot (spec rule 1) — the same conditions
  // raceResolutionStepSyncScope enforces, re-checked here because that scope
  // returns null the moment the race has any active effect.
  const sourceInputPending =
    stepSyncScopeModule().isSourceInputClosureEligibleReasonSet(
      job.processingDirtyReasons
    );
  const triggeringUsers = new Set(job.processingTriggeredByUserIds);
  for (const participantId of sourceParticipantIds) {
    const participant = acceptedById.get(participantId);
    const token = new Date(participant?.totalsUpdatedAt || 0);
    if (
      !participant ||
      !triggeringUsers.has(participant.userId) ||
      (!sourceInputPending && (
        participant.totalsUpdatedAt == null ||
        Number.isNaN(token.getTime()) ||
        token.getTime() > claimStartedAt.getTime() ||
        !Number.isFinite(participant.rawSteps)
      ))
    ) {
      return fallback(CLOSURE_FALLBACK_REASONS.UPLOADER_SNAPSHOT_INCOHERENT);
    }
  }

  // Global-event multipliers are participant-local scoring inputs. They do not
  // create an edge between runners, so a live daily event remains closure-safe;
  // its start/end still enters the exclusive validity deadline and the scoped
  // fence retains the affected users' entitlement rows.
  const globalEvents = fingerprint.globalEvents || [];
  for (const event of globalEvents) {
    const startsAt = toMsOrNull(event.startsAt);
    const endsAt = toMsOrNull(event.endsAt);
    if (startsAt == null || endsAt == null) {
      return fallback(CLOSURE_FALLBACK_REASONS.GLOBAL_EVENT_ACTIVE);
    }
  }

  // --- classification of the ACTIVE set (vetoes) -----------------------------
  const mines = [];
  for (const effect of activeEffects || []) {
    let entry;
    try {
      entry = classifyPowerupTypeForScoring(effect?.type);
    } catch {
      return fallback(CLOSURE_FALLBACK_REASONS.UNKNOWN_POWERUP_TYPE);
    }
    if (entry.classification === "RACE_WIDE") {
      return fallback(CLOSURE_FALLBACK_REASONS.RACE_WIDE_EFFECT_ACTIVE);
    }
    if (entry.classification === "UNSUPPORTED") {
      return fallback(CLOSURE_FALLBACK_REASONS.UNSUPPORTED_EFFECT_ACTIVE);
    }
    if (entry.classification === "CLOSURE_ELIGIBLE_WITH_ESCALATION") {
      // TRAIL_MINE does NOT veto. It is surfaced for the escalation predicate.
      mines.push(effect);
    }
    // SELF and SCORING_INERT contribute neither an edge nor a veto.
  }

  // --- dependency edges (ACTIVE + EXPIRED history) --------------------------
  const historyRows = dedupeById([
    leechHistory,
    hitchhikeHistory,
    (activeEffects || []).filter(
      (effect) => effect?.type === "LEECH" || effect?.type === "HITCHHIKE"
    ),
  ]);
  const edges = [];
  const adjacency = new Map();
  const addAdjacency = (from, to) => {
    if (!adjacency.has(from)) adjacency.set(from, new Set());
    adjacency.get(from).add(to);
  };
  // Rule 9: a Leech source that is frozen, no longer accepted, or absent from
  // the active scoring entries STILL drains its victim — computeLeechEarnedTransfer
  // reads that source's step samples by sourceUserId with no participation
  // check. The victim's correct total therefore depends on an input the
  // fingerprint CANNOT see: buildRaceResolutionInputFingerprint's `members` CTE
  // selects `status='accepted'` only, so an unaccepted source's
  // user_scoring_input_versions generation is never digested. Its re-upload
  // would change a closure participant's correct total while leaving the digest
  // UNCHANGED, and the fence would then wave a stale write through.
  //
  // v1 therefore records these rows and takes FULL. Widening the fingerprint's
  // member set to cover them is the real fix and is deliberately deferred: it
  // changes a shipped digest's input set for every consumer, which is not a
  // Phase 2a change.
  const retainedUnresolvedSources = [];
  let hasLegacyHitchhike = false;

  for (const effect of historyRows) {
    const entry = SCORING_CLASSIFICATION_BY_TYPE[effect.type];
    if (!entry || entry.classification !== "DEPENDENCY") {
      return fallback(CLOSURE_FALLBACK_REASONS.UNKNOWN_POWERUP_TYPE);
    }
    if (!effect.targetParticipantId || !effect.sourceUserId) {
      return fallback(CLOSURE_FALLBACK_REASONS.EFFECT_ROW_MALFORMED);
    }
    if (effect.type === "HITCHHIKE") {
      const version = hitchhikeScoringVersion(effect);
      if (version == null) {
        return fallback(CLOSURE_FALLBACK_REASONS.UNSUPPORTED_HITCHHIKE_VERSION);
      }
      if (version === LEGACY_HITCHHIKE_SCORING_VERSION) hasLegacyHitchhike = true;
    }
    const targetParticipantId = acceptedById.has(effect.targetParticipantId)
      ? effect.targetParticipantId
      : participantIdByUserId.get(effect.targetUserId) || null;
    const sourceParticipantId =
      participantIdByUserId.get(effect.sourceUserId) || null;
    if (!targetParticipantId || !sourceParticipantId) {
      retainedUnresolvedSources.push({
        effectId: effect.id,
        type: effect.type,
        targetParticipantId,
        sourceParticipantId,
      });
      continue;
    }
    if (targetParticipantId === sourceParticipantId) continue;
    // Edge direction is READ off the Phase 1 table, never re-derived here.
    edges.push({
      effectId: effect.id,
      type: effect.type,
      status: effect.status,
      direction: entry.edgeDirection,
      targetParticipantId,
      sourceParticipantId,
    });
    // Traversal expands INCOMING and OUTGOING edges alike (spec rule 4), so
    // adjacency is symmetric regardless of the pinned direction; the direction
    // is retained on the edge for the later ordered-transfer work.
    addAdjacency(targetParticipantId, sourceParticipantId);
    addAdjacency(sourceParticipantId, targetParticipantId);
  }

  if (retainedUnresolvedSources.length > 0) {
    return fallback(CLOSURE_FALLBACK_REASONS.RETAINED_SOURCE_UNRESOLVED, {
      retainedUnresolvedSources,
    });
  }

  // --- traversal to fixed point ---------------------------------------------
  const closure = new Set(sourceParticipantIds);
  const queue = [...sourceParticipantIds];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const neighbour of adjacency.get(current) || []) {
      if (closure.has(neighbour)) continue;
      closure.add(neighbour);
      if (closure.size > MAX_DEPENDENCY_CLOSURE_PARTICIPANTS) {
        return fallback(CLOSURE_FALLBACK_REASONS.CLOSURE_CAP_EXCEEDED);
      }
      queue.push(neighbour);
    }
  }
  if (closure.size > MAX_DEPENDENCY_CLOSURE_PARTICIPANTS) {
    return fallback(CLOSURE_FALLBACK_REASONS.CLOSURE_CAP_EXCEEDED);
  }

  // A due snapshot/Drill expiry consumes the target's computed value. It may
  // only ride a closure when that target is already a member; pulling every
  // future-expiry target into the scoring set would turn unrelated SELF rows
  // into participant writes and defeat the closure's untouched-row guarantee.
  for (const effect of activeEffects || []) {
    if (!DUE_EXPIRY_VETO_TYPES.has(effect?.type)) continue;
    const targetId = effect?.targetParticipantId;
    if (!targetId || !acceptedById.has(targetId)) {
      return fallback(CLOSURE_FALLBACK_REASONS.EFFECT_ROW_MALFORMED);
    }
    const expiresAtMs = toMsOrNull(effect.expiresAt);
    if (expiresAtMs != null && expiresAtMs <= asOfMs && !closure.has(targetId)) {
      return fallback(CLOSURE_FALLBACK_REASONS.DUE_EXPIRY_OUTSIDE_CLOSURE);
    }
  }

  // --- exclusive validity deadline (spec rule 7) ----------------------------
  const closureRelevant = (activeEffects || []).filter((effect) => {
    if (closure.has(effect.targetParticipantId)) return true;
    const sourceParticipantId = participantIdByUserId.get(effect.sourceUserId);
    return sourceParticipantId ? closure.has(sourceParticipantId) : false;
  });
  if (closureRelevant.some((effect) =>
    !effectBoundaryMetadataIsClassifiable(effect)
  )) {
    return fallback(CLOSURE_FALLBACK_REASONS.BOUNDARY_METADATA_UNCLASSIFIABLE);
  }
  // The cap is always a candidate, so the boundary set is never empty and the
  // deadline is never synthesized out of nothing.
  const horizonMs = Math.min(
    raceEndsAtMs == null ? Infinity : raceEndsAtMs,
    asOfMs + MAX_CLOSURE_VALIDITY_MS
  );
  const deadlineCandidates = [asOfMs + MAX_CLOSURE_VALIDITY_MS];
  const addDeadline = (ms) => {
    if (ms != null && Number.isFinite(ms) && ms > asOfMs) deadlineCandidates.push(ms);
  };
  let multiplierBoundary;
  try {
    multiplierBoundary = nextMultiplierBoundaryMs(
      closureRelevant.filter((effect) => MULTIPLIER_BOUNDARY_TYPES.has(effect.type)),
      asOfMs,
      horizonMs
    );
  } catch {
    return fallback(CLOSURE_FALLBACK_REASONS.BOUNDARY_METADATA_UNCLASSIFIABLE);
  }
  addDeadline(multiplierBoundary);
  if (
    fingerprint.nextSampleBoundary != null &&
    toMsOrNull(fingerprint.nextSampleBoundary) == null
  ) {
    return fallback(CLOSURE_FALLBACK_REASONS.BOUNDARY_METADATA_UNCLASSIFIABLE);
  }
  addDeadline(toMsOrNull(fingerprint.nextSampleBoundary));
  for (const effect of closureRelevant) {
    addDeadline(toMsOrNull(effect.startsAt));
    addDeadline(toMsOrNull(effect.expiresAt));
  }
  for (const event of globalEvents) {
    addDeadline(toMsOrNull(event.startsAt));
    addDeadline(toMsOrNull(event.endsAt));
  }
  addDeadline(raceEndsAtMs);
  // Legacy Hitchhike re-buckets at every absolute top of hour.
  if (hasLegacyHitchhike) {
    addDeadline(Math.floor(asOfMs / HOUR_MS) * HOUR_MS + HOUR_MS);
  }
  const validUntil = new Date(Math.min(...deadlineCandidates));

  // Persisted totals for the TRAIL_MINE full-field projection, taken from the
  // SAME fingerprint read the spec pins (no additional query). Restricted to
  // accepted rows, which are the only ones triggerTrailMines ever scores.
  const totalsSource = Array.isArray(fingerprint.participants)
    ? fingerprint.participants.filter((row) => acceptedById.has(row?.id))
    : accepted;
  const participantTotals = participantTotalsFrom(
    totalsSource.length > 0 ? totalsSource : accepted
  );
  const closureFingerprint = buildClosureFingerprintDigest(fingerprint, {
    participantIds: [...closure],
    minesActive: mines.length > 0,
    balanceConfigVersion,
  });
  if (!closureFingerprint) {
    return fallback(CLOSURE_FALLBACK_REASONS.FINGERPRINT_UNAVAILABLE);
  }

  return {
    plan: "DEPENDENCY_CLOSURE",
    participantIds: [...closure].sort(),
    scoringParticipantIds: [...closure].sort(),
    sourceParticipantIds,
    graphFingerprint: fingerprint.digest,
    closureFingerprint,
    balanceConfigVersion,
    asOf,
    fallbackReason: null,
    // EXCLUSIVE, and a NECESSARY condition only: it asserts that no boundary
    // VISIBLE at candidate time crosses before this instant. It is never
    // sufficient on its own — the in-fence fingerprint re-verify is what makes
    // the write safe, and it stays mandatory even inside this window.
    validUntil,
    // TRAIL_MINE is closure-eligible; these two carry the escalation data.
    //
    // OBSERVABILITY CONTRACT for Phase 2b: these are IN-MEMORY handoffs to
    // wouldTrailMineEscalate, NOT log fields. The shadow log may record
    // `minesActive` (a boolean) and `wouldEscalateOnMine` (true/false/UNKNOWN)
    // and counts — never a participant id, user id, effect metadata, or any
    // step total out of `participantTotals`.
    minesActive: mines.length > 0,
    mines,
    participantTotals,
    acceptedParticipantCount: accepted.length,
    edges,
    retainedUnresolvedSources,
    hasLegacyHitchhike,
  };
}

module.exports = {
  MAX_DEPENDENCY_CLOSURE_PARTICIPANTS,
  MAX_CLOSURE_VALIDITY_MS,
  TRAIL_MINE_ESCALATION_UNKNOWN,
  CLOSURE_FALLBACK_REASONS,
  CLOSURE_FALLBACK_REASON_VALUES,
  SUPPORTED_HITCHHIKE_SCORING_VERSIONS,
  DUE_EXPIRY_VETO_TYPES,
  buildRaceScoringDependencyClosure,
  buildClosureFingerprintDigest,
  wouldTrailMineEscalate,
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
