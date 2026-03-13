const { User } = require("../models/user");
const { eventBus } = require("../events/eventBus");

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
