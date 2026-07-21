function parseList(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => entry.toLowerCase())
  );
}

function isAdminUser(user, env = process.env) {
  if (!user) return false;

  const userIds = parseList(env.ADMIN_USER_IDS);
  const appleIds = parseList(env.ADMIN_APPLE_IDS);
  const emails = parseList(env.ADMIN_EMAILS);

  if (user.id && userIds.has(String(user.id).toLowerCase())) return true;
  if (user.appleId && appleIds.has(String(user.appleId).toLowerCase())) {
    return true;
  }
  if (user.email && emails.has(String(user.email).toLowerCase())) return true;

  return false;
}

function withAdminFlag(user, check = isAdminUser) {
  return {
    ...user,
    isAdmin: check(user),
  };
}

module.exports = { isAdminUser, withAdminFlag };
