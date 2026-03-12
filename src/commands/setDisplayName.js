const { User } = require("../models/user");
const { eventBus } = require("../events/eventBus");

class DisplayNameTakenError extends Error {
  constructor(message = "That display name is already taken") {
    super(message);
    this.name = "DisplayNameTakenError";
  }
}

async function setDisplayName({ userId, displayName }) {
  try {
    const updatedUser = await User.update(userId, { displayName });
    eventBus.emit("DISPLAY_NAME_SET", { userId, displayName });
    return updatedUser;
  } catch (error) {
    if (
      error.code === "P2002" &&
      error.meta?.target?.includes("display_name")
    ) {
      throw new DisplayNameTakenError();
    }
    throw error;
  }
}

module.exports = { setDisplayName, DisplayNameTakenError };
