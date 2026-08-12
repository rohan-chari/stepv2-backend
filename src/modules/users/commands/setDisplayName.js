const { User } = require("../models/user");
const { eventBus } = require("../../../shared/events/eventBus");
const {
  validateDiscoverableNameComponent,
  suggestAvailableDisplayName,
} = require("../services/discoverableName");
const { ValidationError } = require("../../../shared/errors/AppError");

class DisplayNameTakenError extends Error {
  constructor(
    message = "That display name is already taken",
    suggestedDisplayName
  ) {
    super(message);
    this.name = "DisplayNameTakenError";
    this.suggestedDisplayName = suggestedDisplayName;
  }
}

function buildSetDisplayName(dependencies = {}) {
  const userModel = dependencies.User || User;

  return async function setDisplayName({
    userId,
    displayName,
    completeDiscoverableNameSetup = false,
  }) {
    let currentUser = null;
    if (completeDiscoverableNameSetup === true) {
      currentUser = await userModel.findById(userId);
      const first = validateDiscoverableNameComponent(currentUser?.firstName, {
        required: true,
        label: "First name",
      });
      const last = validateDiscoverableNameComponent(currentUser?.lastName, {
        required: false,
        label: "Last name",
      });
      if (!first.valid || !last.valid || !currentUser?.discoverableNameSearch) {
        throw new ValidationError(
          "Add a valid discoverable name before completing setup",
          "DISCOVERABLE_NAME_REQUIRED"
        );
      }
    }

    if (displayName != null) {
      const existing = await userModel.findByDisplayNameInsensitive(
        displayName,
        userId
      );
      if (existing) {
        let suggestedDisplayName;
        if (completeDiscoverableNameSetup === true && currentUser) {
          suggestedDisplayName = await suggestAvailableDisplayName({
            firstName: currentUser.firstName,
            lastName: currentUser.lastName,
            userModel,
            excludeUserId: userId,
          });
        }
        throw new DisplayNameTakenError(
          "That display name is already taken",
          suggestedDisplayName
        );
      }
    }

    try {
      const updatedUser = await userModel.update(userId, {
        displayName,
        ...(completeDiscoverableNameSetup === true
          ? { nameSetupCompletedAt: new Date() }
          : {}),
      });
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
        let suggestedDisplayName;
        if (completeDiscoverableNameSetup === true && currentUser) {
          suggestedDisplayName = await suggestAvailableDisplayName({
            firstName: currentUser.firstName,
            lastName: currentUser.lastName,
            userModel,
            excludeUserId: userId,
          });
        }
        throw new DisplayNameTakenError(
          "That display name is already taken",
          suggestedDisplayName
        );
      }
      throw error;
    }
  };
}

const setDisplayName = buildSetDisplayName();

module.exports = { buildSetDisplayName, setDisplayName, DisplayNameTakenError };
