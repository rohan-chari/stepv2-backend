const { Router } = require("express");
const { buildRequireAuth } = require("../middleware/requireAuth");
const { createRace: defaultCreateRace } = require("../commands/createRace");
const {
  inviteToRace: defaultInviteToRace,
} = require("../commands/inviteToRace");
const {
  respondToRaceInvite: defaultRespondToRaceInvite,
} = require("../commands/respondToRaceInvite");
const {
  joinPublicRace: defaultJoinPublicRace,
} = require("../commands/joinPublicRace");
const {
  kickRaceParticipant: defaultKickRaceParticipant,
} = require("../commands/kickRaceParticipant");
const {
  getPublicRaces: defaultGetPublicRaces,
} = require("../queries/getPublicRaces");
const { startRace: defaultStartRace } = require("../commands/startRace");
const { cancelRace: defaultCancelRace } = require("../commands/cancelRace");
const { editRace: defaultEditRace } = require("../commands/editRace");
const {
  usePowerup: defaultUsePowerup,
} = require("../commands/usePowerup");
const {
  discardPowerup: defaultDiscardPowerup,
} = require("../commands/discardPowerup");
const {
  openMysteryBox: defaultOpenMysteryBox,
} = require("../commands/openMysteryBox");
const { getRaces: defaultGetRaces } = require("../queries/getRaces");
const {
  getRaceDetails: defaultGetRaceDetails,
} = require("../queries/getRaceDetails");
const {
  getRaceProgress: defaultGetRaceProgress,
} = require("../queries/getRaceProgress");
const {
  getRaceInventory: defaultGetRaceInventory,
} = require("../queries/getRaceInventory");
const {
  getRaceFeed: defaultGetRaceFeed,
} = require("../queries/getRaceFeed");
const {
  getRaceMessages: defaultGetRaceMessages,
} = require("../queries/getRaceMessages");
const {
  sendRaceMessage: defaultSendRaceMessage,
} = require("../commands/sendRaceMessage");
const {
  deleteRaceMessage: defaultDeleteRaceMessage,
} = require("../commands/deleteRaceMessage");
const {
  setRaceChatMute: defaultSetRaceChatMute,
  markRaceChatRead: defaultMarkRaceChatRead,
} = require("../commands/setRaceChatMute");
const { Race: defaultRaceModel } = require("../models/race");
const { RacePowerup: defaultPowerupModel } = require("../models/racePowerup");
const {
  RaceActiveEffect: defaultEffectModel,
} = require("../models/raceActiveEffect");

function createRacesRouter(dependencies = {}) {
  const router = Router();
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);

  const createRace = dependencies.createRace || defaultCreateRace;
  const inviteToRace = dependencies.inviteToRace || defaultInviteToRace;
  const respondToRaceInvite =
    dependencies.respondToRaceInvite || defaultRespondToRaceInvite;
  const joinPublicRace =
    dependencies.joinPublicRace || defaultJoinPublicRace;
  const kickRaceParticipant =
    dependencies.kickRaceParticipant || defaultKickRaceParticipant;
  const getPublicRaces =
    dependencies.getPublicRaces || defaultGetPublicRaces;
  const startRace = dependencies.startRace || defaultStartRace;
  const cancelRace = dependencies.cancelRace || defaultCancelRace;
  const editRace = dependencies.editRace || defaultEditRace;
  const getRaces = dependencies.getRaces || defaultGetRaces;
  const getRaceDetails = dependencies.getRaceDetails || defaultGetRaceDetails;
  const getRaceProgress =
    dependencies.getRaceProgress || defaultGetRaceProgress;
  const usePowerup = dependencies.usePowerup || defaultUsePowerup;
  const discardPowerup = dependencies.discardPowerup || defaultDiscardPowerup;
  const openMysteryBox = dependencies.openMysteryBox || defaultOpenMysteryBox;
  const getRaceInventory =
    dependencies.getRaceInventory || defaultGetRaceInventory;
  const getRaceFeed = dependencies.getRaceFeed || defaultGetRaceFeed;
  const getRaceMessages =
    dependencies.getRaceMessages || defaultGetRaceMessages;
  const sendRaceMessage =
    dependencies.sendRaceMessage || defaultSendRaceMessage;
  const deleteRaceMessage =
    dependencies.deleteRaceMessage || defaultDeleteRaceMessage;
  const setRaceChatMute =
    dependencies.setRaceChatMute || defaultSetRaceChatMute;
  const markRaceChatRead =
    dependencies.markRaceChatRead || defaultMarkRaceChatRead;
  const raceModel = dependencies.Race || defaultRaceModel;
  const powerupModel = dependencies.RacePowerup || defaultPowerupModel;
  const effectModel = dependencies.RaceActiveEffect || defaultEffectModel;

  router.use(requireAuth);

  // POST /races
  router.post("/", async (req, res) => {
    try {
      const {
        name,
        maxDurationDays,
        powerupsEnabled,
        powerupStepInterval,
        buyInAmount,
        payoutPreset,
        isPublic,
        maxParticipants,
        targetSteps,
      } = req.body;
      const race = await createRace({
        userId: req.user.id,
        name,
        maxDurationDays,
        powerupsEnabled,
        powerupStepInterval,
        buyInAmount,
        payoutPreset,
        isPublic,
        maxParticipants,
        targetSteps,
      });
      res.status(201).json({ race });
    } catch (error) {
      if (error.name === "RaceCreationError") {
        const status = error.statusCode || 400;
        return res.status(status).json({ error: error.message });
      }
      console.error("Create race error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /races
  router.get("/", async (req, res) => {
    try {
      const result = await getRaces(req.user.id);
      res.json(result);
    } catch (error) {
      console.error("Get races error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /races/public
  router.get("/public", async (req, res) => {
    try {
      const races = await getPublicRaces({ userId: req.user.id });
      res.json({ races });
    } catch (error) {
      console.error("Get public races error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /races/:raceId/join
  router.post("/:raceId/join", async (req, res) => {
    try {
      const participant = await joinPublicRace({
        userId: req.user.id,
        raceId: req.params.raceId,
      });
      res.status(201).json({ participant });
    } catch (error) {
      if (error.name === "RaceJoinError") {
        const status = error.statusCode || 400;
        return res.status(status).json({ error: error.message });
      }
      console.error("Join public race error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // DELETE /races/:raceId/participants/:userId
  router.delete("/:raceId/participants/:userId", async (req, res) => {
    try {
      await kickRaceParticipant({
        userId: req.user.id,
        raceId: req.params.raceId,
        targetUserId: req.params.userId,
      });
      res.json({ success: true });
    } catch (error) {
      if (error.name === "RaceKickError") {
        const status = error.statusCode || 400;
        return res.status(status).json({ error: error.message });
      }
      console.error("Kick participant error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /races/:raceId
  router.get("/:raceId", async (req, res) => {
    try {
      const result = await getRaceDetails(req.user.id, req.params.raceId);
      res.json(result);
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error("Get race details error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /races/:raceId/invite
  router.post("/:raceId/invite", async (req, res) => {
    try {
      const { inviteeIds } = req.body;
      const race = await inviteToRace({
        userId: req.user.id,
        raceId: req.params.raceId,
        inviteeIds,
      });
      res.json({ race });
    } catch (error) {
      if (error.name === "RaceInviteError") {
        const status = error.statusCode || 400;
        return res.status(status).json({ error: error.message });
      }
      console.error("Invite to race error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PUT /races/:raceId/respond
  router.put("/:raceId/respond", async (req, res) => {
    try {
      const { accept } = req.body;
      const participant = await respondToRaceInvite({
        userId: req.user.id,
        raceId: req.params.raceId,
        accept,
      });
      res.json({ participant });
    } catch (error) {
      if (error.name === "RaceInviteResponseError") {
        const status = error.statusCode || 400;
        return res.status(status).json({ error: error.message });
      }
      console.error("Respond to race invite error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /races/:raceId/start
  router.post("/:raceId/start", async (req, res) => {
    try {
      const race = await startRace({
        userId: req.user.id,
        raceId: req.params.raceId,
      });
      res.json({ race });
    } catch (error) {
      if (error.name === "RaceStartError") {
        const status = error.statusCode || 400;
        return res.status(status).json({ error: error.message });
      }
      console.error("Start race error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /races/:raceId/progress
  router.get("/:raceId/progress", async (req, res) => {
    try {
      const progress = await getRaceProgress(
        req.user.id,
        req.params.raceId,
        req.timeZone
      );
      res.json({ progress });
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error("Race progress error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /races/:raceId/powerups/:powerupId/use
  router.post("/:raceId/powerups/:powerupId/use", async (req, res) => {
    try {
      const {
        targetUserId,
        targetDirection,
        swapOfferedPowerupId,
        swapRequestedPowerupId,
        upgradeLevel,
      } = req.body;
      const result = await usePowerup({
        userId: req.user.id,
        raceId: req.params.raceId,
        powerupId: req.params.powerupId,
        targetUserId,
        targetDirection,
        swapOfferedPowerupId,
        swapRequestedPowerupId,
        timeZone: req.timeZone,
        upgradeLevel: upgradeLevel != null ? upgradeLevel : 0,
      });
      res.json({ result });
    } catch (error) {
      if (error.name === "PowerupUseError") {
        const status = error.statusCode || 400;
        return res.status(status).json({ error: error.message });
      }
      console.error("Use powerup error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /races/:raceId/powerups/:powerupId/discard
  router.post("/:raceId/powerups/:powerupId/discard", async (req, res) => {
    try {
      const result = await discardPowerup({
        userId: req.user.id,
        raceId: req.params.raceId,
        powerupId: req.params.powerupId,
        displayName: req.user.displayName,
      });
      res.json(result);
    } catch (error) {
      if (error.name === "PowerupDiscardError") {
        const status = error.statusCode || 400;
        return res.status(status).json({ error: error.message });
      }
      console.error("Discard powerup error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /races/:raceId/powerups/:powerupId/open
  router.post("/:raceId/powerups/:powerupId/open", async (req, res) => {
    try {
      const result = await openMysteryBox({
        userId: req.user.id,
        raceId: req.params.raceId,
        powerupId: req.params.powerupId,
        displayName: req.user.displayName,
      });
      res.json({ result });
    } catch (error) {
      if (error.name === "MysteryBoxOpenError") {
        const status = error.statusCode || 400;
        return res.status(status).json({ error: error.message });
      }
      console.error("Open mystery box error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /races/:raceId/inventory
  router.get("/:raceId/inventory", async (req, res) => {
    try {
      const result = await getRaceInventory(req.user.id, req.params.raceId);
      res.json(result);
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error("Get race inventory error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /races/:raceId/feed
  router.get("/:raceId/feed", async (req, res) => {
    try {
      const { cursor, limit } = req.query;
      const result = await getRaceFeed(req.user.id, req.params.raceId, {
        cursor,
        limit: limit ? parseInt(limit, 10) : undefined,
      });
      res.json(result);
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error("Get race feed error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/:raceId/powerups/sneaky-swap-options/:targetUserId", async (req, res) => {
    try {
      const race = await raceModel.findById(req.params.raceId);
      if (!race || race.status !== "ACTIVE") {
        return res.status(400).json({ error: "Race is not active" });
      }
      if (req.params.targetUserId === req.user.id) {
        return res.status(400).json({ error: "You cannot target yourself" });
      }

      const mine = race.participants.find(
        (p) => p.userId === req.user.id && p.status === "ACCEPTED"
      );
      const target = race.participants.find(
        (p) => p.userId === req.params.targetUserId && p.status === "ACCEPTED"
      );
      if (!mine || !target || target.finishedAt) {
        return res.status(400).json({ error: "Target is not an active participant in this race" });
      }

      const targetStealth = await effectModel.findActiveByTypeForParticipant(
        target.id,
        "STEALTH_MODE"
      );
      if (targetStealth) {
        return res.status(400).json({ error: "You cannot target a stealthed player" });
      }

      const [ownPowerups, targetPowerups] = await Promise.all([
        powerupModel.findHeldByParticipant(mine.id),
        powerupModel.findHeldByParticipant(target.id),
      ]);
      const sneakySwap = ownPowerups.find((p) => p.type === "SNEAKY_SWAP");
      if (!sneakySwap) {
        return res.status(400).json({ error: "Sneaky Swap is required" });
      }

      res.json({
        ownPowerups: ownPowerups.filter((p) => p.type !== "SNEAKY_SWAP"),
        targetPowerups,
      });
    } catch (error) {
      console.error("Sneaky swap options error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /races/:raceId/messages
  router.get("/:raceId/messages", async (req, res) => {
    try {
      const { cursor, limit, kind } = req.query;
      const parsedLimit = limit ? Math.min(Number(limit) || 50, 100) : 50;
      // Backward compatible: omit kind => merged feed (legacy clients).
      const parsedKind = kind === "USER" || kind === "SYSTEM" ? kind : undefined;
      const result = await getRaceMessages(req.user.id, req.params.raceId, {
        cursor,
        limit: parsedLimit,
        kind: parsedKind,
      });
      res.json(result);
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error("Get race messages error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /races/:raceId/messages
  router.post("/:raceId/messages", async (req, res) => {
    try {
      const { body } = req.body;
      const message = await sendRaceMessage({
        userId: req.user.id,
        raceId: req.params.raceId,
        body,
      });
      res.status(201).json({ message });
    } catch (error) {
      if (error.name === "RaceMessageError") {
        return res
          .status(error.statusCode || 400)
          .json({ error: error.message });
      }
      console.error("Send race message error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // DELETE /races/:raceId/messages/:messageId
  router.delete("/:raceId/messages/:messageId", async (req, res) => {
    try {
      await deleteRaceMessage({
        userId: req.user.id,
        raceId: req.params.raceId,
        messageId: req.params.messageId,
      });
      res.json({ success: true });
    } catch (error) {
      if (error.name === "DeleteRaceMessageError") {
        return res
          .status(error.statusCode || 400)
          .json({ error: error.message });
      }
      console.error("Delete race message error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PUT /races/:raceId/chat/mute
  router.put("/:raceId/chat/mute", async (req, res) => {
    try {
      const { muted } = req.body;
      await setRaceChatMute({
        userId: req.user.id,
        raceId: req.params.raceId,
        muted: !!muted,
      });
      res.json({ success: true, muted: !!muted });
    } catch (error) {
      if (error.name === "SetRaceChatMuteError") {
        return res
          .status(error.statusCode || 400)
          .json({ error: error.message });
      }
      console.error("Set race chat mute error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /races/:raceId/chat/read
  router.post("/:raceId/chat/read", async (req, res) => {
    try {
      await markRaceChatRead({
        userId: req.user.id,
        raceId: req.params.raceId,
      });
      res.json({ success: true });
    } catch (error) {
      if (error.name === "SetRaceChatMuteError") {
        return res
          .status(error.statusCode || 400)
          .json({ error: error.message });
      }
      console.error("Mark race chat read error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PATCH /races/:raceId
  router.patch("/:raceId", async (req, res) => {
    try {
      const {
        name,
        maxDurationDays,
        isPublic,
        powerupsEnabled,
        powerupStepInterval,
        buyInAmount,
        payoutPreset,
        maxParticipants,
      } = req.body || {};

      const updates = {};
      if (name !== undefined) updates.name = name;
      if (maxDurationDays !== undefined) updates.maxDurationDays = maxDurationDays;
      if (isPublic !== undefined) updates.isPublic = isPublic;
      if (powerupsEnabled !== undefined) updates.powerupsEnabled = powerupsEnabled;
      if (powerupStepInterval !== undefined) updates.powerupStepInterval = powerupStepInterval;
      if (buyInAmount !== undefined) updates.buyInAmount = buyInAmount;
      if (payoutPreset !== undefined) updates.payoutPreset = payoutPreset;
      if (maxParticipants !== undefined) updates.maxParticipants = maxParticipants;

      const race = await editRace({
        userId: req.user.id,
        raceId: req.params.raceId,
        updates,
      });
      res.json({ race });
    } catch (error) {
      if (error.name === "RaceEditError") {
        const status = error.statusCode || 400;
        return res.status(status).json({ error: error.message });
      }
      console.error("Edit race error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // DELETE /races/:raceId
  router.delete("/:raceId", async (req, res) => {
    try {
      await cancelRace({
        userId: req.user.id,
        raceId: req.params.raceId,
      });
      res.json({ success: true });
    } catch (error) {
      if (error.name === "RaceCancelError") {
        const status = error.statusCode || 400;
        return res.status(status).json({ error: error.message });
      }
      console.error("Cancel race error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

module.exports = { createRacesRouter };
