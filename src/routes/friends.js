const { Router } = require("express");
const { buildRequireAuth } = require("../middleware/requireAuth");
const {
  sendFriendRequest: defaultSendFriendRequest,
} = require("../commands/sendFriendRequest");
const {
  respondToFriendRequest: defaultRespondToFriendRequest,
} = require("../commands/respondToFriendRequest");
const {
  getFriendsList: defaultGetFriendsList,
  getPendingRequests: defaultGetPendingRequests,
  getFriendsWithSteps: defaultGetFriendsWithSteps,
} = require("../queries/getFriends");
const {
  searchUsersByDisplayName: defaultSearchUsersByDisplayName,
} = require("../queries/searchUsers");
const {
  updateRelationshipType: defaultUpdateRelationshipType,
} = require("../commands/updateRelationshipType");
const { stepSyncPushService } = require("../services/stepSyncPush");

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

function createFriendsRouter(dependencies = {}) {
  const router = Router();
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);
  const searchUsers =
    dependencies.searchUsersByDisplayName || defaultSearchUsersByDisplayName;
  const getFriends = dependencies.getFriendsList || defaultGetFriendsList;
  const getPending =
    dependencies.getPendingRequests || defaultGetPendingRequests;
  const sendRequest =
    dependencies.sendFriendRequest || defaultSendFriendRequest;
  const respondToRequest =
    dependencies.respondToFriendRequest || defaultRespondToFriendRequest;
  const getFriendsWithSteps =
    dependencies.getFriendsWithSteps || defaultGetFriendsWithSteps;
  const updateRelationType =
    dependencies.updateRelationshipType || defaultUpdateRelationshipType;
  const requestStepSyncForUsers =
    dependencies.requestStepSyncForUsers ||
    stepSyncPushService.requestStepSyncForUsers;
  const logger = dependencies.logger || console;

  router.use(requireAuth);

  // GET /friends/search?q=
  router.get("/search", async (req, res) => {
    try {
      const { q } = req.query;

      if (!q || !q.trim()) {
        return res.status(400).json({ error: "Search query is required" });
      }

      const users = await searchUsers(q.trim(), req.user.id);
      res.json({ users });
    } catch (error) {
      console.error("Search error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /friends/steps?date=YYYY-MM-DD
  router.get("/steps", async (req, res) => {
    try {
      const date = req.query.date || todayDateString();
      const friends = await getFriendsWithSteps(req.user.id, date);

      if (date === todayDateString() && friends.length > 0) {
        Promise.resolve()
          .then(() => requestStepSyncForUsers(friends.map((friend) => friend.id)))
          .catch((error) => {
            logger.error("Friends step sync request error:", error);
          });
      }

      res.json({ friends });
    } catch (error) {
      console.error("Friends steps error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /friends
  router.get("/", async (req, res) => {
    try {
      const [friends, pending] = await Promise.all([
        getFriends(req.user.id),
        getPending(req.user.id),
      ]);

      res.json({ friends, pending });
    } catch (error) {
      console.error("Friends list error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /friends/request
  router.post("/request", async (req, res) => {
    try {
      if (!req.user.displayName) {
        return res
          .status(403)
          .json({ error: "You must set a display name before adding friends" });
      }

      const { addresseeId } = req.body;

      if (!addresseeId) {
        return res.status(400).json({ error: "addresseeId is required" });
      }

      const friendship = await sendRequest({
        userId: req.user.id,
        addresseeId,
      });

      res.status(201).json({ friendship });
    } catch (error) {
      if (error.name === "FriendRequestError") {
        return res.status(409).json({ error: error.message });
      }

      console.error("Friend request error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PUT /friends/request/:friendshipId
  router.put("/request/:friendshipId", async (req, res) => {
    try {
      const { accept, relationshipType } = req.body;

      const payload = {
        userId: req.user.id,
        friendshipId: req.params.friendshipId,
        accept,
        ...(relationshipType !== undefined && { relationshipType }),
      };

      const friendship = await respondToRequest(payload);

      res.json({ friendship });
    } catch (error) {
      if (error.name === "FriendResponseError") {
        return res.status(409).json({ error: error.message });
      }
      if (error.name === "ValidationError") {
        return res.status(400).json({ error: error.message });
      }

      console.error("Friend response error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PUT /friends/:friendshipId/relationship-type
  router.put("/:friendshipId/relationship-type", async (req, res) => {
    try {
      const { relationshipType } = req.body;
      const validTypes = ["partner", "friend", "family"];

      if (!relationshipType || !validTypes.includes(relationshipType)) {
        return res.status(400).json({
          error: "relationshipType must be one of: partner, friend, family",
        });
      }

      const friendship = await updateRelationType({
        userId: req.user.id,
        friendshipId: req.params.friendshipId,
        relationshipType,
      });

      res.json({ friendship });
    } catch (error) {
      if (error.name === "RelationshipTypeError") {
        const status = error.statusCode || 400;
        return res.status(status).json({ error: error.message });
      }

      console.error("Relationship type error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

module.exports = { createFriendsRouter };
