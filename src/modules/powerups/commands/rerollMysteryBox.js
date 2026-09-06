const {
  prisma,
  runInPrismaTransaction,
} = require("../../../db");
const { RacePowerup } = require("../models/racePowerup");
const { RaceParticipant } = require("../../races/models/raceParticipant");
const { RacePowerupEvent } = require("../models/racePowerupEvent");
const { Race } = require("../../races/models/race");
const {
  rollPowerup: rollPowerupOdds,
  RARITY_ORDER,
  buildRollContext,
  pickTypeForRarity,
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
const { acquireRaceWriteFence } = require("../../races/services/raceWriteFence");

// Batch 2026-08-08 item 11 — rewarded-ad mystery-box reroll.
//
// After a box has revealed its powerup the player may watch ONE rewarded ad to
// re-roll that SAME RacePowerup row, once. The new roll may be worse; it is
// final. Deliberately a separate command from openMysteryBox rather than a flag
// on it: the two differ in every guard (status, rarity, upgradeLevel,
// rerolledAt, the ad grant) and share only the roll itself, which already lives
// in powerupOdds.
class PowerupRerollError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = "PowerupRerollError";
    if (statusCode) this.statusCode = statusCode;
    if (code) this.code = code;
  }
}

const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Same rule the daily-reward claims apply to a client-supplied localDate
// (claimDailyReward.js): the date must be real, and within ~a day of server
// time so a client cannot reach back and spend an arbitrary old date's grants.
function isValidLocalDate(str) {
  if (typeof str !== "string" || !LOCAL_DATE_RE.test(str)) return false;
  const [y, m, d] = str.split("-").map((n) => parseInt(n, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
  );
}

function withinOneDayOfServer(localDate) {
  const serverToday = new Date().toISOString().slice(0, 10);
  const diffDays =
    Math.abs(new Date(localDate) - new Date(serverToday)) / (1000 * 60 * 60 * 24);
  return diffDays <= 1.5;
}

// The dates a reroll credit may legitimately carry: the caller's local date and
// its two neighbours.
//
// The grant is stamped with the DEVICE's local date at ad-watch time, while the
// spend arrives as a separate request that can land on the other side of local
// midnight (and the device clock can disagree with the server anyway). Matching
// one exact date would strand those credits permanently — the user watched the
// ad and can never spend it. The unconsumed-grant + CAS consume still make
// double-spending impossible, so widening the LOOKUP costs nothing.
function adjacentDates(localDate) {
  const base = new Date(`${localDate}T00:00:00.000Z`).getTime();
  return [-1, 0, 1].map((offset) =>
    new Date(base + offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  );
}

// The user's local calendar date. NOT the server's UTC date: the SSV callback
// stamps `grantedDate` from the DEVICE's local date (custom_data
// "box_reroll:<userId>:<localDate>"), so matching on the UTC date would fail
// every evening for every user west of UTC — the credit would exist and be
// unspendable.
function localDateFor(timeZone, now = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  }
}

// §5.5 mirror of openMysteryBox.resolveNullRoll: a reroll must never persist a
// null type either.
function resolveNullRoll(rolled, config, ctx) {
  if (rolled && rolled.type) return rolled;
  const index = RARITY_ORDER.indexOf(rolled?.rarity);
  if (index > 0) {
    const lower = RARITY_ORDER[index - 1];
    const type = pickTypeForRarity(lower, Math.random, config, ctx);
    if (type) return { type, rarity: lower };
  }
  return {
    type: "PROTEIN_SHAKE",
    rarity: config?.rarityByType?.PROTEIN_SHAKE || "COMMON",
  };
}

function buildRerollMysteryBox(dependencies = {}) {
  const db = dependencies.prisma || prisma;
  const powerupModel = dependencies.RacePowerup || RacePowerup;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const eventModel = dependencies.RacePowerupEvent || RacePowerupEvent;
  const raceModel = dependencies.Race || Race;
  const rollFn = dependencies.rollPowerupOdds || rollPowerupOdds;
  const balance = dependencies.balanceConfig || defaultBalanceConfig;
  const isEnabled = dependencies.adsBoxRerollEnabled || adsBoxRerollEnabled;
  const runTransaction = dependencies.runInPrismaTransaction ||
    (dependencies.prisma?.$transaction
      ? (work) => dependencies.prisma.$transaction(work)
      : Object.keys(dependencies).length > 0
        ? (work) => work(db)
        : runInPrismaTransaction);
  const acquireWriteFence = dependencies.acquireRaceWriteFence ||
    (Object.keys(dependencies).length > 0 && !dependencies.prisma
      ? async () => null
      : acquireRaceWriteFence);

  return async function rerollMysteryBox({
    userId,
    raceId,
    powerupId,
    displayName,
    timeZone,
    localDate,
    supportsPowerups5 = false,
  }) {
    // Kill switch, read at CALL time. 503 mirrors /daily-reward/claim-extra-box.
    if (!isEnabled()) {
      throw new PowerupRerollError("Box reroll is disabled", 503, "DISABLED");
    }

    return runTransaction(async (tx) => {
    // C0 is the first persistence lock. The participant, powerup and verified
    // grant are then locked in canonical order; every mutation below commits or
    // rolls back with the hidden audit event.
    await acquireWriteFence(tx, raceId);
    if (typeof tx?.$queryRawUnsafe === "function") {
      await tx.$queryRawUnsafe("SELECT id FROM races WHERE id = $1 FOR UPDATE", raceId);
      await tx.$queryRawUnsafe(
        "SELECT id FROM race_participants WHERE race_id = $1 AND user_id = $2 FOR UPDATE",
        raceId,
        userId,
      );
      await tx.$queryRawUnsafe(
        "SELECT id FROM race_powerups WHERE id = $1 FOR UPDATE",
        powerupId,
      );
    }

    // ── Ownership + eligibility. ALL of it runs before the ad credit is
    // consumed, so an ineligible powerup never burns the watch.
    const powerup = await powerupModel.findById(powerupId);
    if (!powerup) {
      throw new PowerupRerollError("Powerup not found", 404);
    }
    if (powerup.userId !== userId || powerup.raceId !== raceId) {
      throw new PowerupRerollError("This powerup does not belong to you", 403);
    }

    const race = await raceModel.findById(raceId);
    if (!race || race.status !== "ACTIVE") {
      throw new PowerupRerollError("Race is not active", 400);
    }

    const participant = await participantModel.findByRaceAndUser(raceId, userId);
    if (!participant) {
      throw new PowerupRerollError("You are not in this race", 403);
    }

    // Only a revealed, unspent, un-upgraded box result can be rerolled.
    //   * status must be HELD — MYSTERY_BOX is unopened (open it, don't reroll
    //     it) and USED/DISCARDED/EXPIRED are spent.
    //   * rarity != null — stash-redeemed powerups (redeemPowerupToRace) carry a
    //     null rarity; they never came from a box, so there is no roll to redo.
    //   * upgradeLevel === 0 — otherwise a player upgrades a cheap type and
    //     rerolls into an expensive one while keeping the paid tiers.
    // All three answer 400 NOT_HELD: the locked client contract has exactly one
    // "this powerup isn't rerollable" code, and the message carries the detail.
    if (powerup.status !== "HELD" || powerup.usedAt) {
      throw new PowerupRerollError(
        "Only a held, unused powerup can be rerolled",
        400,
        "NOT_HELD"
      );
    }
    if (!powerup.rarity) {
      throw new PowerupRerollError(
        "This powerup did not come from a mystery box",
        400,
        "NOT_HELD"
      );
    }
    if ((powerup.upgradeLevel || 0) > 0) {
      throw new PowerupRerollError(
        "An upgraded powerup cannot be rerolled",
        400,
        "NOT_HELD"
      );
    }
    if (powerup.rerolledAt) {
      throw new PowerupRerollError(
        "This powerup has already been rerolled",
        409,
        "ALREADY_REROLLED"
      );
    }

    // ── Consume ONE verified watch. The grant is "1 reroll credit" — it is not
    // bound to a particular box at mint time; binding happens here.
    // `localDate` is OPTIONAL — the locked client contract sends no body, and
    // those callers get the server's view of the user's local date. When a
    // client DOES send one (it sends the same date it baked into the ad's
    // custom_data), it is validated exactly like the daily-reward claims: a real
    // date, close to server time. An out-of-range date is a 400 rather than a
    // silent fallback, so a client can never quietly reach a stale date's grants.
    let effectiveDate;
    if (localDate === undefined || localDate === null) {
      effectiveDate = localDateFor(timeZone);
    } else if (!isValidLocalDate(localDate)) {
      throw new PowerupRerollError(
        "Invalid localDate (expected YYYY-MM-DD)",
        400,
        "INVALID_LOCAL_DATE"
      );
    } else if (!withinOneDayOfServer(localDate)) {
      throw new PowerupRerollError(
        "localDate is too far from server time",
        400,
        "INVALID_LOCAL_DATE"
      );
    } else {
      effectiveDate = localDate;
    }

    const grant = await tx.adRewardGrant.findFirst({
      where: {
        userId,
        rewardKind: BOX_REROLL_REWARD_KIND,
        // +/-1 day: see adjacentDates. A watch taken at 23:59 local is stamped
        // D-1 and spent on D; matching one exact date would strand it forever.
        grantedDate: { in: adjacentDates(effectiveDate) },
        consumedAt: null,
      },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (!grant) {
      // The client retries briefly on this code — the SSV callback can lag the
      // on-device earned-reward event by a few seconds (same as extra spin).
      throw new PowerupRerollError(
        "No verified ad reward available yet",
        409,
        "AD_NOT_VERIFIED"
      );
    }
    if (typeof tx?.$queryRawUnsafe === "function") {
      await tx.$queryRawUnsafe(
        "SELECT id FROM ad_reward_grants WHERE id = $1 FOR UPDATE",
        grant.id,
      );
    }
    // CAS: a concurrent duplicate loses here, before anything rerolls.
    const consumed = await tx.adRewardGrant.updateMany({
      where: { id: grant.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (!consumed || consumed.count === 0) {
      throw new PowerupRerollError(
        "No verified ad reward available yet",
        409,
        "AD_NOT_VERIFIED"
      );
    }

    // ── The roll. Same context builder, same config snapshot, same null guard
    // as openMysteryBox, at the player's CURRENT position (a reroll late in a
    // race rolls on late-race odds, not the odds the box was opened under).
    const allParticipants = await participantModel.findAcceptedByRace(raceId);
    // The SAME raw-walked-steps position an open uses (2026-08-09,
    // docs/box-raw-steps-position-and-option-h-requirements.md) — a reroll is a
    // new roll and must not be a way around the fix.
    const { position, totalParticipants } = rawPositionFor({
      participants: allParticipants,
      race,
      userId,
    });

    // ctx step inputs stay on the EFFECT-SENSITIVE totals, exactly as in
    // openMysteryBox: the exclusion predicates mirror use-time checks.
    const ctx = buildRollContext({
      stepTotals: allParticipants.map((p) => p.totalSteps || 0),
      myTotalSteps: participant.totalSteps || 0,
      position,
      totalParticipants,
      isTeamRace: race.isTeamRace === true,
      supportsPowerups5,
    });

    // D9 provenance: the reroll REPLACES the row's roll, so the stamp must be
    // replaced too. Leaving the old version would claim a config produced a
    // result it never saw.
    const { version: configVersion, config } = await balance.getSnapshot();

    // No Lucky Horseshoe minimum here: the paid buff is consumed by the OPEN it
    // was active for, and a reroll is a new, ad-funded roll.
    let rolled = rollFn(position, totalParticipants, Math.random, { ctx, config });

    // Fanny Pack cannot be a reroll result. openMysteryBox re-rolls it only when
    // slots are already expanded and otherwise auto-activates it; a reroll has
    // no auto-activate branch (the row is already occupying a slot), so a
    // FANNY_PACK here would be an unusable dud. Re-roll it unconditionally,
    // bounded so a degenerate config can't spin forever.
    const maxSlots = participant.powerupSlots || DEFAULT_POWERUP_SLOTS;
    for (
      let attempt = 0;
      rolled.type === "FANNY_PACK" && maxSlots > DEFAULT_POWERUP_SLOTS && attempt < 10;
      attempt += 1
    ) {
      rolled = rollFn(position, totalParticipants, Math.random, { ctx, config });
    }

    rolled = resolveNullRoll(rolled, config, ctx);

    // Step 7 — the SAME canonical-rarity stamp openMysteryBox applies, for the
    // same reason: the discard payout and the client tint read this value, and
    // it must never claim the tier that happened to produce the roll.
    //
    // The guaranteed-minimum floor is threaded through explicitly even though a
    // reroll has NO Lucky Horseshoe today (the paid buff is consumed by the
    // open it was active for, and `rollFn` above is called with no minRarity).
    // If a guaranteed-minimum reroll is ever added, the floor is already here —
    // the failure mode it prevents (stamping a guarantee back down to COMMON
    // under Option H) is silent and player-visible only as a wrong price.
    rolled = {
      ...rolled,
      rarity: canonicalRarityFor(rolled.type, rolled.rarity, config, null),
    };

    // ── Persist. Conditional on the row still being an un-rerolled HELD row, so
    // two concurrent rerolls cannot both write (the second loses and 409s).
    const claimed = await tx.racePowerup.updateMany({
      where: {
        id: powerupId,
        userId,
        raceId,
        status: "HELD",
        usedAt: null,
        rarity: { not: null },
        upgradeLevel: 0,
        rerolledAt: null,
      },
      data: {
        type: rolled.type,
        rarity: rolled.rarity,
        configVersion,
        rerolledAt: new Date(),
      },
    });
    if (!claimed || claimed.count === 0) {
      throw new PowerupRerollError(
        "This powerup has already been rerolled",
        409,
        "ALREADY_REROLLED"
      );
    }

    // Audit-only feed row, hidden from the visible feed exactly like
    // MYSTERY_BOX_OPENED (getRaceFeed's post-query filter AND
    // getRaceMessages' HIDDEN_SYSTEM_EVENT_TYPES). Revealing "X rerolled into
    // RED_CARD" would leak box contents the normal open path deliberately hides.
    await eventModel.create({
      raceId,
      actorUserId: userId,
      eventType: "POWERUP_REROLLED",
      powerupType: rolled.type,
      description: `${displayName || "A runner"} rerolled a mystery box: ${
        POWERUP_NAMES[rolled.type] || rolled.type
      }!`,
    });

    // No invalidateRaceProgress: `powerupData.inventory` is built in the
    // per-viewer overlay from a live findSlotPowerups read, not from the shared
    // cached snapshot, so there is nothing stale to drop.
    return { id: powerupId, type: rolled.type, rarity: rolled.rarity, rerolled: true };
    }, { maxWait: 10_000, timeout: 20_000 });
  };
}

const rerollMysteryBox = buildRerollMysteryBox();

module.exports = {
  buildRerollMysteryBox,
  rerollMysteryBox,
  PowerupRerollError,
  // Batch 2026-08-10b item 1 — shared with rerollMysteryBoxBatch.js. EXPORTED
  // rather than copy-pasted on purpose: three divergent copies of a date guard
  // is the shape of the renderMetadata incident.
  isValidLocalDate,
  withinOneDayOfServer,
  adjacentDates,
  localDateFor,
  resolveNullRoll,
};
