const { User } = require("../models/user");

async function searchUsersByDisplayName(query, excludeUserId) {
  return User.searchByDisplayName(query, excludeUserId);
}

module.exports = { searchUsersByDisplayName };
