const { Race } = require("../models/race");
const { RacePowerup } = require("../models/racePowerup");
const { RaceActiveEffect } = require("../models/raceActiveEffect");
const { computeRacePayouts } = require("../utils/racePayoutPresets");
const {
  computeFinishRewardPool,
  computeFinishRewardPlaces,
} = require("../constants/raceFinishReward");

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

async function getRaces(userId) {
  const races = await Race.findForUser(userId);

  const active = [];
  const pending = [];
  const completed = [];

  for (const race of races) {
    const myParticipant = race.participants.find((p) => p.userId === userId);
    const acceptedCount = race.participants.filter((p) => p.status === "ACCEPTED").length;
    const heldPotCoins = race.participants.reduce((sum, participant) => {
      if (participant.buyInStatus === "HELD") {
        return sum + (participant.buyInAmount || 0);
      }
      return sum;
    }, 0);
    const projectedPotCoins = (race.potCoins || 0) + heldPotCoins;
    const payouts = computeRacePayouts({
      preset: race.payoutPreset,
      potCoins: projectedPotCoins,
      participantCount: acceptedCount,
    });
    const finishRewardPool = computeFinishRewardPool(race.seedId, acceptedCount);
    const finishRewardPlaces = computeFinishRewardPlaces(
      race.seedId,
      acceptedCount
    );
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
    let myPlacementHidden = false;
    if (race.status === "ACTIVE" && race.powerupsEnabled && myParticipant) {
      const detour = await RaceActiveEffect.findActiveByTypeForParticipant(
        myParticipant.id,
        "DETOUR_SIGN"
      );
      if (detour) {
        myPlacement = null;
        myPlacementHidden = true;
      }
    }
    const queuedBoxCount =
      race.status === "ACTIVE" && race.powerupsEnabled && myParticipant
        ? await RacePowerup.countQueuedByParticipant(myParticipant.id)
        : 0;
    // Slot inventory (HELD powerups + unopened MYSTERY_BOX) so the races list
    // can render each occupied slot precisely — a powerup sprite for HELD, a
    // crate for MYSTERY_BOX — without opening the race. Same item shape as the
    // race-detail `inventory`. Additive field: older app builds ignore
    // `slotItems` and fall back to `mysteryBoxCount`.
    const slotPowerups =
      race.status === "ACTIVE" && race.powerupsEnabled && myParticipant
        ? await RacePowerup.findSlotPowerups(myParticipant.id)
        : [];
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
      buyInAmount: race.buyInAmount,
      payoutPreset: race.payoutPreset,
      potCoins: race.potCoins || 0,
      heldPotCoins,
      projectedPotCoins,
      // Legacy three-place shape for app builds that predate payoutTiers; they
      // show only the podium, which degrades gracefully for field-scaled presets.
      payouts: {
        first: payouts[0] || 0,
        second: payouts[1] || 0,
        third: payouts[2] || 0,
      },
      // Full breakdown (placement 1..N); newer builds render it, older ignore it.
      payoutTiers: payouts.map((amount, index) => ({
        placement: index + 1,
        amount,
      })),
      finishReward:
        finishRewardPool > 0
          ? { pool: finishRewardPool, paidPlaces: finishRewardPlaces }
          : null,
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
    };

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
