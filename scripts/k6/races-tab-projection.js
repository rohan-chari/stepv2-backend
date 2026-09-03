export const PROJECTION_VERSION = "races-tab-open-projection-v2";

export const REQUIRED_COVERAGE_VARIANTS = Object.freeze([
  "ordinary_classic_active", "ordinary_team_active", "ordinary_pending_owner",
  "ordinary_pending_accepted", "ordinary_invite", "ordinary_completed",
  "pinned_classic", "pinned_team", "pinned_tournament",
  "ordinary_placement_visible", "ordinary_placement_hidden",
  "ordinary_inventory_held_typed", "ordinary_inventory_mystery_box",
  "ordinary_inventory_queued_box", "ordinary_effect_positive",
  "ordinary_effect_negative", "tournament_invite", "tournament_lobby",
  "tournament_between_rounds", "tournament_live_match", "tournament_eliminated",
  "tournament_champion", "tournament_completed_non_champion",
  "tournament_match_placement_visible", "tournament_match_placement_hidden",
  "tournament_match_inventory_held_typed", "tournament_match_inventory_mystery_box",
  "tournament_match_inventory_queued_box",
]);

const NEGATIVE_EFFECTS = Object.freeze([
  "LEG_CRAMP", "WRONG_TURN", "DETOUR_SIGN", "RAINSTORM", "QUICKSAND",
  "SIGNAL_JAMMER", "LEECH", "TRAIL_MINE", "DRILL_SERGEANT", "BOUNTY",
]);

function array(value) { return Array.isArray(value) ? value : []; }
function nullableString(value) { return typeof value === "string" ? value : null; }
function boolean(value) { return value === true; }
function integer(value) { return Number.isInteger(value) ? value : null; }
function timeValue(value) {
  if (value == null) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "invalid" : parsed.toISOString();
}
function placementFor(row) {
  return { value: integer(row?.myPlacement), hidden: boolean(row?.myPlacementHidden),
    displayValue: integer(row?.myDisplayPlacement),
    privacyActive: boolean(row?.placementPrivacyActive) };
}
function teamFor(row) {
  if (row?.isTeamRace !== true) return null;
  return { size: integer(row.teamSize), callerTeam: nullableString(row.myTeam),
    teamA: { name: nullableString(row.teams?.teamA?.name ?? row.teamAName),
      memberCount: integer(row.teams?.teamA?.memberCount),
      totalSteps: integer(row.teams?.teamA?.totalSteps ?? row.teamATotalSteps) },
    teamB: { name: nullableString(row.teams?.teamB?.name ?? row.teamBName),
      memberCount: integer(row.teams?.teamB?.memberCount),
      totalSteps: integer(row.teams?.teamB?.totalSteps ?? row.teamBTotalSteps) },
    totalsAsOf: timeValue(row.teams?.asOf), winnerTeam: nullableString(row.winnerTeam) };
}
function ordinaryRow(row, bucket, index) {
  return { rowKey: `ordinary.${bucket}.${index}`, name: nullableString(row?.name),
    status: nullableString(row?.status),
    creatorDisplayValue: nullableString(row?.creator?.displayName),
    isCreator: boolean(row?.isCreator), participantCount: integer(row?.participantCount),
    myStatus: nullableString(row?.myStatus), maxDurationDays: integer(row?.maxDurationDays),
    kind: row?.isTeamRace === true ? "team" : "classic",
    isFavorite: boolean(row?.isFavorite), favoriteOrder: timeValue(row?.favoritedAt),
    placement: placementFor(row), team: teamFor(row),
    time: { createdAt: timeValue(row?.createdAt), startedAt: timeValue(row?.startedAt),
      endsAt: timeValue(row?.endsAt), scheduledStartAt: timeValue(row?.scheduledStartAt),
      scheduledEndAt: timeValue(row?.scheduledEndAt),
      inviteExpiresAt: timeValue(row?.myInviteExpiresAt) } };
}
function inventoryFor(row, rowKey) {
  const slots = array(row?.slotItems);
  return { rowKey,
    heldTypedItems: slots.filter((item) => item?.status === "HELD").map((item) => ({
      type: nullableString(item.type), rarity: nullableString(item.rarity), status: "HELD" })),
    mysteryBoxCount: Number.isInteger(row?.mysteryBoxCount) ? row.mysteryBoxCount :
      slots.filter((item) => item?.status === "MYSTERY_BOX").length,
    queuedBoxCount: Number.isInteger(row?.queuedBoxCount) ? row.queuedBoxCount : 0 };
}
function effectsFor(row, rowKey) {
  const result = { rowKey, positive: {}, negative: {} };
  for (const effect of array(row?.myActiveEffects)) {
    if (typeof effect?.type !== "string" || effect.status != null && effect.status !== "ACTIVE") continue;
    const bucket = NEGATIVE_EFFECTS.includes(effect.type) ? result.negative : result.positive;
    bucket[effect.type] = (bucket[effect.type] || 0) + 1;
  }
  return result;
}
function tournamentRenderState(row, viewerUserId) {
  if (row?.myStatus === "INVITED") return "invite";
  if (row?.status === "PENDING") return "lobby";
  if (row?.status === "COMPLETED") {
    return viewerUserId && row.championUserId === viewerUserId
      ? "champion" : "completed_non_champion";
  }
  if (row?.myEliminatedInRound != null) return "eliminated";
  if (row?.myCurrentMatchRaceId || row?.myCurrentMatch) return "live_match";
  return "between_rounds";
}
function tournamentBucket(row, viewerUserId) {
  const state = tournamentRenderState(row, viewerUserId);
  if (state === "invite") return "invited";
  if (state === "live_match") return "active";
  if (state === "lobby" || state === "between_rounds") return "pending";
  return "completed";
}
function roundLabel(row) {
  const current = integer(row?.currentRound) ?? 0;
  const total = integer(row?.totalRounds) ?? 0;
  if (current > 0 && current === total) return "Final";
  if (current > 0 && current === total - 1) return "Semifinal";
  return current > 0 ? `Round ${current}` : null;
}
function tournamentRow(row, bucket, index, viewerUserId) {
  return { rowKey: `tournaments.${bucket}.${index}`, name: nullableString(row?.name),
    callerStatus: nullableString(row?.myStatus), status: nullableString(row?.status),
    renderState: tournamentRenderState(row, viewerUserId),
    hasCurrentMatchRaceId: typeof row?.myCurrentMatchRaceId === "string",
    isFavorite: boolean(row?.isFavorite), favoriteOrder: timeValue(row?.favoritedAt),
    bracketSize: integer(row?.bracketSize), acceptedCount: integer(row?.acceptedCount),
    currentRound: integer(row?.currentRound), totalRounds: integer(row?.totalRounds),
    prize: { championPrizeCoins: integer(row?.championPrizeCoins),
      potCoins: integer(row?.potCoins), funded: row?.prizePool?.funded === true,
      coins: integer(row?.prizePool?.coins) },
    callerIdentity: { displayName: nullableString(row?.myIdentity?.displayName),
      animal: nullableString(row?.myIdentity?.animal),
      equippedAccessories: array(row?.myIdentity?.equippedAccessories).map((item) => ({
        slot: nullableString(item?.slot), assetId: nullableString(item?.assetId) })) } };
}

function objectCount(value) {
  return value && typeof value === "object" ? Object.values(value)
    .reduce((total, count) => total + Number(count || 0), 0) : 0;
}

export function observedCoverageVariants(projection = {}) {
  const seen = new Set();
  const ordinary = projection.ordinary || {};
  for (const row of array(ordinary.active)) {
    seen.add(row.kind === "team" ? "ordinary_team_active" : "ordinary_classic_active");
    if (row.isFavorite) seen.add(row.kind === "team" ? "pinned_team" : "pinned_classic");
    if (row.placement?.hidden || row.placement?.privacyActive) seen.add("ordinary_placement_hidden");
    else if (row.placement?.value != null || row.placement?.displayValue != null) {
      seen.add("ordinary_placement_visible");
    }
  }
  for (const row of array(ordinary.pending)) {
    seen.add(row.isCreator ? "ordinary_pending_owner" : "ordinary_pending_accepted");
    if (row.isFavorite) seen.add(row.kind === "team" ? "pinned_team" : "pinned_classic");
  }
  if (array(ordinary.invited).length) seen.add("ordinary_invite");
  if (array(ordinary.completed).length) seen.add("ordinary_completed");
  for (const row of array(projection.ordinaryInventoryByRace)) {
    if (array(row.heldTypedItems).length) seen.add("ordinary_inventory_held_typed");
    if (Number(row.mysteryBoxCount) > 0) seen.add("ordinary_inventory_mystery_box");
    if (Number(row.queuedBoxCount) > 0) seen.add("ordinary_inventory_queued_box");
  }
  for (const row of array(projection.ordinaryEffectsByRace)) {
    if (objectCount(row.positive) > 0) seen.add("ordinary_effect_positive");
    if (objectCount(row.negative) > 0) seen.add("ordinary_effect_negative");
  }
  const stateVariant = { invite: "tournament_invite", lobby: "tournament_lobby",
    between_rounds: "tournament_between_rounds", live_match: "tournament_live_match",
    eliminated: "tournament_eliminated", champion: "tournament_champion",
    completed_non_champion: "tournament_completed_non_champion" };
  for (const rows of Object.values(projection.tournaments || {})) for (const row of array(rows)) {
    if (stateVariant[row.renderState]) seen.add(stateVariant[row.renderState]);
    if (row.isFavorite) seen.add("pinned_tournament");
  }
  for (const row of array(projection.tournamentMatchByTournament)) {
    if (row.placement?.hidden || row.placement?.privacyActive) {
      seen.add("tournament_match_placement_hidden");
    } else if (row.placement?.value != null || row.placement?.displayValue != null) {
      seen.add("tournament_match_placement_visible");
    }
    if (array(row.inventory?.heldTypedItems).length) seen.add("tournament_match_inventory_held_typed");
    if (Number(row.inventory?.mysteryBoxCount) > 0) seen.add("tournament_match_inventory_mystery_box");
    if (Number(row.inventory?.queuedBoxCount) > 0) seen.add("tournament_match_inventory_queued_box");
  }
  return REQUIRED_COVERAGE_VARIANTS.filter((variant) => seen.has(variant));
}
function tournamentMatch(row, rowKey) {
  const match = row?.myCurrentMatch;
  if (!match) return null;
  return { rowKey, roundLabel: roundLabel(row), endsAt: timeValue(match.endsAt),
    placement: placementFor(match), inventory: inventoryFor(match, rowKey) };
}

export function projectRacesTabPayload({ core = {}, discovery = {}, friends = null,
  friendsShouldRequest = false, viewerUserId = null } = {}) {
  const ordinary = { active: [], pending: [], completed: [], invited: [] };
  const ordinaryInventoryByRace = [];
  const ordinaryEffectsByRace = [];
  for (const sourceBucket of ["active", "pending", "completed"]) {
    for (const row of array(core[sourceBucket])) {
      const bucket = sourceBucket === "pending" && row?.myStatus === "INVITED"
        ? "invited" : sourceBucket;
      const projected = ordinaryRow(row, bucket, ordinary[bucket].length);
      ordinary[bucket].push(projected);
      if (sourceBucket === "active") {
        ordinaryInventoryByRace.push(inventoryFor(row, projected.rowKey));
        ordinaryEffectsByRace.push(effectsFor(row, projected.rowKey));
      }
    }
  }
  const tournaments = { invited: [], pending: [], active: [], completed: [] };
  const tournamentMatchByTournament = [];
  for (const row of array(core.tournaments)) {
    if (row?.status === "CANCELLED") continue;
    const bucket = tournamentBucket(row, viewerUserId);
    const projected = tournamentRow(row, bucket, tournaments[bucket].length, viewerUserId);
    tournaments[bucket].push(projected);
    const match = tournamentMatch(row, projected.rowKey);
    if (match) tournamentMatchByTournament.push(match);
  }
  return { expectedProjectionVersion: PROJECTION_VERSION, ordinary,
    ordinaryInventoryByRace, ordinaryEffectsByRace, tournaments,
    tournamentMatchByTournament,
    discovery: { publicRaceCount: integer(discovery?.publicRaceCount) },
    friends: { shouldRequest: friendsShouldRequest === true,
      expectedCount: friendsShouldRequest ? array(friends?.friends).length : 0,
      expectedContract: friendsShouldRequest ? nullableString(friends?.contract) :
        "friends-summary-v1" } };
}

function mismatchReason(path) {
  if (path.startsWith("ordinaryInventoryByRace")) return "ordinary_inventory";
  if (path.startsWith("ordinaryEffectsByRace")) return "ordinary_effect";
  if (path.startsWith("ordinary") && path.includes(".team")) return "team_field";
  if (path.startsWith("ordinary") && (/\.length$|\.rowKey$/).test(path)) return "bucket";
  if (path.startsWith("ordinary")) return "ordinary_field";
  if (path.startsWith("tournamentMatchByTournament") && path.includes(".placement")) {
    return "matchup_placement";
  }
  if (path.startsWith("tournamentMatchByTournament")) return "matchup_inventory";
  if (path.startsWith("tournaments") && path.includes(".renderState")) return "tournament_state";
  if (path.startsWith("tournaments") && path.includes(".callerIdentity")) return "tournament_identity";
  if (path.startsWith("tournaments") && path.includes(".prize")) return "tournament_prize";
  if (path.startsWith("tournaments")) return "tournament_state";
  if (path.startsWith("discovery")) return "discovery_count";
  if (path.startsWith("friends")) return "friends";
  return "unknown";
}

export function compareRacesTabProjection(expected, observed, sampleLimit = 50) {
  const mismatchCounts = {};
  const samples = [];
  let mismatchCount = 0;
  const mismatch = (path, expectedValue, observedValue) => {
    const reason = mismatchReason(path);
    mismatchCounts[reason] = (mismatchCounts[reason] || 0) + 1;
    mismatchCount += 1;
    if (samples.length < sampleLimit) samples.push({ reason, path,
      expectedType: Array.isArray(expectedValue) ? "array" : expectedValue === null
        ? "null" : typeof expectedValue,
      observedType: Array.isArray(observedValue) ? "array" : observedValue === null
        ? "null" : typeof observedValue });
  };
  const visit = (left, right, path = "") => {
    if (Array.isArray(left)) {
      if (!Array.isArray(right)) { mismatch(path, left, right); return; }
      if (left.length !== right.length) mismatch(`${path}.length`, left.length, right.length);
      for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
        visit(left[index], right[index], `${path}.${index}`);
      }
      return;
    }
    if (left && typeof left === "object") {
      if (!right || typeof right !== "object" || Array.isArray(right)) {
        mismatch(path, left, right); return;
      }
      for (const key of Object.keys(left)) visit(left[key], right[key], path ? `${path}.${key}` : key);
      return;
    }
    if (!Object.is(left, right)) mismatch(path, left, right);
  };
  visit(expected, observed);
  return { matches: mismatchCount === 0, mismatchCount, mismatchCounts, samples,
    truncated: mismatchCount > samples.length };
}
