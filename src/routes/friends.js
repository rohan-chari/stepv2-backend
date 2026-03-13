const { Router } = require("express");
const { buildRequireAppleAuth } = require("../middleware/requireAppleAuth");
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

function createFriendsRouter(dependencies = {}) {
  const router = Router();
  const requireAppleAuth =
    dependencies.requireAppleAuth || buildRequireAppleAuth(dependencies);
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

  router.use(requireAppleAuth);

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
      const date = req.query.date || new Date().toISOString().slice(0, 10);
      const friends = await getFriendsWithSteps(req.user.id, date);
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
      const { accept } = req.body;

      const friendship = await respondToRequest({
        userId: req.user.id,
        friendshipId: req.params.friendshipId,
        accept,
      });

      res.json({ friendship });
    } catch (error) {
      if (error.name === "FriendResponseError") {
        return res.status(409).json({ error: error.message });
      }

      console.error("Friend response error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

module.exports = { createFriendsRouter };
