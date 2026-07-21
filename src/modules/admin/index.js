// Public interface of the admin module (audit Phase 9h): the admin router plus
// the admin-identity surface (isAdminUser/withAdminFlag) that routes/auth.js
// stamps onto /auth/me payloads. appSettings deliberately did NOT move here —
// it is shared runtime config (shared/config/appSettings) consumed by race and
// tournament feature gates, merely OPERATED through the admin route.
const { createAdminRouter } = require("./routes");
const { isAdminUser, withAdminFlag } = require("./adminAccess");
const { buildRequireAdmin } = require("./requireAdmin");
const { buildGetAdminStats, getAdminStats } = require("./getAdminStats");

module.exports = {
  createAdminRouter,
  isAdminUser,
  withAdminFlag,
  buildRequireAdmin,
  buildGetAdminStats,
  getAdminStats,
};
