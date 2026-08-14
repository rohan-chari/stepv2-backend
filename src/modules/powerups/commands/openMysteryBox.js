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
  canonicalRarityFor,
} = require("../powerupOdds");
const { rawPositionFor } = require("../rawPosition");
const { balanceConfig: defaultBalanceConfig } = require("../../economy/balanceConfig");
const { POWERUP_NAMES, DEFAULT_POWERUP_SLOTS } = require("./rollPowerup");
const {
  repairRacePowerupInventory: defaultRepairRacePowerupInventory,
} = require("../../races/services/racePowerupInventoryRepair");

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

const {
  enqueueRaceResolution: defaultEnqueueRaceResolution,
} = require("../../races/services/enqueueRaceResolution");
// C3 (spec §5 Phase D step 9): this write seam is a snapshot DEL hook — the
// shared standings snapshot must not outlive the change we just committed. The
// resolution worker is deliberately NOT in this list: it SETs post-commit.
const {
  invalidateRaceProgress,
} = require("../../races/services/raceProgressSnapshot");

function buildOpenMysteryBox(dependencies = {}) {
  const hasInjectedDeps = Object.keys(dependencies).length > 0;
  // C0 (spec §5a item 4): mark the race dirty after the box's own small writes
  // so the race-keyed worker re-converges standings. No-op stub for injected
  // fakes so unit tests stay DB-free.
  const enqueueRaceResolution = Object.prototype.hasOwnProperty.call(
    dependencies,
    "enqueueRaceResolution"
  )
    ? dependencies.enqueueRaceResolution
    : hasInjectedDeps
      ? async () => null
      : defaultEnqueueRaceResolution;
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
  const repairRacePowerupInventory = Object.prototype.hasOwnProperty.call(
    dependencies,
    "repairRacePowerupInventory"
  )
    ? dependencies.repairRacePowerupInventory
    : hasInjectedDeps
      ? async () => {}
      : defaultRepairRacePowerupInventory;

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
      // Idempotent re-open (2026-08-10). Prod logs show every "failed to open
      // mystery box" report is a client re-POSTing a box that already opened
      // fine seconds earlier (stale second screen/device, reroll re-arm). The
      // roll is done and the reward granted — answering 400 tells the user
      // something broke when nothing did, and no shipped binary can be patched
      // out of doing this. Mirror openMysteryBoxBatch's contract instead:
      // an already-rolled id returns its existing type/rarity as a normal
      // reveal. Pure read — no event row, no cache invalidation, no re-roll —
      // which is also why it deliberately sits BEFORE the race-ACTIVE and
      // participant checks: replaying the caller's own already-rolled row is
      // safe (ownership verified above) even after the race settles.
      //
      // A non-null `type` IS the "this box was already rolled" fact; status is
      // only a proxy (EXPIRED rows are settlement-swept HELD rolls, equally
      // replayable). QUEUED / DISCARDED / null-type rows keep the 400.
      const openedStatuses = ["HELD", "USED", "EXPIRED"];
      if (powerup.type && openedStatuses.includes(powerup.status)) {
        return {
          id: powerup.id,
          type: powerup.type,
          rarity: powerup.rarity,
          autoActivated: false,
          alreadyOpened: true,
        };
      }
      throw new MysteryBoxOpenError("This powerup is not a mystery box", 400);
    }

    const race = typeof raceModel.findMysteryBoxContext === "function"
      ? await raceModel.findMysteryBoxContext(raceId)
      : await raceModel.findById(raceId);
    if (!race || race.status !== "ACTIVE") {
      throw new MysteryBoxOpenError("Race is not active", 400);
    }

    const participantsFromRace = Array.isArray(race.participants)
      ? race.participants
      : null;
    const participant = participantsFromRace
      ? participantsFromRace.find((entry) => entry.userId === userId)
      : await participantModel.findByRaceAndUser(raceId, userId);
    if (!participant) {
      throw new MysteryBoxOpenError("You are not in this race", 403);
    }

    const maxSlots = participant.powerupSlots || DEFAULT_POWERUP_SLOTS;
    const occupiedCount = await powerupModel.countOccupiedSlots(participant.id);

    // Current position for odds, from RAW WALKED steps (2026-08-09,
    // docs/box-raw-steps-position-and-option-h-requirements.md). Raw steps only
    // grow by walking, so neither box banking nor powerup hoarding can move a
    // player's odds tier. The helper owns the solo sort, the team sums (TR-655:
    // team races roll on TEAM position, 1-of-2 / 2-of-2, a tie counting both as
    // leading) and the per-race all-or-nothing NULL fallback to `totalSteps`.
    // getRaceProgress's disclosure calls the SAME helper over the SAME
    // persisted rows, so the quoted odds and this roll cannot drift.
    const allParticipants = participantsFromRace
      ? participantsFromRace.filter((entry) => entry.status === "ACCEPTED")
      : await participantModel.findAcceptedByRace(raceId);
    const { position, totalParticipants } = rawPositionFor({
      participants: allParticipants,
      race,
      userId,
    });

    // Position-aware drop context. Computed from TRUE INDIVIDUAL EFFECTIVE step
    // totals (`totalSteps`) in BOTH solo and team races — deliberately NOT from
    // the raw steps `position` above. `isStepLeader` / `isStepLast` mirror the
    // USE-TIME checks for RED_CARD / SECOND_WIND / TRAIL_MINE, and those read
    // the leaderboard total; moving them to raw steps would start dropping
    // powerups the server refuses to let the player use. The odds TIER follows
    // your walking; the eligibility gates follow the board.
    //
    // Also deliberately independent of `position` above:
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

    // Roll the powerup type now.
    //
    // `excludeTypes` (item 8b) only bites when `minRarity` is set — i.e. on a
    // Horseshoe-FORCED box — so a natural RARE roll can still be a Horseshoe.
    // The exclusion is applied inside eligiblePoolFor (the shared pool seam),
    // NOT as a retry here: with rareChanceByLevel = [1,1,1,1] the tier is
    // coerced before the pick, so the post-pick backstop below never runs.
    const HORSESHOE_FORCED_EXCLUSIONS = ["LUCKY_HORSESHOE"];
    let rolled = rollFn(position, totalParticipants, Math.random, {
      minRarity,
      ctx,
      config,
      excludeTypes: HORSESHOE_FORCED_EXCLUSIONS,
    });
    if (minRarity) {
      const rolledIndex = RARITY_ORDER.indexOf(rolled.rarity);
      const minIndex = RARITY_ORDER.indexOf(minRarity);
      if (rolledIndex !== -1 && minIndex !== -1 && rolledIndex < minIndex) {
        // Lucky Horseshoe minimum-rarity backstop. This used to assign
        // `config.dropPool[minRarity][0]` verbatim — which is RED_CARD, the one
        // RARE the server guarantees a leader cannot use. A real weighted pick
        // from the POSITION-FILTERED pool both fixes that and removes the latent
        // trap where reordering dropPool.RARE silently changes the award.
        // Same exclusion as the roll above. This branch is unreachable while
        // the config guarantees RARE at every level, but it IS reachable during
        // rollout — the stored config may still carry the old ramp
        // ([0, 0.2, 0.45, 1.0]) until the balance PUT lands, in which case a
        // level-0 Horseshoe yields minRarity = UNCOMMON and this backstop fires
        // for real. Excluding here too is what keeps the two windows consistent.
        const forced = pickTypeForRarity(
          minRarity,
          Math.random,
          config,
          ctx,
          HORSESHOE_FORCED_EXCLUSIONS
        );
        if (forced) rolled = { type: forced, rarity: minRarity };
      }
    }
    // Re-roll Fanny Pack if user already has expanded slots.
    //
    // DEAD CODE as of batch 2026-08-09 item 8a — FANNY_PACK is no longer in any
    // dropPool, so `rolled.type` can never be one. Left in place deliberately:
    // removing it buys nothing, and a held/legacy copy costs nothing to keep
    // handling. Same for the full-inventory auto-activate branch below.
    while (rolled.type === "FANNY_PACK" && maxSlots > DEFAULT_POWERUP_SLOTS) {
      rolled = rollFn(position, totalParticipants, Math.random, {
        minRarity,
        ctx,
        config,
        excludeTypes: HORSESHOE_FORCED_EXCLUSIONS,
      });
    }

    // §5.5. Last thing before anything is persisted, so every branch above —
    // normal roll, Lucky Horseshoe backstop, Fanny Pack re-roll — is covered by
    // one guard rather than three.
    rolled = resolveNullRoll(rolled, config, ctx);

    // Step 7 — stamp the CANONICAL rarity when the tier that produced the roll
    // disagrees with `rarityByType`. One consistent ladder for the tint, the
    // upgrade price and the discard payout; without it Option H's boosted
    // commons would discard for the UNCOMMON price. Applies to BOTH persist
    // branches below (auto-activate and normal) because it happens here, once.
    //
    // `minRarity` is passed so an active Lucky Horseshoe's GUARANTEE outranks
    // the canonical rarity: the whole tier above was already coerced up to the
    // guarantee, and stamping a COMMON-canonical type back down would silently
    // void a paid promise (code review 2026-08-09).
    rolled = {
      ...rolled,
      rarity: canonicalRarityFor(rolled.type, rolled.rarity, config, minRarity),
    };

    if (luckyEffect) {
      await effectModel.update(luckyEffect.id, { status: "EXPIRED" });
    }

    // Fanny Pack auto-activates when inventory is full
    if (rolled.type === "FANNY_PACK" && occupiedCount >= maxSlots) {
      await participantModel.update(participant.id, { powerupSlots: maxSlots + 1 });
      participant.powerupSlots = maxSlots + 1;
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
        description: `${displayName || "A runner"} opened a mystery box: ${POWERUP_NAMES[rolled.type]}! Auto-activated. Extra slot unlocked.`,
      });

      events.emit("MYSTERY_BOX_OPENED", {
        raceId,
        userId,
        powerupId,
        type: rolled.type,
        rarity: rolled.rarity,
        autoActivated: true,
      });

      await repairRacePowerupInventory({ raceId, userId, race, participant });
      await invalidateRaceProgress(raceId);
      await enqueueRaceResolution({
        raceId,
        userId,
        reason: "BOX_OPEN",
        priority: "IMMEDIATE",
      });

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
      description: `${displayName || "A runner"} opened a mystery box: ${POWERUP_NAMES[rolled.type] || rolled.type}!`,
    });

    events.emit("MYSTERY_BOX_OPENED", {
      raceId,
      userId,
      powerupId,
      type: rolled.type,
      rarity: rolled.rarity,
      autoActivated: false,
    });

    await repairRacePowerupInventory({ raceId, userId, race, participant });
    await invalidateRaceProgress(raceId);

    return { id: powerup.id, type: rolled.type, rarity: rolled.rarity, autoActivated: false };
  };
}

const openMysteryBox = buildOpenMysteryBox();

module.exports = { buildOpenMysteryBox, openMysteryBox, MysteryBoxOpenError };
