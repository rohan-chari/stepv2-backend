const { prisma } = require("../../../db");
const { RaceParticipant } = require("../../races/models/raceParticipant");
const { RacePowerupEvent } = require("../models/racePowerupEvent");
const { Race } = require("../../races/models/race");
const {
  rollPowerup: rollPowerupOdds,
  buildRollContext,
  canonicalRarityFor,
} = require("../powerupOdds");
const { rawPositionFor } = require("../rawPosition");
const {
  balanceConfig: defaultBalanceConfig,
} = require("../../economy/balanceConfig");
const { POWERUP_NAMES, DEFAULT_POWERUP_SLOTS } = require("./rollPowerup");
const {
  BOX_REROLL_REWARD_KIND,
  adsBoxRerollEnabled,
} = require("../../economy/adRewards");
const {
  isValidLocalDate,
  withinOneDayOfServer,
  adjacentDates,
  localDateFor,
  resolveNullRoll,
} = require("./rerollMysteryBox");

// Batch 2026-08-10b item 1 — REROLL ALL after OPEN ALL.
//
// ONE rewarded-ad watch re-rolls EVERY eligible box from an "Open All" batch.
// All-or-nothing by user decision: the player cannot cherry-pick which rolls to
// keep, which is what makes batching per-BOX worse than the existing single
// reroll (game-analyst: per-ad value rises 1.37-2.19x, per-box value FALLS
// 32-57%) and is why no repricing was needed.
//
// A separate command from rerollMysteryBox rather than a loop over it: the
// batch consumes exactly ONE grant for N rolls, must sweep eligibility BEFORE
// touching that grant, and must derive position/roll-context ONCE for the whole
// batch. Everything that IS shared (the date guards, the null-roll resolver) is
// imported from the single command, never copied.

// A per-request WORK bound, not a balance one (game-analyst: REQUIRED, and
// explicitly NOT openMysteryBoxBatch's DEFAULT_MAX_COUNT of 20). The physical
// inventory ceiling is 5 (3 base slots + max observed powerup_slots 4 + 1
// queued), so 8 is unreachable in practice; it exists so a crafted request
// cannot ask a single-vCPU box for an unbounded number of rolls. Applied AFTER
// de-duplication.
const REROLL_BATCH_MAX_COUNT = 8;

// Hard bound on the RAW input list, enforced before the id set ever reaches the
// database. Distinct from REROLL_BATCH_MAX_COUNT, which bounds how many boxes
// actually reroll: without this, `ids` is unbounded at the `findMany({ id: { in
// ids } })` below, so an authenticated participant could POST 10,000 ids and
// buy a 10k-element IN on the one-vCPU box for free — no ad required, since the
// 409 lands afterwards. 100 is far above any legitimate client (the physical
// inventory ceiling is 5) and far below anything that costs real work.
const MAX_REQUEST_IDS = 100;

class PowerupRerollBatchError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = "PowerupRerollBatchError";
    if (statusCode) this.statusCode = statusCode;
    if (code) this.code = code;
  }
}

// Why a row could not be rerolled. Mirrors the single command's guards.
//   NOT_HELD          status != HELD, used, null rarity (stash-redeemed), or
//                     upgraded — all three answer NOT_HELD there too.
//   ALREADY_REROLLED  rerolledAt already stamped, or the persist CAS was lost
//                     to a concurrent duplicate request.
//   OVER_CAP          past REROLL_BATCH_MAX_COUNT.
// NOT_FOUND is deliberately NOT emitted: an unknown id is indistinguishable
// from ANOTHER USER'S id, and the contract requires foreign ids to be omitted
// entirely rather than echoed (never confirm another user's powerup exists).
// Both are therefore simply absent from `results`, which the client already
// tolerates — it leaves any reel whose id is missing on its original result.
function classify(row) {
  if (row.status !== "HELD" || row.usedAt) return "NOT_HELD";
  if (!row.rarity) return "NOT_HELD";
  if ((row.upgradeLevel || 0) > 0) return "NOT_HELD";
  if (row.rerolledAt) return "ALREADY_REROLLED";
  return null;
}

function buildRerollMysteryBoxBatch(dependencies = {}) {
  const db = dependencies.prisma || prisma;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const eventModel = dependencies.RacePowerupEvent || RacePowerupEvent;
  const raceModel = dependencies.Race || Race;
  const rollFn = dependencies.rollPowerupOdds || rollPowerupOdds;
  const balance = dependencies.balanceConfig || defaultBalanceConfig;
  const isEnabled = dependencies.adsBoxRerollEnabled || adsBoxRerollEnabled;

  return async function rerollMysteryBoxBatch({
    userId,
    raceId,
    powerupIds,
    displayName,
    timeZone,
    localDate,
    supportsPowerups5 = false,
  }) {
    // (a) Kill switch, read at CALL time. One switch governs both reroll
    // endpoints, so turning it off removes the button AND 503s the call.
    if (!isEnabled()) {
      throw new PowerupRerollBatchError("Box reroll is disabled", 503, "DISABLED");
    }

    // (b) Input.
    if (!Array.isArray(powerupIds) || powerupIds.length === 0) {
      throw new PowerupRerollBatchError(
        "powerupIds must be a non-empty array",
        400
      );
    }
    if (powerupIds.length > MAX_REQUEST_IDS) {
      throw new PowerupRerollBatchError(
        `powerupIds must contain at most ${MAX_REQUEST_IDS} ids`,
        400
      );
    }
    // De-duplicate: a client that lists the same id twice must not spend half
    // the batch on it. The REROLL_BATCH_MAX_COUNT cap is NOT applied here — see
    // the eligibility sweep below, which applies it to ELIGIBLE rows.
    const ids = [...new Set(powerupIds.filter((id) => typeof id === "string" && id))];
    if (ids.length === 0) {
      throw new PowerupRerollBatchError(
        "powerupIds must be a non-empty array",
        400
      );
    }

    // (c) localDate — identical validation and semantics to the single reroll,
    // using ITS implementation. Optional; absent means "derive from the stored
    // zone". An out-of-range date is a 400, never a silent fallback, so a client
    // can't quietly reach a stale date's grants.
    let effectiveDate;
    if (localDate === undefined || localDate === null) {
      effectiveDate = localDateFor(timeZone);
    } else if (!isValidLocalDate(localDate)) {
      throw new PowerupRerollBatchError(
        "Invalid localDate (expected YYYY-MM-DD)",
        400,
        "INVALID_LOCAL_DATE"
      );
    } else if (!withinOneDayOfServer(localDate)) {
      throw new PowerupRerollBatchError(
        "localDate is too far from server time",
        400,
        "INVALID_LOCAL_DATE"
      );
    } else {
      effectiveDate = localDate;
    }

    // (d) Race + participation.
    const race = await raceModel.findById(raceId);
    if (!race || race.status !== "ACTIVE") {
      throw new PowerupRerollBatchError("Race is not active", 400);
    }
    const participant = await participantModel.findByRaceAndUser(raceId, userId);
    if (!participant) {
      throw new PowerupRerollBatchError("You are not in this race", 403);
    }

    // (e) Eligibility sweep. ONE query for every id rather than N findById
    // calls: the row count is bounded by what the caller owns, and the
    // userId/raceId predicate is what makes a foreign id come back as "not
    // mine" without a second lookup that would confirm it exists.
    const rows = await db.racePowerup.findMany({
      where: { id: { in: ids }, userId, raceId },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));

    // Results are built in REQUEST order so the client can map result -> reel
    // positionally as well as by id.
    const results = [];
    const eligible = [];
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) continue; // foreign or unknown -> omitted entirely
      const skipped = classify(row);
      const entry = {
        powerupId: id,
        type: row.type,
        rarity: row.rarity,
        rerolled: false,
      };
      if (skipped) {
        entry.skipped = skipped;
      } else if (eligible.length >= REROLL_BATCH_MAX_COUNT) {
        // The cap counts ELIGIBLE rows, not request positions. Capping the raw
        // id list instead would let N ineligible ids listed first push the only
        // rerollable box past the cap — turning a valid batch into a 409
        // NOTHING_TO_REROLL. Unreachable today (the inventory ceiling is 5) but
        // a divergence from the stated contract, which promises "the first N
        // ELIGIBLE ids reroll".
        entry.skipped = "OVER_CAP";
      } else {
        eligible.push({ row, entry });
      }
      results.push(entry);
    }

    // (f) Nothing to do -> the ad watch is NOT burned. This check runs BEFORE
    // the grant is touched, mirroring the single command's ordering.
    if (eligible.length === 0) {
      throw new PowerupRerollBatchError(
        "None of those boxes can be rerolled",
        409,
        "NOTHING_TO_REROLL"
      );
    }

    // (g) Consume exactly ONE grant for the whole batch — the deliberate
    // economic change (N boxes per watch instead of 1). Same find + CAS the
    // single command uses, including the +/-1 day lookup that keeps a watch
    // taken just before local midnight spendable.
    const grant = await db.adRewardGrant.findFirst({
      where: {
        userId,
        rewardKind: BOX_REROLL_REWARD_KIND,
        grantedDate: { in: adjacentDates(effectiveDate) },
        consumedAt: null,
      },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (!grant) {
      throw new PowerupRerollBatchError(
        "No verified ad reward available yet",
        409,
        "AD_NOT_VERIFIED"
      );
    }
    const consumed = await db.adRewardGrant.updateMany({
      where: { id: grant.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (!consumed || consumed.count === 0) {
      throw new PowerupRerollBatchError(
        "No verified ad reward available yet",
        409,
        "AD_NOT_VERIFIED"
      );
    }

    // (h) ONE position, ONE roll context, ONE config snapshot for the whole
    // batch. The rolls are simultaneous from the player's point of view, and
    // re-deriving position per box would let the batch's own writes shift the
    // odds mid-loop. Position comes from RAW walked steps, the same source an
    // open ranks on — a reroll must not be a way around that fix.
    const allParticipants = await participantModel.findAcceptedByRace(raceId);
    const { position, totalParticipants } = rawPositionFor({
      participants: allParticipants,
      race,
      userId,
    });
    const ctx = buildRollContext({
      stepTotals: allParticipants.map((p) => p.totalSteps || 0),
      myTotalSteps: participant.totalSteps || 0,
      position,
      totalParticipants,
      isTeamRace: race.isTeamRace === true,
      // §4.5 wave-5 compat gate, threaded exactly like /open and the single
      // reroll. Forgetting it would make REROLL ALL a way to land a type this
      // binary can neither render nor use.
      supportsPowerups5,
    });
    const { version: configVersion, config } = await balance.getSnapshot();
    const maxSlots = participant.powerupSlots || DEFAULT_POWERUP_SLOTS;

    // (i) Roll + persist each box.
    let rerolledCount = 0;
    const rerolledTypes = [];
    for (const { entry } of eligible) {
      let rolled = rollFn(position, totalParticipants, Math.random, { ctx, config });
      // Fanny Pack cannot be a reroll result — there is no auto-activate branch
      // here, so it would be an unusable dud. Bounded so a degenerate config
      // can't spin forever.
      for (
        let attempt = 0;
        rolled.type === "FANNY_PACK" &&
        maxSlots > DEFAULT_POWERUP_SLOTS &&
        attempt < 10;
        attempt += 1
      ) {
        rolled = rollFn(position, totalParticipants, Math.random, { ctx, config });
      }
      rolled = resolveNullRoll(rolled, config, ctx);
      // The same canonical-rarity stamp openMysteryBox / rerollMysteryBox apply:
      // the discard payout and the client tint read this value and it must never
      // claim the tier that happened to produce the roll.
      rolled = {
        ...rolled,
        rarity: canonicalRarityFor(rolled.type, rolled.rarity, config, null),
      };

      // Conditional write. A row that loses this CAS to a concurrent duplicate
      // request becomes `skipped: ALREADY_REROLLED` rather than failing the
      // whole batch — and the grant is NOT refunded: it is already consumed and
      // (in the normal case) other boxes did reroll. If EVERY row loses, the
      // response is still 200 with rerolledCount 0; the only way to reach that
      // is the client double-firing, not the user being cheated.
      const claimed = await db.racePowerup.updateMany({
        where: { id: entry.powerupId, status: "HELD", rerolledAt: null },
        data: {
          type: rolled.type,
          rarity: rolled.rarity,
          configVersion,
          rerolledAt: new Date(),
        },
      });
      if (!claimed || claimed.count === 0) {
        entry.skipped = "ALREADY_REROLLED";
        continue;
      }
      entry.type = rolled.type;
      entry.rarity = rolled.rarity;
      entry.rerolled = true;
      rerolledCount += 1;
      rerolledTypes.push(rolled.type);
    }

    // (j) One audit row PER rerolled box, on the SAME hidden event type the
    // single path uses. Inventing a new type would surface it in the visible
    // feed and leak box contents the open path deliberately hides.
    for (const type of rerolledTypes) {
      await eventModel.create({
        raceId,
        actorUserId: userId,
        eventType: "POWERUP_REROLLED",
        powerupType: type,
        description: `${displayName || "A runner"} rerolled a mystery box: ${
          POWERUP_NAMES[type] || type
        }!`,
      });
    }

    // (k) No invalidateRaceProgress: `powerupData.inventory` is built in the
    // per-viewer overlay from a live findSlotPowerups read, not from the shared
    // cached snapshot, so there is nothing stale to drop.
    return { results, rerolledCount };
  };
}

const rerollMysteryBoxBatch = buildRerollMysteryBoxBatch();

module.exports = {
  buildRerollMysteryBoxBatch,
  rerollMysteryBoxBatch,
  PowerupRerollBatchError,
  REROLL_BATCH_MAX_COUNT,
};
