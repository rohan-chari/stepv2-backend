const { Steps } = require("../models/steps");
const { getTimeZoneParts } = require("../utils/week");

function buildGetStepCalendar(deps = {}) {
  const stepsModel = deps.Steps || Steps;
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

    const records = await stepsModel.findByUserIdAndDateRange(
      userId,
      startDate,
      endDate
    );

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
      const isFuture = dateStr > todayStr;
      const isToday = dateStr === todayStr;

      days.push({
        date: dateStr,
        steps,
        future: isFuture,
        isToday,
        // 1.1.4 compat: legacy clients render a per-day goal bar.
        stepGoal: record?.stepGoal ?? 5000,
        goalMet: steps >= (record?.stepGoal ?? 5000),
      });
    }

    return { days, stepGoal: 5000 };
  };
}

const getStepCalendar = buildGetStepCalendar();

module.exports = { getStepCalendar, buildGetStepCalendar };
