const { Router } = require("express");
const { buildRequireAuth } = require("../../middleware/requireAuth");
const { buildTournamentShareUrl } = require("../web").sharing;
const { asyncHandler } = require("../../shared/http/asyncHandler");

const { createTournament: defaultCreateTournament } = require("./commands/createTournament");
const { joinTournament: defaultJoinTournament } = require("./commands/joinTournament");
const {
  joinTournamentByShareToken: defaultJoinByShareToken,
} = require("./commands/joinTournamentByShareToken");
const {
  respondToTournamentInvite: defaultRespond,
} = require("./commands/respondToTournamentInvite");
const { inviteToTournament: defaultInvite } = require("./commands/inviteToTournament");
const { leaveTournament: defaultLeave } = require("./commands/leaveTournament");
const {
  kickTournamentParticipant: defaultKick,
} = require("./commands/kickTournamentParticipant");
const { startTournament: defaultStart } = require("./commands/startTournament");
const { forfeitTournament: defaultForfeit } = require("./commands/forfeitTournament");
const { cancelTournament: defaultCancel } = require("./commands/cancelTournament");
const {
  createTournamentShareLink: defaultCreateShareLink,
} = require("./commands/createTournamentShareLink");
const { getTournament: defaultGetTournament } = require("./queries/getTournament");
const {
  getTournamentDetail: defaultGetTournamentDetail,
} = require("./queries/getTournamentDetail");
const {
  getTournamentActionWallet: defaultGetTournamentActionWallet,
} = require("./queries/getTournamentActionWallet");
const {
  getPublicTournaments: defaultGetPublicTournaments,
} = require("./queries/getPublicTournaments");
const {
  getSharedTournamentPreview: defaultGetSharedPreview,
} = require("./queries/getSharedTournamentPreview");
const { appSettings: defaultAppSettings } = require("../../shared/config/appSettings");
const {
  isStrictFlagEnabled,
} = require("../../shared/config/isStrictFlagEnabled");

// Error serialization (the { error, code } shape old clients read `error` from
// and new clients branch on `code`) is handled centrally: TournamentError is an
// AppError subclass, thrown errors flow through asyncHandler → the shared
// errorMiddleware mounted last in app.js.

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
  const getTournamentDetail =
    dependencies.getTournamentDetail || defaultGetTournamentDetail;
  const settings = dependencies.appSettings || defaultAppSettings;
  const logger = dependencies.logger || console;
  const getTournamentActionWallet =
    dependencies.getTournamentActionWallet || defaultGetTournamentActionWallet;
  const getPublicTournaments = dependencies.getPublicTournaments || defaultGetPublicTournaments;
  const getSharedTournamentPreview =
    dependencies.getSharedTournamentPreview || defaultGetSharedPreview;

  const supportsCharacters = (req) =>
    req.clientFeatures?.has("characters") ?? false;
  const supportsRemoteAssets = (req) =>
    req.clientFeatures?.has("remote_assets") ?? false;

  async function compactRequested(req) {
    return (
      req.query.view === "detail-v1" &&
      (await isStrictFlagEnabled(settings, "apiTournamentDetailV1Enabled"))
    );
  }

  async function projectAfterCommit(userId, tournamentId) {
    try {
      return {
        tournament: await getTournamentDetail({ userId, tournamentId }),
        projectionError: null,
      };
    } catch (error) {
      logger.error(JSON.stringify({
        event: "tournament_action_enrichment",
        operation: "detail_projection",
        outcome: "unavailable",
        errorCode: error?.code || "DETAIL_UNAVAILABLE",
      }));
      return {
        tournament: null,
        projectionError: { code: "DETAIL_UNAVAILABLE" },
      };
    }
  }

  async function walletAfterCommit(userId) {
    try {
      return {
        wallet: await getTournamentActionWallet(userId),
        walletError: null,
      };
    } catch (error) {
      logger.error(JSON.stringify({
        event: "tournament_action_enrichment",
        operation: "wallet_projection",
        outcome: "unavailable",
        errorCode: error?.code || "WALLET_UNAVAILABLE",
      }));
      return {
        wallet: null,
        walletError: { code: "WALLET_UNAVAILABLE" },
      };
    }
  }

  async function detailAndWalletAfterCommit(userId, tournamentId) {
    const [detail, wallet] = await Promise.all([
      projectAfterCommit(userId, tournamentId),
      walletAfterCommit(userId),
    ]);
    return { ...detail, ...wallet };
  }

  // GET /tournaments/share/:token — PUBLIC preview, declared before requireAuth.
  router.get(
    "/share/:token",
    asyncHandler(async (req, res) => {
      const preview = await getSharedTournamentPreview({ token: req.params.token });
      if (!preview) {
        return res.status(404).json({ error: "Tournament not found" });
      }
      res.json({ tournament: preview });
    })
  );

  router.use(requireAuth);

  // POST /tournaments — create
  router.post(
    "/",
    asyncHandler(async (req, res) => {
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
        supportsRemoteAssets: supportsRemoteAssets(req),
      });
      res.status(201).json({ tournament });
    })
  );

  // GET /tournaments/public — featured + user-created public listings
  router.get(
    "/public",
    asyncHandler(async (req, res) => {
      const result = await getPublicTournaments({ userId: req.user.id });
      res.json(result);
    })
  );

  // POST /tournaments/share/:token/join — share-link join (distinct segment count
  // from /:id/join, so no route collision)
  router.post(
    "/share/:token/join",
    asyncHandler(async (req, res) => {
      const compact = await compactRequested(req);
      const tournament = await joinTournamentByShareToken({
        userId: req.user.id,
        token: req.params.token,
        clientFeatures: req.clientFeatures,
        supportsCharacters: supportsCharacters(req),
        supportsRemoteAssets: supportsRemoteAssets(req),
      });
      if (compact) {
        return res.status(201).json({
          contract: "tournament-action-v1",
          ...(await detailAndWalletAfterCommit(
            req.user.id,
            tournament.id
          )),
        });
      }
      res.status(201).json({ tournament });
    })
  );

  // POST /tournaments/:id/join — public join
  router.post(
    "/:id/join",
    asyncHandler(async (req, res) => {
      const compact = await compactRequested(req);
      const tournament = await joinTournament({
        userId: req.user.id,
        tournamentId: req.params.id,
        clientFeatures: req.clientFeatures,
        supportsCharacters: supportsCharacters(req),
        supportsRemoteAssets: supportsRemoteAssets(req),
      });
      if (compact) {
        return res.status(201).json({
          contract: "tournament-action-v1",
          ...(await detailAndWalletAfterCommit(
            req.user.id,
            tournament.id
          )),
        });
      }
      res.status(201).json({ tournament });
    })
  );

  // PUT /tournaments/:id/respond — invite accept/decline
  router.put(
    "/:id/respond",
    asyncHandler(async (req, res) => {
      const compact = await compactRequested(req);
      const accept = req.body ? req.body.accept : true;
      const tournament = await respondToTournamentInvite({
        userId: req.user.id,
        tournamentId: req.params.id,
        accept,
        clientFeatures: req.clientFeatures,
        supportsCharacters: supportsCharacters(req),
        supportsRemoteAssets: supportsRemoteAssets(req),
      });
      if (compact) {
        return res.json({
          contract: "tournament-action-v1",
          ...(accept === false
            ? await walletAfterCommit(req.user.id)
            : await detailAndWalletAfterCommit(
                req.user.id,
                tournament.id
              )),
        });
      }
      res.json({ tournament });
    })
  );

  // POST /tournaments/:id/invite — creator lobby invites
  router.post(
    "/:id/invite",
    asyncHandler(async (req, res) => {
      const compact = await compactRequested(req);
      const result = await inviteToTournament({
        userId: req.user.id,
        tournamentId: req.params.id,
        userIds: (req.body && req.body.userIds) || [],
        supportsCharacters: supportsCharacters(req),
        supportsRemoteAssets: supportsRemoteAssets(req),
      });
      if (compact) {
        return res.json({
          contract: "tournament-action-v1",
          ...(await projectAfterCommit(req.user.id, req.params.id)),
          invited: result.invited,
          needsUpdate: result.needsUpdate,
        });
      }
      res.json(result);
    })
  );

  // POST /tournaments/:id/leave
  router.post(
    "/:id/leave",
    asyncHandler(async (req, res) => {
      const compact = await compactRequested(req);
      const tournament = await leaveTournament({
        userId: req.user.id,
        tournamentId: req.params.id,
        supportsCharacters: supportsCharacters(req),
        supportsRemoteAssets: supportsRemoteAssets(req),
      });
      if (compact) {
        return res.json({
          contract: "tournament-action-v1",
          ...(await walletAfterCommit(req.user.id)),
        });
      }
      res.json({ tournament });
    })
  );

  // POST /tournaments/:id/kick — creator-only
  router.post(
    "/:id/kick",
    asyncHandler(async (req, res) => {
      const compact = await compactRequested(req);
      const tournament = await kickTournamentParticipant({
        userId: req.user.id,
        tournamentId: req.params.id,
        targetUserId: req.body && req.body.userId,
        supportsCharacters: supportsCharacters(req),
        supportsRemoteAssets: supportsRemoteAssets(req),
      });
      if (compact) {
        return res.json({
          contract: "tournament-action-v1",
          ...(await projectAfterCommit(req.user.id, req.params.id)),
        });
      }
      res.json({ tournament });
    })
  );

  // POST /tournaments/:id/start — creator-only
  router.post(
    "/:id/start",
    asyncHandler(async (req, res) => {
      const compact = await compactRequested(req);
      const tournament = await startTournament({
        userId: req.user.id,
        tournamentId: req.params.id,
        supportsCharacters: supportsCharacters(req),
        supportsRemoteAssets: supportsRemoteAssets(req),
      });
      if (compact) {
        return res.json({
          contract: "tournament-action-v1",
          ...(await projectAfterCommit(req.user.id, req.params.id)),
        });
      }
      res.json({ tournament });
    })
  );

  // POST /tournaments/:id/forfeit
  router.post(
    "/:id/forfeit",
    asyncHandler(async (req, res) => {
      const compact = await compactRequested(req);
      const tournament = await forfeitTournament({
        userId: req.user.id,
        tournamentId: req.params.id,
        supportsCharacters: supportsCharacters(req),
        supportsRemoteAssets: supportsRemoteAssets(req),
      });
      if (compact) {
        return res.json({
          contract: "tournament-action-v1",
          ...(await projectAfterCommit(req.user.id, req.params.id)),
        });
      }
      res.json({ tournament });
    })
  );

  // POST /tournaments/:id/share-link
  router.post(
    "/:id/share-link",
    asyncHandler(async (req, res) => {
      const { shareToken } = await createTournamentShareLink({
        userId: req.user.id,
        tournamentId: req.params.id,
      });
      res.status(201).json({ shareToken, url: buildTournamentShareUrl(shareToken) });
    })
  );

  // DELETE /tournaments/:id — cancel (creator, PENDING only)
  router.delete(
    "/:id",
    asyncHandler(async (req, res) => {
      const compact = await compactRequested(req);
      const result = await cancelTournament({
        userId: req.user.id,
        tournamentId: req.params.id,
      });
      if (compact) {
        return res.json({
          contract: "tournament-action-v1",
          success: true,
          ...(await walletAfterCommit(req.user.id)),
        });
      }
      res.json(result);
    })
  );

  // GET /tournaments/:id — full payload (declared after the static paths above)
  router.get(
    "/:id",
    asyncHandler(async (req, res) => {
      const compact =
        req.query.view === "detail-v1" &&
        (await isStrictFlagEnabled(settings, "apiTournamentDetailV1Enabled"));
      if (compact) {
        const tournament = await getTournamentDetail({
          userId: req.user.id,
          tournamentId: req.params.id,
        });
        return res.json({ contract: "tournament-detail-v1", tournament });
      }
      const tournament = await getTournament({
        userId: req.user.id,
        tournamentId: req.params.id,
        supportsCharacters: supportsCharacters(req),
        supportsRemoteAssets: supportsRemoteAssets(req),
      });
      res.json({ tournament });
    })
  );

  return router;
}

module.exports = { createTournamentsRouter };
