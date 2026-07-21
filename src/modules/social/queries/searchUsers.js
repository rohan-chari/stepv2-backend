const { User } = require("../../users");

async function searchUsersByDisplayName(query, excludeUserId) {
  return User.searchByDisplayName(query, excludeUserId);
}

module.exports = { searchUsersByDisplayName };
