const { prisma } = require("../db");
const {
  CYCLE_LENGTH,
  getRewardPreviewForDay,
} = require("../constants/dailyReward");

function previousDateString(dateStr) {
  const [y, m, d] = dateStr.split("-").map((n) => parseInt(n, 10));
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function computeNextCycleDay(prevDate, prevStreakDay, today) {
  if (prevDate === today) return prevStreakDay; // already claimed today
  if (prevDate === previousDateString(today) && prevStreakDay < CYCLE_LENGTH) {
    return prevStreakDay + 1;
  }
  // Missed a day, or just finished cycle (prevStreakDay === CYCLE_LENGTH).
  return 1;
}

async function getDailyRewardStatus({ userId, localDate }) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { lastDailyClaimDate: true, dailyStreakDay: true },
  });
  if (!user) {
    const err = new Error("User not found");
    err.statusCode = 404;
    throw err;
  }

  const claimedToday = user.lastDailyClaimDate === localDate;
  const projectedDay = claimedToday
    ? user.dailyStreakDay
    : computeNextCycleDay(
        user.lastDailyClaimDate,
        user.dailyStreakDay,
        localDate
      );

  const ladder = [];
  for (let day = 1; day <= CYCLE_LENGTH; day++) {
    ladder.push({
      day,
      reward: getRewardPreviewForDay(day),
      claimed: claimedToday && day <= projectedDay,
      isToday: day === projectedDay,
    });
  }

  return {
    cycleLength: CYCLE_LENGTH,
    currentDay: projectedDay,
    claimedToday,
    ladder,
  };
}

module.exports = { getDailyRewardStatus, computeNextCycleDay, previousDateString };
