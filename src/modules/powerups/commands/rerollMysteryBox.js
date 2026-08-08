const { prisma } = require("../../../db");
const { RacePowerup } = require("../models/racePowerup");
const { RaceParticipant } = require("../../races/models/raceParticipant");
const { RacePowerupEvent } = require("../models/racePowerupEvent");
const { Race } = require("../../races/models/race");
const {
  rollPowerup: rollPowerupOdds,
  RARITY_ORDER,
  buildRollContext,
  pickTypeForRarity,
} = require("../powerupOdds");
const {
  balanceConfig: defaultBalanceConfig,
} = require("../../economy/balanceConfig");
const { POWERUP_NAMES, DEFAULT_POWERUP_SLOTS } = require("./rollPowerup");
const {
  BOX_REROLL_REWARD_KIND,
  adsBoxRerollEnabled,
} = require("../../economy/adRewards");

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
    const effectiveDate =
      typeof localDate === "string" && LOCAL_DATE_RE.test(localDate)
        ? localDate
        : localDateFor(timeZone);

    const grant = await db.adRewardGrant.findFirst({
      where: {
        userId,
        rewardKind: BOX_REROLL_REWARD_KIND,
        grantedDate: effectiveDate,
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
    // CAS: a concurrent duplicate loses here, before anything rerolls.
    const consumed = await db.adRewardGrant.updateMany({
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
    let position;
    let totalParticipants;
    if (race.isTeamRace) {
      const teamTotals = { TEAM_A: 0, TEAM_B: 0 };
      for (const p of allParticipants) {
        if (p.team === "TEAM_A") teamTotals.TEAM_A += p.totalSteps || 0;
        else if (p.team === "TEAM_B") teamTotals.TEAM_B += p.totalSteps || 0;
      }
      const myTeam = participant.team;
      const otherTeam = myTeam === "TEAM_A" ? "TEAM_B" : "TEAM_A";
      position = teamTotals[myTeam] < teamTotals[otherTeam] ? 2 : 1;
      totalParticipants = 2;
    } else {
      const sorted = [...allParticipants].sort(
        (a, b) => b.totalSteps - a.totalSteps
      );
      position = sorted.findIndex((p) => p.userId === userId) + 1;
      totalParticipants = sorted.length;
    }

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

    // ── Persist. Conditional on the row still being an un-rerolled HELD row, so
    // two concurrent rerolls cannot both write (the second loses and 409s).
    const claimed = await db.racePowerup.updateMany({
      where: { id: powerupId, status: "HELD", rerolledAt: null },
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
      description: `${displayName || "A runner"} rerolled a mystery box — ${
        POWERUP_NAMES[rolled.type] || rolled.type
      }!`,
    });

    // No invalidateRaceProgress: `powerupData.inventory` is built in the
    // per-viewer overlay from a live findSlotPowerups read, not from the shared
    // cached snapshot, so there is nothing stale to drop.
    return { id: powerupId, type: rolled.type, rarity: rolled.rarity, rerolled: true };
  };
}

const rerollMysteryBox = buildRerollMysteryBox();

module.exports = { buildRerollMysteryBox, rerollMysteryBox, PowerupRerollError };
