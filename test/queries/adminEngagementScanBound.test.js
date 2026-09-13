const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { it } = require('node:test');

// The HTTP response is intentionally identical before/after this optimization.
// Guard the scan structure as well as the separate HTTP metric fixtures: a
// correlated per-day query can pass every value assertion while doing 30 scans.
it('reduces event, ledger and claim rows before joining the daily date spine', () => {
  const source = readFileSync(join(__dirname, '../../src/modules/admin/adminMetricsQueries.js'), 'utf8');
  const daily = source.split('async function loadEngagement(')[1].split('const [stats]')[0];
  assert.equal((daily.match(/FROM coin_transactions\b/g) || []).length, 1, 'credits and debits must share a ledger scan');
  assert.equal((daily.match(/FROM daily_reward_claims\b/g) || []).length, 1, 'claims and distinct claimers must share a scan');
  const spine = daily.slice(daily.indexOf("SELECT to_char(d.d"));
  assert.doesNotMatch(spine, /\bFROM (?:race_powerup_events|coin_transactions|daily_reward_claims)\b/, 'large sources must be reduced before the per-date result, not rescanned for every date');
});
