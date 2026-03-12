const { Steps } = require("../models/steps");

async function getStepsByDate(userId, date) {
  return Steps.findByUserIdAndDate(userId, date);
}

async function getStepsHistory(userId) {
  return Steps.findByUserId(userId);
}

module.exports = { getStepsByDate, getStepsHistory };
