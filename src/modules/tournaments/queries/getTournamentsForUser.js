const { prisma: defaultPrisma } = require("../../../db");
const { Tournament } = require("../models/tournament");
const { RacePowerup } = require("../../powerups/models/racePowerup");
const { RaceActiveEffect } = require("../../powerups/models/raceActiveEffect");
const { characterPresentation } = require("../../cosmetics");
const { serializeTournamentSummary } = require("./serializeTournament");

// Live-matchup placement uses the SAME ordering rule the ordinary active-race
// summaries use (steps desc, then joinedAt, then userId) so a tournament row and
// a race row can never disagree about the viewer's position.
function compareForPlacement(left, right) {
  const stepDiff = (right.totalSteps || 0) - (left.totalSteps || 0);
  if (stepDiff !== 0) return stepDiff;
  const leftJoined = left.joinedAt ? new Date(left.joinedAt).getTime() : 0;
  const rightJoined = right.joinedAt ? new Date(right.joinedAt).getTime() : 0;
  if (leftJoined !== rightJoined) return leftJoined - rightJoined;
  return String(left.userId || "").localeCompare(String(right.userId || ""));
}

const STATUS_ORDER = { ACTIVE: 0, PENDING: 1, COMPLETED: 2 };

// The additive `tournaments` array for GET /races (token clients only). Every
// tournament the viewer is ACCEPTED in (status != CANCELLED) PLUS ones they are
// INVITED to only while still PENDING. Ordered ACTIVE -> PENDING -> COMPLETED,
// newest first within each group, COMPLETED capped at the last 5. Each summary
// carries myCurrentMatchRaceId (the viewer's live matchup, null if none).
function buildGetTournamentsForUser(dependencies = {}) {
  const db = dependencies.prisma || defaultPrisma;
  const tournamentModel = dependencies.Tournament || Tournament;
  const racePowerupModel = dependencies.RacePowerup || RacePowerup;
  const raceActiveEffectModel =
    dependencies.RaceActiveEffect || RaceActiveEffect;

  return async function getTournamentsForUser(
    userId,
    { supportsCharacters = false, releaseChannel = "prod" } = {}
  ) {
    const rows = await tournamentModel.findForUser(userId);
    if (rows.length === 0) return [];

    // GET /races may list several tournaments, but the viewer's identity is
    // invariant across those rows. Resolve it once and attach the same bounded
    // presentation only for clients that explicitly support characters.
    let myIdentity;
    if (supportsCharacters) {
      const viewer = await db.user.findUnique({
        where: { id: userId },
        select: {
          displayName: true,
          equippedAccessories: {
            include: {
              shopItem: {
                select: {
                  id: true,
                  sku: true,
                  name: true,
                  slot: true,
                  assetKey: true,
                  renderMetadata: true,
                  bobble: true,
                  testOnly: true,
                },
              },
            },
          },
        },
      });
      const presentation = characterPresentation(viewer, true, releaseChannel);
      myIdentity = viewer
        ? {
            displayName: viewer.displayName ?? null,
            animal: presentation.animal ?? null,
            // This list has its own intentionally compact contract. Do not
            // leak the full shop-item payload into every tournament row.
            equippedAccessories: (presentation.accessories ?? []).map(
              (accessory) => ({
                slot: accessory.slot ?? null,
                assetId: accessory.assetKey ?? null,
              })
            ),
          }
        : null;
    }

    // Live matchup raceId per ACTIVE tournament for this viewer.
    const activeIds = rows
      .filter((t) => t.status === "ACTIVE")
      .map((t) => t.id);
    const matchByTournament = new Map();
    // §5: the additive `myCurrentMatch` block gives an active tournament row the
    // same inventory/box/placement language an ordinary active race row has.
    const matchDetailByTournament = new Map();
    if (activeIds.length > 0) {
      const matchups = await db.race.findMany({
        where: {
          tournamentId: { in: activeIds },
          status: "ACTIVE",
          participants: { some: { userId, status: "ACCEPTED" } },
        },
        select: {
          id: true,
          tournamentId: true,
          endsAt: true,
          powerupsEnabled: true,
          participants: {
            select: {
              id: true,
              userId: true,
              status: true,
              totalSteps: true,
              joinedAt: true,
            },
          },
        },
      });
      for (const m of matchups) matchByTournament.set(m.tournamentId, m.id);

      // BULK prefetch (§5): exactly TWO extra queries for ALL live matchups,
      // mirroring getRaces.js:98-113. Query count must not grow with the number
      // of brackets the viewer is in.
      const viewerParticipantIds = [];
      const viewerParticipantByRace = new Map();
      for (const m of matchups) {
        const mine = (m.participants || []).find(
          (p) => p.userId === userId && p.status === "ACCEPTED"
        );
        viewerParticipantByRace.set(m.id, mine || null);
        if (mine && m.powerupsEnabled) viewerParticipantIds.push(mine.id);
      }

      const inventoryByParticipant = new Map();
      const detourParticipantIds = new Set();
      if (viewerParticipantIds.length > 0) {
        const canBulk =
          typeof racePowerupModel.findInventoryForParticipants === "function" &&
          typeof raceActiveEffectModel.findActiveByTypeForParticipants ===
            "function";
        if (canBulk) {
          const [inventoryRows, detourRows] = await Promise.all([
            racePowerupModel.findInventoryForParticipants(viewerParticipantIds, [
              "HELD",
              "MYSTERY_BOX",
              "QUEUED",
            ]),
            raceActiveEffectModel.findActiveByTypeForParticipants(
              viewerParticipantIds,
              "DETOUR_SIGN"
            ),
          ]);
          for (const row of inventoryRows || []) {
            let list = inventoryByParticipant.get(row.participantId);
            if (!list) inventoryByParticipant.set(row.participantId, (list = []));
            list.push(row);
          }
          for (const e of detourRows || []) {
            detourParticipantIds.add(e.targetParticipantId);
          }
        }
        // No bulk methods (injected minimal fakes) => empty inventory. The block
        // still serializes, so the row renders empty slots rather than throwing.
      }

      for (const m of matchups) {
        const mine = viewerParticipantByRace.get(m.id);
        const accepted = (m.participants || [])
          .filter((p) => p.status === "ACCEPTED")
          .sort(compareForPlacement);
        const index = accepted.findIndex((p) => p.userId === userId);
        let myPlacement = index >= 0 ? index + 1 : null;
        let myPlacementHidden = false;
        if (mine && m.powerupsEnabled && detourParticipantIds.has(mine.id)) {
          myPlacement = null;
          myPlacementHidden = true;
        }

        const inventory =
          mine && m.powerupsEnabled
            ? inventoryByParticipant.get(mine.id) || []
            : [];
        const slotItems = inventory
          .filter((p) => p.status === "HELD" || p.status === "MYSTERY_BOX")
          .map((p) => ({
            id: p.id,
            type: p.type ?? null,
            rarity: p.rarity ?? null,
            status: p.status,
          }));

        matchDetailByTournament.set(m.tournamentId, {
          raceId: m.id,
          endsAt: m.endsAt ?? null,
          myPlacement,
          myPlacementHidden,
          queuedBoxCount: inventory.filter((p) => p.status === "QUEUED").length,
          mysteryBoxCount: slotItems.filter((p) => p.status === "MYSTERY_BOX")
            .length,
          slotItems,
        });
      }
    }

    const summaries = rows.map((t) => {
      const summary = serializeTournamentSummary(t, userId);
      // Invite context only. These fields are intentionally not part of the
      // shared tournament serializer because frozen public/create/detail
      // response shapes must remain unchanged.
      if (summary.myStatus === "INVITED") {
        summary.createdAt = t.createdAt ?? null;
        summary.creator = t.creator
          ? {
              id: t.creator.id,
              displayName: t.creator.displayName ?? null,
              profilePhotoUrl: t.creator.profilePhotoUrl ?? null,
            }
          : null;
      }
      summary.myCurrentMatchRaceId = matchByTournament.get(t.id) || null;
      // Additive: an older client ignores this object; a newer client talking to
      // an older backend sees it absent and falls back to bracket navigation.
      summary.myCurrentMatch = matchDetailByTournament.get(t.id) || null;
      if (supportsCharacters) summary.myIdentity = myIdentity;
      return summary;
    });

    // Sort: status group, then newest-first within group (startedAt/completedAt
    // fall back to nothing here; findForUser already returns createdAt desc, so
    // a stable sort by status preserves newest-first).
    const byStatus = { ACTIVE: [], PENDING: [], COMPLETED: [] };
    for (const s of summaries) {
      (byStatus[s.status] || (byStatus[s.status] = [])).push(s);
    }
    const completedCapped = (byStatus.COMPLETED || []).slice(0, 5);

    return [
      ...(byStatus.ACTIVE || []),
      ...(byStatus.PENDING || []),
      ...completedCapped,
    ];
  };
}

const getTournamentsForUser = buildGetTournamentsForUser();

module.exports = { buildGetTournamentsForUser, getTournamentsForUser };
