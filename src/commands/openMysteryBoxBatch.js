const { RacePowerup } = require("../models/racePowerup");
const { RaceParticipant } = require("../models/raceParticipant");
const { openMysteryBox: defaultOpenMysteryBox } = require("./openMysteryBox");

// "Open All Boxes" (Item 1). Opens the explicit slot boxes the client already
// knows about AND — when includeQueued is set — materializes and opens the
// user's QUEUED overflow boxes (the server owns queued-box identity, so the
// client can't name them). Each roll reuses the single-open command so odds,
// Lucky Horseshoe, Fanny Pack auto-activate, and event emission stay identical.
//
// Guarantees (spec §Item 1):
//   * never opens another user's boxes (ownership re-checked per id),
//   * enforces a server maxCount cap (default/hard-max 20),
//   * idempotent — a re-sent already-opened id returns its existing type/rarity
//     instead of erroring,
//   * returns only the boxes it actually opened + remainingQueuedBoxCount.

const DEFAULT_MAX_COUNT = 20;

class MysteryBoxBatchError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "MysteryBoxBatchError";
    if (statusCode) this.statusCode = statusCode;
  }
}

function buildOpenMysteryBoxBatch(dependencies = {}) {
  const powerupModel = dependencies.RacePowerup || RacePowerup;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const openMysteryBox = dependencies.openMysteryBox || defaultOpenMysteryBox;

  return async function openMysteryBoxBatch({
    userId,
    raceId,
    powerupIds = [],
    includeQueued = false,
    maxCount = DEFAULT_MAX_COUNT,
    displayName,
  }) {
    const requestedMax = Number.isFinite(maxCount) ? maxCount : DEFAULT_MAX_COUNT;
    const cap = Math.max(0, Math.min(requestedMax, DEFAULT_MAX_COUNT));

    const results = [];
    const participant = await participantModel.findByRaceAndUser(raceId, userId);

    // 1) Explicit slot boxes (the client passes the ids it can see).
    const ids = Array.isArray(powerupIds) ? powerupIds : [];
    for (const powerupId of ids) {
      if (results.length >= cap) break;
      const pw = await powerupModel.findById(powerupId);
      // Skip missing / foreign boxes — never open another user's boxes.
      if (!pw || pw.userId !== userId || pw.raceId !== raceId) continue;

      if (pw.status === "MYSTERY_BOX") {
        const r = await openMysteryBox({ userId, raceId, powerupId, displayName });
        results.push({
          powerupId: r.id,
          type: r.type,
          rarity: r.rarity,
          autoActivated: r.autoActivated,
          queued: false,
        });
      } else if (pw.status === "HELD" || pw.status === "USED") {
        // Idempotent: already opened — return its existing type/rarity.
        results.push({
          powerupId: pw.id,
          type: pw.type,
          rarity: pw.rarity,
          autoActivated: false,
          queued: false,
        });
      }
      // QUEUED / EXPIRED / anything else -> skip (clients don't pass these).
    }

    // 2) Queued overflow boxes — materialize + open up to the remaining cap.
    if (includeQueued && participant) {
      const queued = await powerupModel.findQueuedByParticipant(participant.id);
      for (const box of queued) {
        if (results.length >= cap) break;
        // Re-read defensively: an internal sync may have promoted this row to a
        // real slot (MYSTERY_BOX) or it may already be opened.
        const fresh = await powerupModel.findById(box.id);
        if (!fresh || fresh.userId !== userId || fresh.raceId !== raceId) continue;
        if (fresh.status === "QUEUED") {
          await powerupModel.update(box.id, { status: "MYSTERY_BOX" });
        } else if (fresh.status !== "MYSTERY_BOX") {
          continue; // already opened / expired
        }
        const r = await openMysteryBox({
          userId,
          raceId,
          powerupId: box.id,
          displayName,
        });
        results.push({
          powerupId: r.id,
          type: r.type,
          rarity: r.rarity,
          autoActivated: r.autoActivated,
          queued: true,
        });
      }
    }

    const remainingQueuedBoxCount = participant
      ? await powerupModel.countQueuedByParticipant(participant.id)
      : 0;
    const freshParticipant = participant
      ? await participantModel.findByRaceAndUser(raceId, userId)
      : null;
    const powerupSlots =
      freshParticipant?.powerupSlots ?? participant?.powerupSlots ?? 3;

    return { results, remainingQueuedBoxCount, powerupSlots };
  };
}

const openMysteryBoxBatch = buildOpenMysteryBoxBatch();

module.exports = {
  buildOpenMysteryBoxBatch,
  openMysteryBoxBatch,
  MysteryBoxBatchError,
  DEFAULT_MAX_COUNT,
};
