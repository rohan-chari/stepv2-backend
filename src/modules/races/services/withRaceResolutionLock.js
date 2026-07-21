// PASSTHROUGH (deliberate — see incident 2026-07-18).
//
// This wrapper previously opened a Prisma interactive transaction to hold a
// Postgres advisory xact lock (`pg_advisory_xact_lock`) for the lifetime of the
// reconciliation callback. That was pathological under concurrent production
// load: the callback's actual reads/writes run on the GLOBAL prisma client (a
// DIFFERENT pooled connection), while the lock-holding transaction stayed OPEN
// and IDLE for the whole reconciliation (timeout up to 30s). So every
// reconciliation pinned TWO connections, and with N concurrent /steps uploads
// (the legacy path calls resolveRaceState on every step sync) the pool drained
// and ALL routes — /races, /home/race-card, everything — queued waiting for a
// connection. Single-user benchmarks never saw it; it only appears under
// concurrency.
//
// The lock's only real purpose is to serialize the async full-field worker
// against the legacy/placement paths on the SAME race. That interleaving cannot
// occur today: no shipped app calls /steps/sync-v2, so the queue is empty and the
// worker never runs. Removing the lock restores the exact hot-path behavior prod
// ran safely for months (legacy + placement were always lock-free).
//
// DO NOT re-enable a lock here until it is reimplemented WITHOUT pinning a second
// pooled connection (run the reconciliation inside the same tx, or scope the lock
// to the cheap uploader-only path + the worker), AND proven under a CONCURRENT
// load test on staging. It is not needed until v2/async has real client traffic.
async function withRaceResolutionLock(_raceId, callback) {
  return callback();
}

module.exports = { withRaceResolutionLock };
