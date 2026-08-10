// THE mystery-box odds position, from RAW WALKED steps.
// (docs/box-raw-steps-position-and-option-h-requirements.md steps 4-6.)
//
// The drop-odds position used to be computed by sorting
// `race_participants.total_steps` — the EFFECT-SENSITIVE leaderboard total — at
// open time, inline, in three different places. That opened two manipulations:
//
//   * BOX BANKING — earn boxes while leading, open them while temporarily last
//     for the trailing tier's odds.
//   * POWERUP HOARDING — unused bonus powerups keep `totalSteps` low, pinning
//     you at trailing odds for the whole race.
//
// Raw walked steps (`baseAdjusted`, the same manipulation-proof quantity box
// PROGRESS uses) only ever grow by walking, so neither manipulation moves your
// odds. This module is the ONE place that ranking lives: the roll
// (openMysteryBox), the reroll (rerollMysteryBox) and the disclosure
// (getRaceProgress's dropOdds) all call it, over the SAME source — the
// PERSISTED participant rows — so the quoted odds and the actual roll cannot
// drift. A structural guard (test/services/teamOnlyCtxStructuralGuard.test.js)
// fails if a fourth site starts sorting totals for itself.
//
// What this is NOT: it does not touch scoring. Settlement, payouts, placements
// and the leaderboard all keep reading `totalSteps`; only the odds TIER moves.
// Nor does it feed `buildRollContext`'s step inputs — `isStepLeader` /
// `isStepLast` stay on `totalSteps` so the RED_CARD / SECOND_WIND drop
// exclusions keep matching their use-time checks.

// The persisted total for a row, mirroring getRaceProgress's `totalFor`:
// finished rows are FROZEN at their finish total.
function totalFor(p) {
  return p.finishedAt ? (p.finishTotalSteps ?? p.totalSteps ?? 0) : (p.totalSteps ?? 0);
}

// The persisted RAW total for a row. Mirrors `totalFor` for frozen rows: a
// finished/forfeited participant keeps whatever `raw_steps` was last persisted
// and is never advanced again (no writer touches a frozen row).
function rawOf(p) {
  const raw = p.rawSteps;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

// Monotonic persist rule (analyst S1). Re-syncs can REWRITE step_samples
// downward; the odds position must not drift backwards when they do, so
// `raw_steps` is a high-water mark. Deliberately NOT the deprecated
// `max_box_progress_steps` column, whose values are stale and unread.
function nextRawSteps(existing, computed) {
  const previous =
    typeof existing === "number" && Number.isFinite(existing) ? existing : 0;
  const next = typeof computed === "number" && Number.isFinite(computed) ? computed : 0;
  return Math.max(0, Math.round(Math.max(previous, next)));
}

// Whether this RACE ranks on raw steps at all.
//
// ALL-OR-NOTHING PER RACE, never per row (analyst R1). If ANY accepted
// participant is still NULL — a mid-race joiner, a partially failed persist, or
// simply a race nobody has resolved since the deploy — the WHOLE race falls
// back to `totalSteps`. A per-row mix would rank a healed player's raw steps
// against an unhealed player's boosted total and hand out unearned trailing
// odds, which is the very exploit this exists to close.
function raceRanksOnRawSteps(accepted) {
  return accepted.length > 0 && accepted.every((p) => rawOf(p) !== null);
}

// The odds position for `userId`.
//
//   participants  PERSISTED participant rows (findAcceptedByRace, or the race's
//                 own `participants` relation). Never live-replay or snapshot
//                 values: those can lead the persisted column by a replay cycle
//                 and make the quoted odds disagree with the actual roll in
//                 exactly the manipulated case.
//   race          for `isTeamRace` (team races collapse to 1-of-2 / 2-of-2).
//
// Returns { position, totalParticipants, usedRawSteps, myTeamValid }.
// `position` is 0 when the user is not among the accepted rows, which is the
// pre-existing behaviour of the three sites this replaced.
function rawPositionFor({ participants, race, userId }) {
  const accepted = (Array.isArray(participants) ? participants : []).filter(
    (p) => p && (p.status === undefined || p.status === "ACCEPTED")
  );
  const usedRawSteps = raceRanksOnRawSteps(accepted);
  const stepsOf = (p) => (usedRawSteps ? rawOf(p) || 0 : totalFor(p));

  if (race && race.isTeamRace) {
    const teamTotals = { TEAM_A: 0, TEAM_B: 0 };
    for (const p of accepted) {
      if (p.team === "TEAM_A") teamTotals.TEAM_A += stepsOf(p);
      else if (p.team === "TEAM_B") teamTotals.TEAM_B += stepsOf(p);
    }
    const myTeam = accepted.find((p) => p.userId === userId)?.team ?? null;
    const otherTeam = myTeam === "TEAM_A" ? "TEAM_B" : "TEAM_A";
    return {
      // A tie counts BOTH teams as leading (unchanged).
      position: teamTotals[myTeam] < teamTotals[otherTeam] ? 2 : 1,
      totalParticipants: 2,
      usedRawSteps,
      myTeamValid: myTeam === "TEAM_A" || myTeam === "TEAM_B",
    };
  }

  const sorted = [...accepted].sort((a, b) => stepsOf(b) - stepsOf(a));
  return {
    position: sorted.findIndex((p) => p.userId === userId) + 1,
    totalParticipants: sorted.length,
    usedRawSteps,
    myTeamValid: true,
  };
}

module.exports = { rawPositionFor, nextRawSteps, rawOf, totalFor };
