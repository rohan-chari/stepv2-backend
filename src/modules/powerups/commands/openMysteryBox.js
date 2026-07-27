const { RacePowerup } = require("../models/racePowerup");
const { RaceParticipant } = require("../../races/models/raceParticipant");
const { RacePowerupEvent } = require("../models/racePowerupEvent");
const { Race } = require("../../races/models/race");
const { RaceActiveEffect } = require("../models/raceActiveEffect");
const { eventBus } = require("../../../shared/events/eventBus");
const {
  rollPowerup: rollPowerupOdds,
  RARITY_ORDER,
  buildRollContext,
  pickTypeForRarity,
} = require("../powerupOdds");
const { balanceConfig: defaultBalanceConfig } = require("../../economy/balanceConfig");
const { POWERUP_NAMES, DEFAULT_POWERUP_SLOTS } = require("./rollPowerup");
const {
  syncRacePowerupState: defaultSyncRacePowerupState,
} = require("../../races/services/racePowerupStateSync");

// §5.5 — empty-tier cascade.
//
// The hard gates in eligiblePoolFor sit OUTSIDE the empty-pool fallback, so for
// the first time pickTypeForRarity can legitimately return null. With the
// shipped config that cannot happen (UNCOMMON holds four types of which one is
// gated), but it must still be defined: a box the player has already tapped must
// always produce something, and writing a null `type` onto the row would be the
// worst possible failure.
//
// null -> re-roll once at the tier BELOW -> still null -> PROTEIN_SHAKE, the
// always-present COMMON. Never persists null, never throws.
function resolveNullRoll(rolled, config, ctx) {
  if (rolled && rolled.type) return rolled;
  const index = RARITY_ORDER.indexOf(rolled?.rarity);
  if (index > 0) {
    const lower = RARITY_ORDER[index - 1];
    const type = pickTypeForRarity(lower, Math.random, config, ctx);
    if (type) return { type, rarity: lower };
  }
  return { type: "PROTEIN_SHAKE", rarity: config?.rarityByType?.PROTEIN_SHAKE || "COMMON" };
}

class MysteryBoxOpenError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "MysteryBoxOpenError";
    if (statusCode) this.statusCode = statusCode;
  }
}

function buildOpenMysteryBox(dependencies = {}) {
  const hasInjectedDeps = Object.keys(dependencies).length > 0;
  const powerupModel = dependencies.RacePowerup || RacePowerup;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const eventModel = dependencies.RacePowerupEvent || RacePowerupEvent;
  const raceModel = dependencies.Race || Race;
  const effectModel = dependencies.RaceActiveEffect || (hasInjectedDeps
    ? {
        async findActiveByTypeForParticipant() { return null; },
        async update() {},
      }
    : RaceActiveEffect);
  const events = dependencies.eventBus || eventBus;
  const rollFn = dependencies.rollPowerupOdds || rollPowerupOdds;
  const balance = dependencies.balanceConfig || defaultBalanceConfig;
  const syncRacePowerupState = Object.prototype.hasOwnProperty.call(
    dependencies,
    "syncRacePowerupState"
  )
    ? dependencies.syncRacePowerupState
    : hasInjectedDeps
      ? async () => {}
      : defaultSyncRacePowerupState;

  // `supportsPowerups5` (2026-07-26) is OPTIONAL and defaults to false — the
  // safe side of a compatibility gate. Threaded from the route's
  // X-Client-Features so a frozen binary can never roll a wave-5 type.
  return async function openMysteryBox({
    userId,
    raceId,
    powerupId,
    displayName,
    supportsPowerups5 = false,
  }) {
    const powerup = await powerupModel.findById(powerupId);
    if (!powerup) {
      throw new MysteryBoxOpenError("Powerup not found", 404);
    }
    if (powerup.userId !== userId || powerup.raceId !== raceId) {
      throw new MysteryBoxOpenError("This powerup does not belong to you", 403);
    }
    if (powerup.status !== "MYSTERY_BOX") {
      throw new MysteryBoxOpenError("This powerup is not a mystery box", 400);
    }

    const race = await raceModel.findById(raceId);
    if (!race || race.status !== "ACTIVE") {
      throw new MysteryBoxOpenError("Race is not active", 400);
    }

    const participant = await participantModel.findByRaceAndUser(raceId, userId);
    if (!participant) {
      throw new MysteryBoxOpenError("You are not in this race", 403);
    }

    const maxSlots = participant.powerupSlots || DEFAULT_POWERUP_SLOTS;
    const occupiedCount = await powerupModel.countOccupiedSlots(participant.id);

    // Calculate current position for odds. Team races (TR-655) roll on TEAM
    // position instead of individual rank: the trailing team's members get the
    // existing catch-up odds tier (rank 2 of 2), the leading team rolls
    // standard (rank 1 of 2), and a tie counts both teams as leading.
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
      const sorted = [...allParticipants].sort((a, b) => b.totalSteps - a.totalSteps);
      position = sorted.findIndex((p) => p.userId === userId) + 1;
      totalParticipants = sorted.length;
    }

    // Position-aware drop context. Computed from TRUE INDIVIDUAL step totals in
    // BOTH solo and team races, and deliberately independent of `position` above:
    // team position is collapsed to 1-of-2 for tier purposes, but RED_CARD's
    // use-time check targets the individual leader, and both RED_CARD and
    // SECOND_WIND also reject on a TIE at the top (where sort order is
    // arbitrary). getRaceProgress builds the same context from the same helper
    // so the displayed odds and the roll cannot drift.
    const ctx = buildRollContext({
      stepTotals: allParticipants.map((p) => p.totalSteps || 0),
      myTotalSteps: participant.totalSteps || 0,
      position,
      totalParticipants,
      // The two HARD gates (docs/team-only-drop-pool-requirements.md §5.4).
      // getRaceProgress builds these from the same two facts so the quoted odds
      // and the actual roll cannot disagree.
      isTeamRace: race.isTeamRace === true,
      supportsPowerups5,
    });

    // Read the config ONCE per open, and stamp the version we actually rolled
    // from onto the row (D9). Workers cache independently under pm2 cluster
    // mode, so "which config produced this box?" is only answerable because of
    // this stamp — the 5s TTL bounds the skew, it does not remove it.
    const { version: configVersion, config } = await balance.getSnapshot();

    const luckyEffect = await effectModel.findActiveByTypeForParticipant?.(
      participant.id,
      "LUCKY_HORSESHOE"
    );
    const minRarity = luckyEffect?.metadata?.minRarity;

    // Roll the powerup type now
    let rolled = rollFn(position, totalParticipants, Math.random, { minRarity, ctx, config });
    if (minRarity) {
      const rolledIndex = RARITY_ORDER.indexOf(rolled.rarity);
      const minIndex = RARITY_ORDER.indexOf(minRarity);
      if (rolledIndex !== -1 && minIndex !== -1 && rolledIndex < minIndex) {
        // Lucky Horseshoe minimum-rarity backstop. This used to assign
        // `config.dropPool[minRarity][0]` verbatim — which is RED_CARD, the one
        // RARE the server guarantees a leader cannot use. A real weighted pick
        // from the POSITION-FILTERED pool both fixes that and removes the latent
        // trap where reordering dropPool.RARE silently changes the award.
        const forced = pickTypeForRarity(minRarity, Math.random, config, ctx);
        if (forced) rolled = { type: forced, rarity: minRarity };
      }
    }
    // Re-roll Fanny Pack if user already has expanded slots
    while (rolled.type === "FANNY_PACK" && maxSlots > DEFAULT_POWERUP_SLOTS) {
      rolled = rollFn(position, totalParticipants, Math.random, { minRarity, ctx, config });
    }

    // §5.5. Last thing before anything is persisted, so every branch above —
    // normal roll, Lucky Horseshoe backstop, Fanny Pack re-roll — is covered by
    // one guard rather than three.
    rolled = resolveNullRoll(rolled, config, ctx);

    if (luckyEffect) {
      await effectModel.update(luckyEffect.id, { status: "EXPIRED" });
    }

    // Fanny Pack auto-activates when inventory is full
    if (rolled.type === "FANNY_PACK" && occupiedCount >= maxSlots) {
      await participantModel.update(participant.id, { powerupSlots: maxSlots + 1 });
      await powerupModel.update(powerupId, { type: rolled.type, rarity: rolled.rarity, status: "USED", usedAt: new Date(), configVersion });

      // B1: use MYSTERY_BOX_OPENED (not POWERUP_EARNED) so this reveal is hidden
      // from the activity feed by the same filter as normal opens, AND so the
      // admin "unique box openers" metric — which counts by eventType — includes
      // full-inventory auto-activate opens (previously undercounted).
      await eventModel.create({
        raceId,
        actorUserId: userId,
        eventType: "MYSTERY_BOX_OPENED",
        powerupType: rolled.type,
        description: `${displayName || "A runner"} opened a mystery box — ${POWERUP_NAMES[rolled.type]}! Auto-activated — extra slot unlocked.`,
      });

      events.emit("MYSTERY_BOX_OPENED", {
        raceId,
        userId,
        powerupId,
        type: rolled.type,
        rarity: rolled.rarity,
        autoActivated: true,
      });

      await syncRacePowerupState({ raceId, userId });

      return { id: powerup.id, type: rolled.type, rarity: rolled.rarity, autoActivated: true };
    }

    await powerupModel.update(powerupId, { type: rolled.type, rarity: rolled.rarity, status: "HELD", configVersion });

    // Item 9: persist a MYSTERY_BOX_OPENED event so the admin "avg unique box
    // openers / day" metric has data (no history before this deploy). This is the
    // ONLY place a normal open is recorded — the Fanny-Pack auto-activate branch
    // above already writes its own POWERUP_EARNED row. The row is audit-only:
    // getRaceFeed filters MYSTERY_BOX_OPENED out of the visible feed so the
    // frequent box opens don't flood it.
    await eventModel.create({
      raceId,
      actorUserId: userId,
      eventType: "MYSTERY_BOX_OPENED",
      powerupType: rolled.type,
      description: `${displayName || "A runner"} opened a mystery box — ${POWERUP_NAMES[rolled.type] || rolled.type}!`,
    });

    events.emit("MYSTERY_BOX_OPENED", {
      raceId,
      userId,
      powerupId,
      type: rolled.type,
      rarity: rolled.rarity,
      autoActivated: false,
    });

    await syncRacePowerupState({ raceId, userId });

    return { id: powerup.id, type: rolled.type, rarity: rolled.rarity, autoActivated: false };
  };
}

const openMysteryBox = buildOpenMysteryBox();

module.exports = { buildOpenMysteryBox, openMysteryBox, MysteryBoxOpenError };
