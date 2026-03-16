const { isAdminUser } = require("../services/adminAccess");

function buildRequireAdmin(dependencies = {}) {
  const checkAdmin = dependencies.isAdminUser || isAdminUser;

  return function requireAdmin(req, res, next) {
    if (!req.user || !checkAdmin(req.user)) {
      return res.status(403).json({ error: "Admin access is required" });
    }

    next();
  };
}

module.exports = { buildRequireAdmin };
