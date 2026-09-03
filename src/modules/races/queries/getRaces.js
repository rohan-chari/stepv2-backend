const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { characterPresentation } = require("../../cosmetics/shopCosmetics");
const { RacePowerup } = require("../../powerups/models/racePowerup");
const { RaceActiveEffect } = require("../../powerups/models/raceActiveEffect");
const {
  buildRaceMoneyView,
  serializePayouts,
} = require("../racePrizePool");
const { buildTeamsBlockFromParticipants } = require("../teamRaces");
const { compareParticipantsForPlacement } = require("../placementOrder");
const {
  collectRaceIllusions,
  isStealthedForViewer,
} = require("../services/raceIllusions");
const { getRaceLeaveAction } = require("../services/raceLeaveAction");
const { buildViewerDisplayPlacementMap } = require("../services/viewerDisplayPlacements");
const defaultRaceListCache = require("../services/raceListCache");
const defaultRaceProgressPageProjection = require("../services/raceProgressPageProjection");
const {
  serializeTeamPayoutStamp,
} = require("../services/teamWinnerReward");

function getActivePlacement(participants, userId) {
  const acceptedParticipants = participants
    .filter((participant) => participant.status === "ACCEPTED")
    .sort(compareParticipantsForPlacement);

  const index = acceptedParticipants.findIndex(
    (participant) => participant.userId === userId
  );
  return index >= 0 ? index + 1 : null;
}

function getFirstPlaceRacer(
  participants,
  viewerUserId,
  leaderUser,
  activeEffects = [],
  powerupsEnabled = false,
  supportsCharacters = false,
  releaseChannel = "prod",
  supportsRemoteAssets = false,
) {
  const leader = participants
    .filter((participant) => participant.status === "ACCEPTED")
    .sort(compareParticipantsForPlacement)[0];
  if (!leader) return null;
  const illusions = powerupsEnabled
    ? collectRaceIllusions(activeEffects, viewerUserId)
    : { stealthedUserIds: new Set(), viewerIsDetoured: false };
  const hidden =
    illusions.viewerIsDetoured ||
    isStealthedForViewer(leader.userId, {
      stealthedUserIds: illusions.stealthedUserIds,
      viewerUserId,
      finished: leader.finishedAt != null,
    });
  return {
    // Unlike the full leaderboard, this object sits in a position that itself
    // means "first". Withholding the id too prevents the client from tinting a
    // masked avatar as "me" and thereby revealing the viewer's hidden rank.
    userId: hidden ? null : leader.userId,
    displayName: hidden ? "???" : (leaderUser?.displayName ?? null),
    ...(hidden
      ? { animal: null, accessories: [] }
      : characterPresentation(
          leaderUser,
          supportsCharacters,
          releaseChannel,
          supportsRemoteAssets
        )),
  };
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
  const supportsRaceLeave = clientFeatures?.has("race_leave") ?? false;
  const supportsDisplayRanks =
    clientFeatures?.has("privacy_safe_display_ranks") ?? false;
  // Batch 2026-08-08 item 4: gates the completed-race podium rows' cosmetics,
  // exactly as getRaceDetails gates its participant rows. Both default to the
  // naked-capy presentation, so a client that declares nothing is unaffected.
  const supportsCharacters = clientFeatures?.has("characters") ?? false;
  const supportsRemoteAssets = clientFeatures?.has("remote_assets") ?? false;
  const releaseChannel = options.releaseChannel || "prod";
  // Lean list fetch (Phase B1): drops participant user/accessory relations the
  // summaries never read. Falls back to findForUser for injected minimal test
  // fakes that only provide the legacy method (capability detection, matching
  // the bulk-or-fallback pattern used across this codebase).
  let races;
  const useRaceListCache =
    options.raceListCacheEnabled === true &&
    typeof Race.findRaceListStableForUser === "function" &&
    typeof Race.findSqlSummariesForUser === "function" &&
    (typeof options.raceListCache?.isEnabled !== "function" ||
      options.raceListCache.isEnabled());
  if (useRaceListCache) {
    const cache = options.raceListCache || defaultRaceListCache;
    const boundedLaunch = options.compactRaceList === true &&
      typeof Race.findBoundedRaceListForUser === "function";
    const stable = await cache.getStableMembership({
      userId,
      variant: options.raceListVariant || "legacy",
      evidenceDimensions: options.cacheEvidenceDimensions,
      load: () => boundedLaunch
        ? Race.findBoundedRaceListForUser(
            userId, options.extraCompletedRaceIds || [])
        : Race.findRaceListStableForUser(
            userId, options.extraCompletedRaceIds || []),
    });
    let sqlResult = null;
    const pageProjection = options.raceProgressPageProjection ||
      defaultRaceProgressPageProjection;
    // This is an internal read-plan optimization, not a compact-response
    // feature: frozen clients need the same legacy JSON but must not force a
    // 10k-row rank on every launch. The projection supplies exactly the same
    // viewer + leader summary the SQL path constructs for these safe races.
    const boundedCandidates = stable.races.filter((race) =>
        race?.status === "ACTIVE" && race.isTeamRace !== true &&
        race.powerupsEnabled !== true && Number(race.buyInAmount || 0) === 0 &&
        Number(race.potCoins || 0) === 0);
    if (boundedCandidates.length > 0 &&
        typeof RaceParticipant.findViewerRowsForRaces === "function") {
      const embeddedViewerRows = boundedCandidates
        .map((race) => race._viewerParticipant).filter(Boolean);
      const viewerRows = embeddedViewerRows.length === boundedCandidates.length
        ? embeddedViewerRows
        : await RaceParticipant.findViewerRowsForRaces(
            userId, boundedCandidates.map((race) => race.id));
      const viewerByRaceId = new Map(viewerRows.map((row) => [row.raceId, row]));
      const pages = await Promise.all(boundedCandidates.map((race) =>
        pageProjection.readRaceProgressPageProjection({
          raceId: race.id, offset: 0, limit: 1, requesterUserId: userId,
          scoringTimeZone: race.timezone || "UTC",
        }).catch(() => null)));
      const projectedByRaceId = new Map();
      boundedCandidates.forEach((race, index) => {
        const page = pages[index];
        if (!page) return;
        const viewer = viewerByRaceId.get(race.id) || null;
        const leader = page.rows[0] || null;
        projectedByRaceId.set(race.id, {
          ...race,
          participants: [viewer, leader && {
            ...leader,
            status: "ACCEPTED",
            id: leader.participantId,
          }].filter((row, position, list) => row &&
            list.findIndex((candidate) => candidate?.id === row.id) === position),
          _listSummary: {
            acceptedCount: page.total,
            rankRoster: [],
            viewerPosition: page.requesterRow?.placement ??
              page.rows.find((row) => row.userId === userId)?.placement ?? null,
            leaderUserId: leader?.userId || null,
            leaderParticipantId: leader?.participantId || null,
            teamA: { memberCount: 0, totalSteps: 0 },
            teamB: { memberCount: 0, totalSteps: 0 },
            teamPayoutRecipientCount: 0,
            completedPayouts: [],
            totalsAsOf: page.asOf,
          },
        });
      });
      if (projectedByRaceId.size > 0) {
        const residualRaces = stable.races.filter((race) =>
          !projectedByRaceId.has(race.id));
        const residual = residualRaces.length
          ? await Race.findSqlSummariesForUser(
              userId,
              options.extraCompletedRaceIds || [],
              { stableRaces: residualRaces, stableSource: stable.source },
            )
          : { ambiguousFinisherOrder: false, races: [] };
        if (residual.ambiguousFinisherOrder !== true) {
          const residualByRaceId = new Map(
            residual.races.map((race) => [race.id, race]),
          );
          sqlResult = {
            ambiguousFinisherOrder: false,
            races: stable.races.map((race) =>
              projectedByRaceId.get(race.id) || residualByRaceId.get(race.id))
              .filter(Boolean),
          };
        }
      }
    }
    if (!sqlResult) {
      sqlResult = await Race.findSqlSummariesForUser(
        userId,
        options.extraCompletedRaceIds || [],
        { stableRaces: stable.races, stableSource: stable.source },
      );
    }
    // The legacy comparator has one anomalous duplicate-finisher case that no
    // total SQL order can reproduce. This is the sole deliberate dual-read
    // fallback; SQL errors are allowed to fail the request and never retry.
    races = sqlResult?.ambiguousFinisherOrder === true
      ? await Race.findSummariesForUser(userId, options.extraCompletedRaceIds || [])
      : sqlResult.races;
  } else if (
    options.sqlSummaryEnabled === true &&
    typeof Race.findSqlSummariesForUser === "function"
  ) {
    const sqlResult = await Race.findSqlSummariesForUser(
      userId,
      options.extraCompletedRaceIds || []
    );
    // The legacy comparator has one anomalous duplicate-finisher case that no
    // total SQL order can reproduce. This is the sole deliberate dual-read
    // fallback; SQL errors are allowed to fail the request and never retry.
    races = sqlResult?.ambiguousFinisherOrder === true
      ? await Race.findSummariesForUser(userId, options.extraCompletedRaceIds || [])
      : sqlResult.races;
  } else {
    races = typeof Race.findSummariesForUser === "function"
      ? await Race.findSummariesForUser(userId, options.extraCompletedRaceIds || [])
      : await Race.findForUser(userId);
  }

  // A race can arrive from both the normal completed page and an injected
  // recovery/payout-offer path. The model layer usually deduplicates those
  // sources, but keep the API boundary defensive so a repeated race ID can
  // never render as two result cards on the client.
  const racesById = new Map();
  for (const race of races) {
    if (race?.id && !racesById.has(race.id)) racesById.set(race.id, race);
  }
  races = [...racesById.values()];

  const active = [];
  const pending = [];
  const completed = [];

  // Races visible to this client (matchup races and — for tokenless clients —
  // team races are excluded from every bucket).
  const supportsBuckets = clientFeatures?.has("seeded_race_buckets") ?? false;
  const visible = races.filter(
    (race) =>
      !race.tournamentId &&
      !(race.isTeamRace && !supportsTeamRaces) &&
      // An older/tokenless binary cannot render a private bucket card. The
      // membership remains durable, but this compatible list simply omits it.
      !(race.seededBucketId && !supportsBuckets)
  );

  const leaderUserIds = visible
    .map(
      (race) =>
        race._listSummary?.leaderUserId || race.participants
          .filter((participant) => participant.status === "ACCEPTED")
          .sort(compareParticipantsForPlacement)[0]?.userId,
    )
    .filter(Boolean);
  const leaderUsers =
    typeof RaceParticipant.findPresentationsByUserIds === "function"
      ? await RaceParticipant.findPresentationsByUserIds(leaderUserIds)
      : [];
  const leaderUserById = new Map(leaderUsers.map((user) => [user.id, user]));

  // Prefetch the viewer's Detour state + slot/queued inventory for ALL relevant
  // participants in TWO bulk queries instead of three per active powerup race
  // (Phase B2/B3). Query count is now independent of the user's active
  // powerup-race count — no DB await runs inside the serialization loop below.
  const viewerParticipantIds = [];
  const effectParticipantIds = [];
  const myParticipantByRace = new Map();
  for (const race of visible) {
    const mine = race.participants.find((p) => p.userId === userId);
    myParticipantByRace.set(race.id, mine || null);
    if (race.status === "ACTIVE" && race.powerupsEnabled && mine) {
      viewerParticipantIds.push(mine.id);
      const rankRoster = race._listSummary?.rankRoster || race.participants;
      for (const participant of rankRoster) {
        if (participant.status == null || participant.status === "ACCEPTED") {
          effectParticipantIds.push(participant.id);
        }
      }
    }
  }

  const detourParticipantIds = new Set();
  // ACTIVE effect rows targeting the viewer, grouped by participant id
  // (createdAt-asc). Feeds BOTH the Detour mask (filter DETOUR_SIGN) and the
  // additive myActiveEffects summary field, derived from ONE bulk query.
  const effectsByParticipant = new Map();
  const effectsByRace = new Map();
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
        ? RaceActiveEffect.findActiveForParticipants(effectParticipantIds)
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
        let raceList = effectsByRace.get(e.raceId);
        if (!raceList) effectsByRace.set(e.raceId, (raceList = []));
        raceList.push(e);
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

  // Batch 2026-08-08 item 4 (podium): the top-3 finishers of each COMPLETED
  // SOLO race, so the results popup can draw a podium without a second
  // round-trip to GET /races/:id.
  //
  // ONE query for every completed race on the list, bounded to 3 rows per race
  // by the model's `placement IN (1,2,3)` predicate — deliberately not a lookup
  // inside the loop below, which is the N+1 shape this file has already been
  // refactored twice to avoid (Phase B1/B2/B3 above).
  //
  // Team races are excluded: they render the winning-team board, not a podium.
  // `findSummariesForUser` is a LEAN fetch that drops the participant->user
  // relation, so the cosmetics come from this query rather than `race.participants`.
  const podiumByRace = new Map();
  const podiumRaceIds = visible
    .filter((race) => race.status === "COMPLETED" && !race.isTeamRace)
    .map((race) => race.id);
  if (podiumRaceIds.length > 0 && typeof RaceParticipant.findPodiumForRaces === "function") {
    for (const row of await RaceParticipant.findPodiumForRaces(podiumRaceIds)) {
      const list = podiumByRace.get(row.raceId) || [];
      list.push({
        userId: row.userId,
        displayName: row.user?.displayName ?? null,
        profilePhotoUrl: row.user?.profilePhotoUrl ?? null,
        // Same helper and same gating as getRaceDetails, so a client parses
        // these rows with the code it already has.
        ...characterPresentation(
          row.user,
          supportsCharacters,
          releaseChannel,
          supportsRemoteAssets
        ),
        totalSteps: Math.max(0, Number(row.totalSteps) || 0),
        placement: row.placement,
        payoutCoins: row.payoutCoins,
      });
      podiumByRace.set(row.raceId, list);
    }
  }

  for (const race of visible) {
    const myParticipant = myParticipantByRace.get(race.id);
    const acceptedCount = race._listSummary?.acceptedCount ??
      race.participants.filter((p) => p.status === "ACCEPTED").length;
    // Legacy buy-in pot OR app-funded prize pool (race.fundedPrize decides).
    const money = buildRaceMoneyView({
      race,
      acceptedCount,
      teamPayoutRecipientCount:
        race._listSummary?.teamPayoutRecipientCount ?? null,
      completedTeamPayouts:
        race._listSummary?.completedPayouts ?? null,
    });
    const { payouts: legacyPayouts, payoutTiers } = serializePayouts(money.payouts);
    let myPlacement =
      race.status === "COMPLETED"
        ? myParticipant?.placement ?? null
        : race.status === "ACTIVE"
          ? race._listSummary?.viewerPosition ??
            getActivePlacement(race.participants, userId)
          : null;
    // Detour Sign hides the viewer's live placement on the race list, matching
    // the race-detail masking in getRaceProgress (status-ACTIVE effect rows,
    // same as there). Compat: old app builds only null-check myPlacement, so
    // they simply render no chip; new builds read the additive
    // myPlacementHidden flag and render "???".
    const powerupContext =
      race.status === "ACTIVE" && race.powerupsEnabled && myParticipant;
    let myPlacementHidden = false;
    let placementPrivacyActive = false;
    let myDisplayPlacement = myPlacement;
    if (powerupContext) {
      const illusions = collectRaceIllusions(
        effectsByRace.get(race.id) || [],
        userId,
      );
      const rankRoster = race._listSummary?.rankRoster || race.participants;
      const maskedUserIds = new Set(
        rankRoster
          .filter((participant) => isStealthedForViewer(participant.userId, {
            stealthedUserIds: illusions.stealthedUserIds,
            viewerUserId: userId,
            finished: participant.finishedAt != null,
          }))
          .map((participant) => participant.userId),
      );
      placementPrivacyActive = illusions.viewerIsDetoured || maskedUserIds.size > 0;
      myDisplayPlacement = illusions.viewerIsDetoured
        ? null
        : (buildViewerDisplayPlacementMap(
            rankRoster
              .filter(
                (participant) =>
                  participant.status == null || participant.status === "ACCEPTED"
              )
              .sort((left, right) =>
                race._listSummary
                  ? Number(left.placement) - Number(right.placement)
                  : compareParticipantsForPlacement(left, right)
              )
              .map((participant, index) => ({
                ...participant,
                placement: index + 1,
              })),
            maskedUserIds,
          ).get(userId) ?? null);
      if (!supportsDisplayRanks && placementPrivacyActive) {
        myPlacement = null;
        myPlacementHidden = true;
      }
    }
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
      // Additive creation-time payout protocol; see getRaceDetails. Keeping it
      // on every list bucket lets a result/edit flow carry the same immutable
      // authority without an extra details request.
      payoutRoundingVersion: race.payoutRoundingVersion ?? 0,
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
      // Additive identity-only summary for the leading portrait on new app
      // builds. It follows the exact persisted ordering used by myPlacement;
      // old clients ignore it and Redis availability cannot affect the shape.
      leader: getFirstPlaceRacer(
        race._listSummary
          ? race.participants.filter(
              (participant) =>
                participant.userId === race._listSummary.leaderUserId
            )
          : race.participants,
        userId,
        leaderUserById.get(
          race._listSummary?.leaderUserId || race.participants
            .filter((participant) => participant.status === "ACCEPTED")
            .sort(compareParticipantsForPlacement)[0]?.userId,
        ),
        effectsByRace.get(race.id) || [],
        race.status === "ACTIVE" && race.powerupsEnabled,
        supportsCharacters,
        releaseChannel,
        supportsRemoteAssets,
      ),
      myStatus: myParticipant?.status || null,
      myPlacement,
      myPlacementHidden,
      ...(supportsDisplayRanks
        ? { myDisplayPlacement, placementPrivacyActive }
        : {}),
      // Caller-specific participant overlay. It is loaded with the existing
      // membership summary query and never enters the stable race fragment.
      isFavorite: myParticipant?.favoritedAt instanceof Date,
      favoritedAt: myParticipant?.favoritedAt ?? null,
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
      scheduledStartAt: race.scheduledStartAt ?? null,
      // Custom race window (spec §5.2): additive ISO instant or null. On a
      // PENDING race this is where the chosen end lives (endsAt is null until
      // start); frozen clients ignore the unknown key.
      scheduledEndAt: race.scheduledEndAt ?? null,
      myInviteExpiresAt: myParticipant?.inviteExpiresAt ?? null,
      creationSource: race.creationSource ?? null,
      startPolicy: race.startPolicy ?? null,
      // ── Team races (TR-806/807) — additive; old clients ignore them and
      // never receive a team race anyway (filtered above).
      isTeamRace: race.isTeamRace === true,
      ...serializeTeamPayoutStamp(race),
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
        ? race._listSummary
          ? {
              teamA: {
                name: race.teamAName ?? null,
                ...race._listSummary.teamA,
              },
              teamB: {
                name: race.teamBName ?? null,
                ...race._listSummary.teamB,
              },
              asOf: race._listSummary.totalsAsOf
                ? new Date(race._listSummary.totalsAsOf).toISOString()
                : null,
            }
          : buildTeamsBlockFromParticipants(race, race.participants)
        : null,
      // Flat convenience totals, kept alongside `teams` for older new-clients
      // that shipped reading these first.
      teamATotalSteps: race.isTeamRace
        ? race._listSummary?.teamA.totalSteps ?? race.participants
            .filter((p) => p.status === "ACCEPTED" && p.team === "TEAM_A")
            .reduce((sum, p) => sum + (p.totalSteps || 0), 0)
        : null,
      teamBTotalSteps: race.isTeamRace
        ? race._listSummary?.teamB.totalSteps ?? race.participants
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

    if (supportsRaceLeave || supportsTeamRaces) {
      summary.leaveAction = getRaceLeaveAction({
        race,
        participant: myParticipant,
        supportsRaceLeave,
        supportsTeamRaces,
      });
    }

    // A forfeited membership is no longer an actionable race for this user.
    // Keep the durable race/participant rows for settlement and history, but
    // omit it from the live races list so a refresh cannot reopen a race whose
    // powerups are already server-rejected.
    if (race.status === "ACTIVE" && !summary.myForfeited) {
      active.push(summary);
    } else if (race.status === "PENDING") {
      pending.push(summary);
    } else if (race.status === "COMPLETED") {
      // Additive podium rows (item 4). Attached ONLY here — a solo completed
      // race — and only when the race actually has settled placements, so the
      // key is simply absent for team races and for anything that finished
      // without placements. Old clients ignore it.
      const podium = podiumByRace.get(race.id);
      if (podium && podium.length > 0) {
        summary.podium = podium;
      }
      completed.push(summary);
    }
  }

  return { active, pending, completed };
}

module.exports = { getRaces };
