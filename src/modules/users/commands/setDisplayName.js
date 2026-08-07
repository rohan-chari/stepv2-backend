const { User } = require("../models/user");
const { eventBus } = require("../../../shared/events/eventBus");

class DisplayNameTakenError extends Error {
  constructor(message = "That display name is already taken") {
    super(message);
    this.name = "DisplayNameTakenError";
  }
}

async function setDisplayName({ userId, displayName }) {
  if (displayName != null) {
    const existing = await User.findByDisplayNameInsensitive(displayName, userId);
    if (existing) {
      throw new DisplayNameTakenError();
    }
  }

  try {
    const updatedUser = await User.update(userId, { displayName });
    // C2 invalidation (spec §3 `v1:user:{id}:cosmetics`): the per-user
    // presentation bundle chat hydrates from carries displayName, so a rename
    // must drop it — otherwise the old name renders on every cached chat page
    // for up to the 1h TTL.
    try {
      const {
        invalidate,
      } = require("../../social/services/userPresentationCache");
      await invalidate(userId);
    } catch {}
    eventBus.emit("DISPLAY_NAME_SET", { userId, displayName });
    return updatedUser;
  } catch (error) {
    if (
      error.code === "P2002" &&
      (error.meta?.target?.includes("display_name") ||
        error.meta?.target?.includes("displayName"))
    ) {
      throw new DisplayNameTakenError();
    }
    throw error;
  }
}

module.exports = { setDisplayName, DisplayNameTakenError };
