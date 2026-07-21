// Step-milestone daily rewards. Each threshold is independently claimable
// once per local date. Tapping the claim button on the home tab awards
// the listed coin amount. Reaching all four thresholds in one day grants
// the maximum 110 coins.
const STEP_MILESTONE_THRESHOLDS = [
  { steps: 5000, coins: 10 },
  { steps: 10000, coins: 20 },
  { steps: 15000, coins: 30 },
  { steps: 20000, coins: 50 },
];

const MILESTONE_DAILY_CAP = STEP_MILESTONE_THRESHOLDS.reduce(
  (sum, t) => sum + t.coins,
  0
);

function findMilestoneByThreshold(threshold) {
  return STEP_MILESTONE_THRESHOLDS.find((t) => t.steps === threshold) || null;
}

module.exports = {
  STEP_MILESTONE_THRESHOLDS,
  MILESTONE_DAILY_CAP,
  findMilestoneByThreshold,
};
