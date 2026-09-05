// pm2 process definition — the SOURCE OF TRUTH for how this backend runs.
//
// Why this file exists: the worker count used to live only in pm2's runtime
// state, set by hand with `pm2 scale` and persisted (or not) into
// `~/.pm2/dump.pm2`. That drifted silently — on 2026-08-16 prod was found
// serving on ONE worker, i.e. half the droplet, because a resurrect had
// restored a dump that predated the 2026-08-15 scale-up. Nothing surfaced it.
// Declaring `instances` here means a deploy re-asserts it instead of trusting
// the server to remember.
//
// `instances: 2` matches the droplet's 2 vCPUs. Node is single-threaded, so one
// worker can use at most one core; two workers is what makes both cores
// reachable. Do NOT raise this past the core count — extra workers on 2 vCPUs
// add context-switching, not throughput, and each one costs ~300-400 MB of the
// box's 2 GB.
//
// SAFETY INVARIANT: scaling past 1 instance is only safe because
// `src/index.js:188-201` gates the whole `startCrons()` call behind
// `process.env.NODE_APP_INSTANCE === "0"`. pm2 sets that per worker. Without
// the guard every one of the ~17 schedulers (race resolution, live placement
// push, payout reconcile) double-runs on each extra worker. If you ever change
// `instances`, re-verify the guard — see DEPLOY_RUNBOOK.md §3a.
//
// Secrets and PORT are deliberately NOT here. Each deployment directory has its
// own `.env`, which `src/db.js` loads via dotenv; prod is PORT=3002 and staging
// PORT=3003. Keeping them out of this file is what lets one committed config
// describe both environments.

const PROD_DIR = "/var/www/step-tracker-backend";
const STAGING_DIR = "/var/www/step-tracker-backend-staging";
const BACKGROUND_NODE_ARGS = "--max-old-space-size=320 --max-semi-space-size=8";
// The cron owner may settle an entire delayed Daily cohort fleet in one pass.
// Keep its heap distinct from the bounded two-lane resolution worker: the
// 2026-09-05 catch-up exceeded 320 MB and otherwise entered an OOM restart loop.
const CRON_NODE_ARGS = "--max-old-space-size=1024 --max-semi-space-size=16";

/**
 * Both apps are identical apart from their directory — same repo, deployed
 * twice. Absolute paths mean this file behaves the same whichever copy of the
 * repo pm2 reads it from; always pair it with `--only <name>` so a prod deploy
 * cannot touch staging (or vice versa).
 */
function app(name, cwd, instances, env = {}, options = {}) {
  const { maxMemoryRestart = "600M", ...pm2Options } = options;
  return {
    name,
    cwd,
    script: `${cwd}/src/index.js`,
    exec_mode: "cluster",
    instances,
    env,
    ...pm2Options,
    ...(maxMemoryRestart ? { max_memory_restart: maxMemoryRestart } : {}),
    // `reload` cycles workers one at a time for zero downtime. `restart` kills
    // them all at once and caused a ~10s outage with user-visible 502s the one
    // time it was used on prod (2026-07-12).
    autorestart: true,
    // Long enough for in-flight requests to drain on a reload. The step-sync
    // path can legitimately hold a request for several seconds under load.
    kill_timeout: 10000,
  };
}

module.exports = {
  apps: [
    // Prod gets both cores: 2 workers, matching the 2 vCPUs.
    app("steps-tracker", PROD_DIR, 2, {
      STEPS_PROCESS_ROLE: "http",
      DATABASE_POOL_MAX_HTTP: "10",
      DATABASE_POOL_TOTAL_BUDGET: "32",
      // The guarded reload validates and exports these from the deployed .env.
      // Declaring them here makes PM2 replace any stale saved values.
      MIN_SUPPORTED_APP_VERSION: process.env.MIN_SUPPORTED_APP_VERSION,
      LATEST_APP_VERSION: process.env.LATEST_APP_VERSION,
      PORT: 3002,
    }, {
      // PM2 6.0.14 can orphan a clustered worker when automatic reloads
      // overlap (PM2 #6129). The old 600 MB ceiling caused 490 such reloads
      // in five days. The topology watchdog enforces a 1200 MB ceiling by
      // restarting at most one registered HTTP instance at a time.
      // PM2 merges reload config, so omitting this field would preserve the
      // old 600M value. Zero is not disabled in PM2 6.0.14 (every RSS is > 0),
      // therefore use an unreachable sentinel that the watchdog verifies.
      maxMemoryRestart: "100G",
    }),
    // The queue owns participant projection writes and is intentionally kept
    // out of the HTTP workers. It is one fork: the queue itself provides
    // cross-process serialization with Postgres leases.
    app("steps-tracker-resolution", PROD_DIR, 1, {
      STEPS_PROCESS_ROLE: "resolution",
      DATABASE_POOL_MAX_RESOLUTION: "8",
      DATABASE_POOL_TOTAL_BUDGET: "32",
      PORT: 3010,
      HOST: "127.0.0.1",
    }, {
      exec_mode: "fork",
      node_args: BACKGROUND_NODE_ARGS,
      exp_backoff_restart_delay: 1000,
    }),
    // Expiry/cron is a single owner. It shares the database fence with the
    // resolution process, so settlement and live work cannot interleave.
    app("steps-tracker-cron", PROD_DIR, 1, {
      STEPS_PROCESS_ROLE: "cron",
      DATABASE_POOL_MAX_CRON: "4",
      DATABASE_POOL_TOTAL_BUDGET: "32",
      PORT: 3011,
      HOST: "127.0.0.1",
    }, { exec_mode: "fork", node_args: CRON_NODE_ARGS }),
    // Staging stays at ONE because it serves essentially no traffic. This was
    // originally required by the former 2 GB host; keeping it at one on the
    // replacement 8 GB host preserves capacity for production and load spikes.
    //
    // Production-shaped load tests belong in the isolated capacity harness,
    // which owns its own four-process topology and database. Never scale this
    // stopped shared-host staging process as a substitute.
    app("steps-tracker-staging", STAGING_DIR, 1, {
      // Explicit combined staging identity. Production's legacy `all` role is
      // forbidden from claiming race work, but the intentionally single-process
      // staging app must serve HTTP and run its background queues when an
      // operator has explicitly started it.
      STEPS_PROCESS_ROLE: "staging_all",
      DATABASE_POOL_MAX_ALL: "10",
    }, { autostart: false }),
  ],
};
