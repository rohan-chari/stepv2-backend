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

/**
 * Both apps are identical apart from their directory — same repo, deployed
 * twice. Absolute paths mean this file behaves the same whichever copy of the
 * repo pm2 reads it from; always pair it with `--only <name>` so a prod deploy
 * cannot touch staging (or vice versa).
 */
function app(name, cwd, instances) {
  return {
    name,
    cwd,
    script: `${cwd}/src/index.js`,
    exec_mode: "cluster",
    instances,
    // RAM, not CPU, is what caps the worker count on this box. Each worker
    // holds its own V8 heap (~340-400 MB at rest, 590 MB observed under load)
    // and the droplet has 1.97 GB with NO SWAP — so the kernel OOM-killer, not
    // a scheduler, is what enforces the limit. On 2026-08-16 running 2+2
    // workers killed a node process twice in 40 minutes
    // (`dmesg -T | grep oom-kill`). Restart a worker before it can take the box
    // down with it; 600 MB is above normal peak but under the OOM threshold.
    max_memory_restart: "600M",
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
    app("steps-tracker", PROD_DIR, 2),
    // Staging gets ONE, and the reason is memory, not CPU. Four workers'
    // heaps do not fit in 1.97 GB — running 2+2 on 2026-08-16 got a node
    // process OOM-killed twice inside 40 minutes, and the victim can just as
    // easily be a PROD worker as a staging one. Staging serves ~no traffic, so
    // its second worker buys nothing at rest and risks prod under load.
    //
    // For a load test that needs prod-matching topology, scale it up for the
    // run and put it back afterwards — do not make 2 the committed default:
    //   pm2 scale steps-tracker-staging 2   # then `pm2 scale … 1` when done
    // and watch `free -m` while it runs.
    app("steps-tracker-staging", STAGING_DIR, 1),
  ],
};
