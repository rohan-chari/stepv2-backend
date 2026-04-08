const { User } = require("../models/user");
const {
  profilePhotoStorage,
} = require("../services/profilePhotoStorage");

class InvalidProfilePhotoError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidProfilePhotoError";
  }
}

function buildCreateProfilePhotoUpload(dependencies = {}) {
  const storage = dependencies.profilePhotoStorage || profilePhotoStorage;

  return async function createProfilePhotoUpload({ userId, contentType }) {
    return storage.createUpload({ userId, contentType });
  };
}

function buildSetProfilePhoto(dependencies = {}) {
  const userModel = dependencies.User || User;
  const storage = dependencies.profilePhotoStorage || profilePhotoStorage;
  const logger = dependencies.logger || console;

  return async function setProfilePhoto({ userId, key, url }) {
    const user = await userModel.findById(userId);

    if (!user) {
      throw new InvalidProfilePhotoError("User not found");
    }

    if (!storage.validateManagedUpload({ userId, key, url })) {
      throw new InvalidProfilePhotoError(
        "Profile photo upload does not belong to this user"
      );
    }

    const previousKey = user.profilePhotoKey;
    const updatedUser = await userModel.update(userId, {
      profilePhotoKey: key,
      profilePhotoUrl: url,
      profilePhotoPromptDismissedAt: null,
    });

    if (previousKey && previousKey !== key) {
      try {
        await storage.deleteObject(previousKey);
      } catch (error) {
        logger.warn(
          `Failed to delete old profile photo for user ${userId}: ${error.message || error}`
        );
      }
    }

    return updatedUser;
  };
}

function buildRemoveProfilePhoto(dependencies = {}) {
  const userModel = dependencies.User || User;
  const storage = dependencies.profilePhotoStorage || profilePhotoStorage;
  const logger = dependencies.logger || console;

  return async function removeProfilePhoto({ userId }) {
    const user = await userModel.findById(userId);

    if (!user || !user.profilePhotoKey) {
      return {
        ...(user || { id: userId }),
        profilePhotoKey: null,
        profilePhotoUrl: null,
      };
    }

    const updatedUser = await userModel.update(userId, {
      profilePhotoKey: null,
      profilePhotoUrl: null,
    });

    try {
      await storage.deleteObject(user.profilePhotoKey);
    } catch (error) {
      logger.warn(
        `Failed to delete removed profile photo for user ${userId}: ${error.message || error}`
      );
    }

    return updatedUser;
  };
}

function buildDismissProfilePhotoPrompt(dependencies = {}) {
  const userModel = dependencies.User || User;
  const now = dependencies.now || (() => new Date());

  return async function dismissProfilePhotoPrompt({ userId }) {
    return userModel.update(userId, {
      profilePhotoPromptDismissedAt: now(),
    });
  };
}

const createProfilePhotoUpload = buildCreateProfilePhotoUpload();
const setProfilePhoto = buildSetProfilePhoto();
const removeProfilePhoto = buildRemoveProfilePhoto();
const dismissProfilePhotoPrompt = buildDismissProfilePhotoPrompt();

module.exports = {
  InvalidProfilePhotoError,
  buildCreateProfilePhotoUpload,
  buildSetProfilePhoto,
  buildRemoveProfilePhoto,
  buildDismissProfilePhotoPrompt,
  createProfilePhotoUpload,
  setProfilePhoto,
  removeProfilePhoto,
  dismissProfilePhotoPrompt,
};
