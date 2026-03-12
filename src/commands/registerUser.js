const { ensureAppleUser } = require("../services/ensureAppleUser");

async function registerUser({ appleId, email, name }) {
  return ensureAppleUser({
    appleId,
    email,
    name,
    emitSignInEvent: true,
  });
}

module.exports = { registerUser };
