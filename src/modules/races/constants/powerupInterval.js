// Every powerup-enabled competition earns a box every 2,000 steps. Formerly a
// per-race creator choice (2k–25k); fixed by owner decision 2026-07-24 so the
// rules are identical in every race. Deliberately a CODE constant, not balance
// config — it must not be admin-editable.
const FIXED_POWERUP_STEP_INTERVAL = 2000;

module.exports = { FIXED_POWERUP_STEP_INTERVAL };
