const { Race } = require("../models/race");
const { RacePowerup } = require("../../powerups/models/racePowerup");
const { RaceActiveEffect } = require("../../powerups/models/raceActiveEffect");
const {
  buildRaceMoneyView,
  serializePayouts,
} = require("../racePrizePool");
const { buildTeamsBlockFromParticipants } = require("../teamRaces");

function compareParticipantsForPlacement(left, right) {
  if (left.finishedAt && right.finishedAt) {
    const leftPlacement = left.placement ?? Number.MAX_SAFE_INTEGER;
    const rightPlacement = right.placement ?? Number.MAX_SAFE_INTEGER;
    if (leftPlacement !== rightPlacement) {
      return leftPlacement - rightPlacement;
    }

    const leftFinishedAt = new Date(left.finishedAt).getTime();
    const rightFinishedAt = new Date(right.finishedAt).getTime();
    if (leftFinishedAt !== rightFinishedAt) {
      return leftFinishedAt - rightFinishedAt;
    }
  }

  if (left.finishedAt) return -1;
  if (right.finishedAt) return 1;

  const stepDiff = (right.totalSteps || 0) - (left.totalSteps || 0);
  if (stepDiff !== 0) {
    return stepDiff;
  }

  const leftJoinedAt = left.joinedAt ? new Date(left.joinedAt).getTime() : 0;
  const rightJoinedAt = right.joinedAt ? new Date(right.joinedAt).getTime() : 0;
  if (leftJoinedAt !== rightJoinedAt) {
    return leftJoinedAt - rightJoinedAt;
  }

  return String(left.userId || "").localeCompare(String(right.userId || ""));
}

function getActivePlacement(participants, userId) {
  const acceptedParticipants = participants
    .filter((participant) => participant.status === "ACCEPTED")
    .sort(compareParticipantsForPlacement);

  const index = acceptedParticipants.findIndex(
    (participant) => participant.userId === userId
  );
  return index >= 0 ? index + 1 : null;
}

// Wave-5 effect types a non-powerups5 client cannot render — WITHHELD from
// myActiveEffects for such clients (mirror of getRaceProgress.js §4.5). The
// authoritative score is never gated here; the field is a display-only summary.
const POWERUPS5_WITHHELD_TYPES = new Set([
  "GHOST_PEPPER",
  "COIN_FLIP",
  "DECOY",
  "UMBRELLA",
  "PIGGY_BANK",
  "DRILL_SERGEANT",
  "BOUNTY",
]);

// Map ACTIVE effect rows targeting the viewer into the myActiveEffects contract
// (createdAt-asc preserved from the query). Mirrors getRaceProgress.js:611-655's
// X-Client-Features downcast/withhold rules so the list never sends a type the
// binary can't render. HIDDEN_FROM_OPPONENTS filtering is intentionally NOT
// applied: every row already targets the viewer (same as the progress endpoint
// always showing the viewer their own effects).
function serializeMyActiveEffects(rows, features) {
  const supportsPowerups3 = features.powerups3;
  const supportsPowerups4 = features.powerups4;
  const supportsPowerups5 = features.powerups5;
  const out = [];
  for (const e of rows) {
    // §9.3: withhold HITCHHIKE from clients that don't advertise powerups3.
    if (!supportsPowerups3 && e.type === "HITCHHIKE") continue;
    // §4.5: withhold wave-5 types a non-powerups5 client can't render.
    if (!supportsPowerups5 && POWERUPS5_WITHHELD_TYPES.has(e.type)) continue;

    let type = e.type;
    if (type === "QUICKSAND" && !supportsPowerups4) type = "LEG_CRAMP";
    if (!supportsPowerups5) {
      if (type === "POWER_OUTAGE") type = "SIGNAL_JAMMER";
      else if (type === "UPRISING" || type === "RALLY_FLAG") type = "RUNNERS_HIGH";
    }
    out.push({ type, sourceUserId: e.sourceUserId, expiresAt: e.expiresAt });
  }
  return out;
}

// `supportsTeamRaces` (TR-702): whether the requesting client sent the
// `team_races` X-Client-Features token. Old clients (false/omitted) never see a
// team race in any bucket — filtered here BEFORE any counts are derived, so an
// old client's list is simply shorter, never inconsistent.
// `options.clientFeatures`: the request's X-Client-Features Set (from
// req.clientFeatures). Gates ONLY the myActiveEffects display types (powerups3/4/
// 5 downcast/withhold); default = no tokens, which is safe because tokenless
// clients also ignore the additive field entirely.
async function getRaces(userId, supportsTeamRaces = false, options = {}) {
  const clientFeatures = options.clientFeatures || null;
  const features = {
    powerups3: clientFeatures?.has("powerups3") ?? false,
    powerups4: clientFeatures?.has("powerups4") ?? false,
    powerups5: clientFeatures?.has("powerups5") ?? false,
  };
  // Lean list fetch (Phase B1): drops participant user/accessory relations the
  // summaries never read. Falls back to findForUser for injected minimal test
  // fakes that only provide the legacy method (capability detection, matching
  // the bulk-or-fallback pattern used across this codebase).
  const races =
    typeof Race.findSummariesForUser === "function"
      ? await Race.findSummariesForUser(userId)
      : await Race.findForUser(userId);

  const active = [];
  const pending = [];
  const completed = [];

  // Races visible to this client (matchup races and — for tokenless clients —
  // team races are excluded from every bucket).
  const visible = races.filter(
    (race) => !race.tournamentId && !(race.isTeamRace && !supportsTeamRaces)
  );

  // Prefetch the viewer's Detour state + slot/queued inventory for ALL relevant
  // participants in TWO bulk queries instead of three per active powerup race
  // (Phase B2/B3). Query count is now independent of the user's active
  // powerup-race count — no DB await runs inside the serialization loop below.
  const viewerParticipantIds = [];
  const myParticipantByRace = new Map();
  for (const race of visible) {
    const mine = race.participants.find((p) => p.userId === userId);
    myParticipantByRace.set(race.id, mine || null);
    if (race.status === "ACTIVE" && race.powerupsEnabled && mine) {
      viewerParticipantIds.push(mine.id);
    }
  }

  const detourParticipantIds = new Set();
  // ACTIVE effect rows targeting the viewer, grouped by participant id
  // (createdAt-asc). Feeds BOTH the Detour mask (filter DETOUR_SIGN) and the
  // additive myActiveEffects summary field, derived from ONE bulk query.
  const effectsByParticipant = new Map();
  const inventoryByParticipant = new Map();
  // Prefer the all-types bulk effect query (production + full fakes); fall back
  // to the per-type Detour bulk query so the query-count fake that only pins the
  // Detour shape still runs the bulk path (myActiveEffects is empty there).
  const hasBulkAllEffects =
    typeof RaceActiveEffect.findActiveForParticipants === "function";
  const hasBulkDetourEffects =
    typeof RaceActiveEffect.findActiveByTypeForParticipants === "function";
  const canBulk =
    (hasBulkAllEffects || hasBulkDetourEffects) &&
    typeof RacePowerup.findInventoryForParticipants === "function";

  if (viewerParticipantIds.length > 0 && canBulk) {
    // Production path: exactly two queries, independent of race count.
    const [effectRows, inventoryRows] = await Promise.all([
      hasBulkAllEffects
        ? RaceActiveEffect.findActiveForParticipants(viewerParticipantIds)
        : RaceActiveEffect.findActiveByTypeForParticipants(viewerParticipantIds, "DETOUR_SIGN"),
      RacePowerup.findInventoryForParticipants(viewerParticipantIds, [
        "HELD",
        "MYSTERY_BOX",
        "QUEUED",
      ]),
    ]);
    for (const e of effectRows) {
      if (e.type === "DETOUR_SIGN") detourParticipantIds.add(e.targetParticipantId);
      if (hasBulkAllEffects) {
        let list = effectsByParticipant.get(e.targetParticipantId);
        if (!list) effectsByParticipant.set(e.targetParticipantId, (list = []));
        list.push(e);
      }
    }
    for (const row of inventoryRows) {
      let list = inventoryByParticipant.get(row.participantId);
      if (!list) inventoryByParticipant.set(row.participantId, (list = []));
      list.push(row);
    }
  } else if (viewerParticipantIds.length > 0) {
    // Fallback for injected minimal fakes (test-only; production always has the
    // bulk methods): per-participant lookups matching the legacy behavior.
    for (const race of visible) {
      const mine = myParticipantByRace.get(race.id);
      if (!(race.status === "ACTIVE" && race.powerupsEnabled && mine)) continue;
      if (typeof RaceActiveEffect.findActiveForParticipant === "function") {
        // All-types per-participant: derive both the Detour mask and the
        // viewer's effect list from one lookup.
        const rows = await RaceActiveEffect.findActiveForParticipant(mine.id);
        effectsByParticipant.set(mine.id, rows);
        if (rows.some((e) => e.type === "DETOUR_SIGN")) detourParticipantIds.add(mine.id);
      } else if (typeof RaceActiveEffect.findActiveByTypeForParticipant === "function") {
        const detour = await RaceActiveEffect.findActiveByTypeForParticipant(mine.id, "DETOUR_SIGN");
        if (detour) detourParticipantIds.add(mine.id);
      }
      const list = [];
      if (typeof RacePowerup.findSlotPowerups === "function") {
        for (const p of await RacePowerup.findSlotPowerups(mine.id)) list.push(p);
      }
      if (typeof RacePowerup.countQueuedByParticipant === "function") {
        const qc = await RacePowerup.countQueuedByParticipant(mine.id);
        for (let i = 0; i < qc; i++) list.push({ status: "QUEUED" });
      }
      inventoryByParticipant.set(mine.id, list);
    }
  }

  for (const race of visible) {
    const myParticipant = myParticipantByRace.get(race.id);
    const acceptedCount = race.participants.filter((p) => p.status === "ACCEPTED").length;
    // Legacy buy-in pot OR app-funded prize pool (race.fundedPrize decides).
    const money = buildRaceMoneyView({ race, acceptedCount });
    const { payouts: legacyPayouts, payoutTiers } = serializePayouts(money.payouts);
    let myPlacement =
      race.status === "COMPLETED"
        ? myParticipant?.placement ?? null
        : race.status === "ACTIVE"
          ? getActivePlacement(race.participants, userId)
          : null;
    // Detour Sign hides the viewer's live placement on the race list, matching
    // the race-detail masking in getRaceProgress (status-ACTIVE effect rows,
    // same as there). Compat: old app builds only null-check myPlacement, so
    // they simply render no chip; new builds read the additive
    // myPlacementHidden flag and render "???".
    const powerupContext =
      race.status === "ACTIVE" && race.powerupsEnabled && myParticipant;
    let myPlacementHidden = false;
    if (powerupContext && detourParticipantIds.has(myParticipant.id)) {
      // Detour Sign masks the viewer's live placement (bulk-prefetched above).
      myPlacement = null;
      myPlacementHidden = true;
    }
    // Slot inventory (HELD + MYSTERY_BOX) and queued box count, read from the
    // bulk inventory prefetch (no per-race query). The prefetch is createdAt-asc,
    // so grouping preserves findSlotPowerups' order.
    const inventory = powerupContext
      ? inventoryByParticipant.get(myParticipant.id) || []
      : [];
    const queuedBoxCount = inventory.filter((p) => p.status === "QUEUED").length;
    // Slot inventory (HELD powerups + unopened MYSTERY_BOX) so the races list
    // can render each occupied slot precisely — a powerup sprite for HELD, a
    // crate for MYSTERY_BOX — without opening the race. Same item shape as the
    // race-detail `inventory`. Additive field: older app builds ignore
    // `slotItems` and fall back to `mysteryBoxCount`.
    const slotPowerups = inventory.filter(
      (p) => p.status === "HELD" || p.status === "MYSTERY_BOX"
    );
    const slotItems = slotPowerups.map((p) => ({
      id: p.id,
      type: p.type,
      rarity: p.rarity,
      status: p.status,
    }));
    // Held/openable mystery boxes (0..powerupSlots) so the races list can show
    // how many boxes the user has waiting without opening the race. Additive
    // field: older app builds ignore it.
    const mysteryBoxCount = slotItems.filter(
      (p) => p.status === "MYSTERY_BOX",
    ).length;

    const summary = {
      id: race.id,
      name: race.name,
      status: race.status,
      maxDurationDays: race.maxDurationDays,
      targetSteps: race.targetSteps, // 1.1.4 compat
      buyInAmount: money.buyInAmount,
      payoutPreset: race.payoutPreset,
      potCoins: money.potCoins,
      heldPotCoins: money.heldPotCoins,
      projectedPotCoins: money.projectedPotCoins,
      // App-funded prize pool (additive); null for a legacy buy-in race.
      prizePool: money.prizePool,
      // Legacy three-place shape for app builds that predate payoutTiers; they
      // show only the podium, which degrades gracefully for field-scaled presets.
      payouts: legacyPayouts,
      // Full breakdown (placement 1..N); newer builds render it, older ignore it.
      payoutTiers,
      finishReward: money.finishReward,
      startedAt: race.startedAt,
      endsAt: race.endsAt,
      completedAt: race.completedAt,
      creator: race.creator,
      winner: race.winner,
      participantCount: acceptedCount,
      myStatus: myParticipant?.status || null,
      myPlacement,
      myPlacementHidden,
      myBuyInStatus: myParticipant?.buyInStatus || "NONE",
      myPayoutCoins: myParticipant?.payoutCoins || 0,
      myResultsSeen: (myParticipant?.resultsSeenAt != null),
      queuedBoxCount,
      mysteryBoxCount,
      slotItems,
      isCreator: race.creatorId === userId,
      isPublic: race.isPublic || false,
      // null => unlimited (no cap). Serialized as null; older app clients read
      // this defensively (int? ?? 10) so they show a finite figure but never crash.
      maxParticipants: race.maxParticipants ?? null,
      createdAt: race.createdAt,
      // ── Team races (TR-806/807) — additive; old clients ignore them and
      // never receive a team race anyway (filtered above).
      isTeamRace: race.isTeamRace === true,
      teamSize: race.teamSize ?? null,
      teamAName: race.teamAName ?? null,
      teamBName: race.teamBName ?? null,
      winnerTeam: race.winnerTeam ?? null,
      // The viewer's own side + forfeit state. Required by the results modal
      // (TR-807): placements alone are 1-vs-2 for whole teams, so without
      // myTeam a win is indistinguishable from a loss, and the review prompt
      // must exclude forfeiters and ties (strictly winnerTeam === myTeam).
      myTeam: myParticipant?.team ?? null,
      myForfeited: myParticipant?.forfeitedAt != null,
      // Canonical H2H block (same shape as GET /races/:raceId/progress) so the
      // list row can draw the mini scoreline without an N+1 fetch. Null on
      // individual races.
      teams: race.isTeamRace
        ? buildTeamsBlockFromParticipants(race, race.participants)
        : null,
      // Flat convenience totals, kept alongside `teams` for older new-clients
      // that shipped reading these first.
      teamATotalSteps: race.isTeamRace
        ? race.participants
            .filter((p) => p.status === "ACCEPTED" && p.team === "TEAM_A")
            .reduce((sum, p) => sum + (p.totalSteps || 0), 0)
        : null,
      teamBTotalSteps: race.isTeamRace
        ? race.participants
            .filter((p) => p.status === "ACCEPTED" && p.team === "TEAM_B")
            .reduce((sum, p) => sum + (p.totalSteps || 0), 0)
        : null,
    };

    // Additive myActiveEffects (races-tab effect badges): effects currently
    // targeting the viewer in this race, createdAt-asc, feature-gated. Present
    // ONLY inside powerupContext (ACTIVE + powerupsEnabled + viewer participates)
    // — omitted entirely otherwise, matching slotItems' semantics so snapshot
    // clients never see a shape change on non-powerup rows.
    if (powerupContext) {
      summary.myActiveEffects = serializeMyActiveEffects(
        effectsByParticipant.get(myParticipant.id) || [],
        features
      );
    }

    if (race.status === "ACTIVE") {
      active.push(summary);
    } else if (race.status === "PENDING") {
      pending.push(summary);
    } else if (race.status === "COMPLETED") {
      completed.push(summary);
    }
  }

  return { active, pending, completed };
}

module.exports = { getRaces };
