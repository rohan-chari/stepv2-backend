const { Router } = require("express");
const { buildRequireAuth } = require("../middleware/requireAuth");
const { buildTournamentShareUrl } = require("../config/sharing");

const { createTournament: defaultCreateTournament } = require("../commands/createTournament");
const { joinTournament: defaultJoinTournament } = require("../commands/joinTournament");
const {
  joinTournamentByShareToken: defaultJoinByShareToken,
} = require("../commands/joinTournamentByShareToken");
const {
  respondToTournamentInvite: defaultRespond,
} = require("../commands/respondToTournamentInvite");
const { inviteToTournament: defaultInvite } = require("../commands/inviteToTournament");
const { leaveTournament: defaultLeave } = require("../commands/leaveTournament");
const {
  kickTournamentParticipant: defaultKick,
} = require("../commands/kickTournamentParticipant");
const { startTournament: defaultStart } = require("../commands/startTournament");
const { forfeitTournament: defaultForfeit } = require("../commands/forfeitTournament");
const { cancelTournament: defaultCancel } = require("../commands/cancelTournament");
const {
  createTournamentShareLink: defaultCreateShareLink,
} = require("../commands/createTournamentShareLink");
const { getTournament: defaultGetTournament } = require("../queries/getTournament");
const {
  getPublicTournaments: defaultGetPublicTournaments,
} = require("../queries/getPublicTournaments");
const {
  getSharedTournamentPreview: defaultGetSharedPreview,
} = require("../queries/getSharedTournamentPreview");

// Serialize a TournamentError (or unknown) into the { error, code } shape old
// clients read `error` and new clients branch on `code`.
function sendError(res, error, logLabel) {
  if (error && error.name === "TournamentError") {
    const status = error.statusCode || 400;
    return res
      .status(status)
      .json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
  }
  console.error(`${logLabel}:`, error);
  return res.status(500).json({ error: "Internal server error" });
}

function createTournamentsRouter(dependencies = {}) {
  const router = Router();
  const requireAuth = dependencies.requireAuth || buildRequireAuth(dependencies);

  const createTournament = dependencies.createTournament || defaultCreateTournament;
  const joinTournament = dependencies.joinTournament || defaultJoinTournament;
  const joinTournamentByShareToken =
    dependencies.joinTournamentByShareToken || defaultJoinByShareToken;
  const respondToTournamentInvite = dependencies.respondToTournamentInvite || defaultRespond;
  const inviteToTournament = dependencies.inviteToTournament || defaultInvite;
  const leaveTournament = dependencies.leaveTournament || defaultLeave;
  const kickTournamentParticipant = dependencies.kickTournamentParticipant || defaultKick;
  const startTournament = dependencies.startTournament || defaultStart;
  const forfeitTournament = dependencies.forfeitTournament || defaultForfeit;
  const cancelTournament = dependencies.cancelTournament || defaultCancel;
  const createTournamentShareLink =
    dependencies.createTournamentShareLink || defaultCreateShareLink;
  const getTournament = dependencies.getTournament || defaultGetTournament;
  const getPublicTournaments = dependencies.getPublicTournaments || defaultGetPublicTournaments;
  const getSharedTournamentPreview =
    dependencies.getSharedTournamentPreview || defaultGetSharedPreview;

  const supportsCharacters = (req) => req.clientFeatures?.has("characters") ?? false;

  // GET /tournaments/share/:token — PUBLIC preview, declared before requireAuth.
  router.get("/share/:token", async (req, res) => {
    try {
      const preview = await getSharedTournamentPreview({ token: req.params.token });
      if (!preview) {
        return res.status(404).json({ error: "Tournament not found" });
      }
      res.json({ tournament: preview });
    } catch (error) {
      sendError(res, error, "Get shared tournament preview error");
    }
  });

  router.use(requireAuth);

  // POST /tournaments — create
  router.post("/", async (req, res) => {
    try {
      const {
        name,
        bracketSize,
        matchupDurationDays,
        buyInAmount,
        powerupsEnabled,
        powerupStepInterval,
        isPublic,
        inviteeIds,
      } = req.body || {};
      const tournament = await createTournament({
        userId: req.user.id,
        name,
        bracketSize,
        matchupDurationDays,
        buyInAmount,
        powerupsEnabled,
        powerupStepInterval,
        isPublic,
        inviteeIds,
        timeZone: req.timeZone,
        clientFeatures: req.clientFeatures,
        supportsCharacters: supportsCharacters(req),
      });
      res.status(201).json({ tournament });
    } catch (error) {
      sendError(res, error, "Create tournament error");
    }
  });

  // GET /tournaments/public — featured + user-created public listings
  router.get("/public", async (req, res) => {
    try {
      const result = await getPublicTournaments({ userId: req.user.id });
      res.json(result);
    } catch (error) {
      sendError(res, error, "Get public tournaments error");
    }
  });

  // POST /tournaments/share/:token/join — share-link join (distinct segment count
  // from /:id/join, so no route collision)
  router.post("/share/:token/join", async (req, res) => {
    try {
      const tournament = await joinTournamentByShareToken({
        userId: req.user.id,
        token: req.params.token,
        clientFeatures: req.clientFeatures,
        supportsCharacters: supportsCharacters(req),
      });
      res.status(201).json({ tournament });
    } catch (error) {
      sendError(res, error, "Join tournament by share token error");
    }
  });

  // POST /tournaments/:id/join — public join
  router.post("/:id/join", async (req, res) => {
    try {
      const tournament = await joinTournament({
        userId: req.user.id,
        tournamentId: req.params.id,
        clientFeatures: req.clientFeatures,
        supportsCharacters: supportsCharacters(req),
      });
      res.status(201).json({ tournament });
    } catch (error) {
      sendError(res, error, "Join tournament error");
    }
  });

  // PUT /tournaments/:id/respond — invite accept/decline
  router.put("/:id/respond", async (req, res) => {
    try {
      const tournament = await respondToTournamentInvite({
        userId: req.user.id,
        tournamentId: req.params.id,
        accept: req.body ? req.body.accept : true,
        clientFeatures: req.clientFeatures,
        supportsCharacters: supportsCharacters(req),
      });
      res.json({ tournament });
    } catch (error) {
      sendError(res, error, "Respond to tournament invite error");
    }
  });

  // POST /tournaments/:id/invite — creator lobby invites
  router.post("/:id/invite", async (req, res) => {
    try {
      const result = await inviteToTournament({
        userId: req.user.id,
        tournamentId: req.params.id,
        userIds: (req.body && req.body.userIds) || [],
        supportsCharacters: supportsCharacters(req),
      });
      res.json(result);
    } catch (error) {
      sendError(res, error, "Invite to tournament error");
    }
  });

  // POST /tournaments/:id/leave
  router.post("/:id/leave", async (req, res) => {
    try {
      const tournament = await leaveTournament({
        userId: req.user.id,
        tournamentId: req.params.id,
        supportsCharacters: supportsCharacters(req),
      });
      res.json({ tournament });
    } catch (error) {
      sendError(res, error, "Leave tournament error");
    }
  });

  // POST /tournaments/:id/kick — creator-only
  router.post("/:id/kick", async (req, res) => {
    try {
      const tournament = await kickTournamentParticipant({
        userId: req.user.id,
        tournamentId: req.params.id,
        targetUserId: req.body && req.body.userId,
        supportsCharacters: supportsCharacters(req),
      });
      res.json({ tournament });
    } catch (error) {
      sendError(res, error, "Kick tournament participant error");
    }
  });

  // POST /tournaments/:id/start — creator-only
  router.post("/:id/start", async (req, res) => {
    try {
      const tournament = await startTournament({
        userId: req.user.id,
        tournamentId: req.params.id,
        supportsCharacters: supportsCharacters(req),
      });
      res.json({ tournament });
    } catch (error) {
      sendError(res, error, "Start tournament error");
    }
  });

  // POST /tournaments/:id/forfeit
  router.post("/:id/forfeit", async (req, res) => {
    try {
      const tournament = await forfeitTournament({
        userId: req.user.id,
        tournamentId: req.params.id,
        supportsCharacters: supportsCharacters(req),
      });
      res.json({ tournament });
    } catch (error) {
      sendError(res, error, "Forfeit tournament error");
    }
  });

  // POST /tournaments/:id/share-link
  router.post("/:id/share-link", async (req, res) => {
    try {
      const { shareToken } = await createTournamentShareLink({
        userId: req.user.id,
        tournamentId: req.params.id,
      });
      res.status(201).json({ shareToken, url: buildTournamentShareUrl(shareToken) });
    } catch (error) {
      sendError(res, error, "Create tournament share link error");
    }
  });

  // DELETE /tournaments/:id — cancel (creator, PENDING only)
  router.delete("/:id", async (req, res) => {
    try {
      const result = await cancelTournament({
        userId: req.user.id,
        tournamentId: req.params.id,
      });
      res.json(result);
    } catch (error) {
      sendError(res, error, "Cancel tournament error");
    }
  });

  // GET /tournaments/:id — full payload (declared after the static paths above)
  router.get("/:id", async (req, res) => {
    try {
      const tournament = await getTournament({
        userId: req.user.id,
        tournamentId: req.params.id,
        supportsCharacters: supportsCharacters(req),
      });
      res.json({ tournament });
    } catch (error) {
      sendError(res, error, "Get tournament error");
    }
  });

  return router;
}

module.exports = { createTournamentsRouter };
