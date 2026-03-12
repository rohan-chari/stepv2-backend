const { User } = require("../models/user");

async function getUserById(id) {
  return User.findById(id);
}

async function getUserByAppleId(appleId) {
  return User.findByAppleId(appleId);
}

module.exports = { getUserById, getUserByAppleId };
