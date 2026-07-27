// Small shared helpers for Team Race Mode (TR-200s+). Pure functions over the
// race row + participants array that every join/accept/switch/start path uses,
// so the "who counts toward a side" rule lives in exactly one place:
// ACCEPTED participants only (INVITED rows never occupy a slot — TR-202/303).

function acceptedTeamCounts(participants = []) {
  const counts = { TEAM_A: 0, TEAM_B: 0 };
  for (const p of participants) {
    if (p.status !== "ACCEPTED") continue;
    if (p.team === "TEAM_A") counts.TEAM_A += 1;
    else if (p.team === "TEAM_B") counts.TEAM_B += 1;
  }
  return counts;
}

// True when `team` is at the race's per-side cap. `excludeUserId` lets a side
// switch not count the mover's own current slot.
function isTeamSideFull(race, team, { excludeUserId = null } = {}) {
  const cap = race.teamSize;
  if (!Number.isInteger(cap)) return false;
  const members = (race.participants || []).filter(
    (p) =>
      p.status === "ACCEPTED" &&
      p.team === team &&
      (excludeUserId === null || p.userId !== excludeUserId)
  );
  return members.length >= cap;
}

// Auto-assign a team-less join/accept to a side (Issue 3a). Picks the side with
// FEWER accepted members; ties go to TEAM_A. If the picked side is at cap it
// falls back to the other; if BOTH sides are full it returns null (caller then
// throws TEAM_FULL). Used so a frozen old client that accepts/joins a team race
// without a `team` succeeds instead of hitting the removed "Pick a team" 400.
function pickAutoAssignTeam(race) {
  const counts = acceptedTeamCounts(race.participants || []);
  const cap = race.teamSize;
  const isFull = (side) =>
    Number.isInteger(cap) && counts[side] >= cap;
  if (isFull("TEAM_A") && isFull("TEAM_B")) return null;
  // Smaller side, tie -> TEAM_A.
  let target = counts.TEAM_A <= counts.TEAM_B ? "TEAM_A" : "TEAM_B";
  if (isFull(target)) target = target === "TEAM_A" ? "TEAM_B" : "TEAM_A";
  return target;
}

// Resolve the caller's client feature tokens into a Set, accepting either the
// middleware's Set or a plain array (unit tests / internal callers).
function toFeatureSet(clientFeatures) {
  if (clientFeatures instanceof Set) return clientFeatures;
  return new Set(clientFeatures || []);
}

const TEAM_RACES_FEATURE = "team_races";

function clientSupportsTeamRaces(clientFeatures) {
  return toFeatureSet(clientFeatures).has(TEAM_RACES_FEATURE);
}

// The canonical team-race H2H block (TR-401), shared by every surface that
// shows a team scoreline: race detail progress, the races list (TR-806), the
// public browser (TR-206) and the Home race card (TR-809). One builder = one
// shape everywhere, so the client parses it identically wherever it appears.
//
// `entries` is [{ participant, totalSteps }] for the ACCEPTED members only.
// Totals are the sum of member effective steps and are ALWAYS honest — callers
// must pass TRUE resolved totals, computed BEFORE any display illusion
// (Stealth "???", Imposter slot swaps) is applied to individual rows
// (TR-656/658). Forfeited members' frozen totals are included (TR-601).
function buildTeamsBlock(race, entries) {
  const sides = {
    TEAM_A: { name: race.teamAName ?? null, totalSteps: 0, memberCount: 0 },
    TEAM_B: { name: race.teamBName ?? null, totalSteps: 0, memberCount: 0 },
  };
  for (const { participant, totalSteps } of entries) {
    const side = sides[participant.team];
    if (!side) continue;
    side.totalSteps += totalSteps || 0;
    side.memberCount += 1;
  }
  return { teamA: sides.TEAM_A, teamB: sides.TEAM_B };
}

// Convenience wrapper for callers holding a plain participant array whose
// stored `totalSteps` is already the value to sum (list/browser/home surfaces
// read the persisted totals rather than recomputing).
function buildTeamsBlockFromParticipants(race, participants = []) {
  const accepted = participants.filter((p) => p.status === "ACCEPTED");
  const block = buildTeamsBlock(
    race,
    accepted.map((participant) => ({
      participant,
      totalSteps: participant.totalSteps || 0,
    }))
  );
  // Item 16 (batch 2026-07-26) — bounded staleness, made VISIBLE.
  //
  // These totals are the cheap PERSISTED ones; race detail recomputes live
  // effect-adjusted totals, so the two legitimately differ until something
  // writes. Recomputing here would re-introduce the N+1 the perf work removed,
  // on the hottest screen, against a single shared vCPU — so instead we publish
  // when the numbers were last written and let the client say "as of N min ago".
  //
  // Additive + NULLABLE: null (nothing written yet, or an older row that
  // predates the column) means the client hides the affordance and renders
  // exactly as it does today. Frozen clients ignore the key entirely.
  let asOf = null;
  for (const p of accepted) {
    const stamp = p.totalsUpdatedAt ? new Date(p.totalsUpdatedAt) : null;
    if (stamp && (!asOf || stamp > asOf)) asOf = stamp;
  }
  block.asOf = asOf ? asOf.toISOString() : null;
  return block;
}

module.exports = {
  acceptedTeamCounts,
  isTeamSideFull,
  pickAutoAssignTeam,
  toFeatureSet,
  TEAM_RACES_FEATURE,
  clientSupportsTeamRaces,
  buildTeamsBlock,
  buildTeamsBlockFromParticipants,
};
