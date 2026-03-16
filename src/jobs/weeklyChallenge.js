const {
  ensureWeeklyChallengeForDate,
  resolveWeeklyChallengeForDate,
} = require("../services/weeklyChallengeState");

async function runMondayChallengeDrop() {
  console.log("[CRON] Running Monday challenge drop...");

  try {
    const result = await ensureWeeklyChallengeForDate({ now: new Date() });
    console.log(
      `[CRON] Current week challenge ready: "${result.weeklyChallenge.challenge.title}" (${result.weeklyChallenge.challenge.id})`
    );
    return result.weeklyChallenge.challenge;
  } catch (error) {
    console.error("[CRON] Challenge drop failed:", error);
    throw error;
  }
}

async function runSundayResolution() {
  console.log("[CRON] Running Sunday challenge resolution...");

  const result = await resolveWeeklyChallengeForDate({ now: new Date() });
  console.log(
    `[CRON] Sunday resolution complete: ${result.summary.resolvedInstances} resolved, ${result.summary.skippedInstances} skipped`
  );
}

function scheduleCronJobs() {
  function msUntilNext(dayOfWeek, hour, minute, tz = "America/New_York") {
    const now = new Date();
    const target = new Date(
      now.toLocaleString("en-US", { timeZone: tz })
    );
    target.setHours(hour, minute, 0, 0);

    // Set to the right day of week
    const currentDay = target.getDay();
    let daysAhead = dayOfWeek - currentDay;
    if (daysAhead < 0) daysAhead += 7;
    if (daysAhead === 0 && now >= target) daysAhead = 7;
    target.setDate(target.getDate() + daysAhead);

    // Convert back: compute the offset between local tz time and UTC
    const tzNow = new Date(
      now.toLocaleString("en-US", { timeZone: tz })
    );
    const offset = tzNow.getTime() - now.getTime();

    return target.getTime() - offset - now.getTime();
  }

  function scheduleWeekly(dayOfWeek, hour, minute, fn, label) {
    function run() {
      fn().catch((err) => console.error(`[CRON] ${label} error:`, err));
      // Schedule next week
      setTimeout(run, 7 * 24 * 60 * 60 * 1000);
    }

    const ms = msUntilNext(dayOfWeek, hour, minute);
    const hours = (ms / 1000 / 60 / 60).toFixed(1);
    console.log(`[CRON] ${label} scheduled in ${hours}h`);
    setTimeout(run, ms);
  }

  // Monday 9:00 AM EST
  scheduleWeekly(1, 9, 0, runMondayChallengeDrop, "Monday challenge drop");

  // Sunday 11:59 PM EST
  scheduleWeekly(0, 23, 59, runSundayResolution, "Sunday resolution");
}

module.exports = { scheduleCronJobs, runMondayChallengeDrop, runSundayResolution };
