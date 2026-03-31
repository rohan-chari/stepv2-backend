const { Steps } = require("../models/steps");
const { User } = require("../models/user");
const { getTimeZoneParts } = require("../utils/week");

function buildGetStepCalendar(deps = {}) {
  const stepsModel = deps.Steps || Steps;
  const userModel = deps.User || User;
  const now = deps.now || (() => new Date());

  return async function getStepCalendar(userId, month, timeZone) {
    // Parse "YYYY-MM"
    const [yearStr, monthStr] = month.split("-");
    const year = parseInt(yearStr, 10);
    const monthNum = parseInt(monthStr, 10);

    // Days in month
    const daysInMonth = new Date(year, monthNum, 0).getDate();

    const startDate = `${year}-${String(monthNum).padStart(2, "0")}-01`;
    const endDate = `${year}-${String(monthNum).padStart(2, "0")}-${String(daysInMonth).padStart(2, "0")}`;

    // Fetch step records and user
    const [records, user] = await Promise.all([
      stepsModel.findByUserIdAndDateRange(userId, startDate, endDate),
      userModel.findById(userId),
    ]);

    const defaultGoal = user?.stepGoal || 5000;

    // Build a map of date → record
    const recordMap = new Map();
    for (const record of records) {
      const dateStr = record.date.toISOString().slice(0, 10);
      recordMap.set(dateStr, record);
    }

    // Determine today in the user's timezone
    const nowDate = now();
    const parts = getTimeZoneParts(nowDate, timeZone);
    const todayStr = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;

    // Build days array
    const days = [];
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${year}-${String(monthNum).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const record = recordMap.get(dateStr);

      const steps = record?.steps || 0;
      const stepGoal = record?.stepGoal ?? defaultGoal;
      const goalMet = steps >= stepGoal;
      const isFuture = dateStr > todayStr;
      const isToday = dateStr === todayStr;

      days.push({
        date: dateStr,
        steps,
        stepGoal,
        goalMet,
        future: isFuture,
        isToday,
      });
    }

    return { days };
  };
}

const getStepCalendar = buildGetStepCalendar();

module.exports = { getStepCalendar, buildGetStepCalendar };
