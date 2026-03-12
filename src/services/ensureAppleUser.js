const { eventBus } = require("../events/eventBus");
const { User } = require("../models/user");

function buildEnsureAppleUser(dependencies = {}) {
  const userModel = dependencies.User || User;
  const events = dependencies.eventBus || eventBus;

  return async function ensureAppleUser({
    appleId,
    email,
    name,
    emitSignInEvent = false,
  }) {
    let user = await userModel.findByAppleId(appleId);

    if (!user) {
      user = await userModel.create({
        appleId,
        email: email || null,
        name: name || null,
      });

      events.emit("USER_REGISTERED", {
        userId: user.id,
        appleId,
      });
    } else {
      const fieldsToUpdate = {};

      if (email && email !== user.email) {
        fieldsToUpdate.email = email;
      }

      if (name && name !== user.name) {
        fieldsToUpdate.name = name;
      }

      if (Object.keys(fieldsToUpdate).length > 0) {
        user = await userModel.update(user.id, fieldsToUpdate);
      }
    }

    if (emitSignInEvent) {
      events.emit("USER_SIGNED_IN", { userId: user.id });
    }

    return user;
  };
}

const ensureAppleUser = buildEnsureAppleUser();

module.exports = { buildEnsureAppleUser, ensureAppleUser };
