const { Stake } = require("../models/stake");

async function getStakeCatalog({ relationshipType } = {}) {
  return Stake.findActive({ relationshipType });
}

module.exports = { getStakeCatalog };
