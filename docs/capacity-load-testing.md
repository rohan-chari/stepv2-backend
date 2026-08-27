# Capacity load test

Copy `docs/capacity-load.config.example.json`, set `repository` and the local dump path, export the three run-only secrets below, then use:

```sh
npm run capacity -- start --config docs/capacity-load.config.json
npm run load-test -- run --config docs/capacity-load.config.json
npm run capacity -- destroy --config docs/capacity-load.config.json
```

`start` restores and scrubs the disposable database through the configured capacity hooks, prints the complete VPS and Postgres specification, and requires an exact interactive confirmation every time it is run. `destroy` stops the service first when necessary, then destroys the VM/database through the destroy hook.

With `provider: "lima"`, these commands create one local Lima VM and a Postgres Docker container inside it. No VPS, cloud account, or database credentials are used. The first start downloads the guest/container images; later stop/start cycles reuse them.

The `full-app` profile exercises Home, Races, Race Details, current and legacy step sync, and durable queue polling. The Lima target also runs Redis 7.0.15 plus dedicated resolution and cron processes to match production. Increase `users`, `arrival_rate`, and `duration` in the config for the next run. Reports are written to `results/`.

For the global-event deployment gate, follow the dedicated section in
`docs/capacity-load-runbook.md`. It requires three repetitions of each
`event_provisioning_10000`, `event_boundary_10000`, and
`event_provider_outage_10000`; a generic `full-app` run is not substitute
evidence.

Required environment for the capacity VM:

```sh
CAPACITY_MODE=true
CAPACITY_OUTBOUND_DISABLED=true
CAPACITY_RUN_ID=<same run_id>
CAPACITY_DB_MARKER=<run-specific random marker>
CAPACITY_DB_HOST_ALLOWLIST=<private db host>
CAPACITY_DB_NAME=<capacity database name>
CAPACITY_AUTH_SECRET=<run-only secret>
SESSION_TOKEN_SECRET=<same run-only secret>
CAPACITY_SCRUB_ATTESTATION_SECRET=<run-only secret>
CAPACITY_RESTORE_HOOK='npm run capacity:db -- restore --snapshot "$CAPACITY_SNAPSHOT_PATH"'
CAPACITY_SCRUB_HOOK='npm run capacity:db -- scrub --snapshot "$CAPACITY_SNAPSHOT_PATH" --attestation "$CAPACITY_SCRUB_ATTESTATION_PATH"'
CAPACITY_START_HOOK=<start VM/backend command>
CAPACITY_STOP_HOOK=<stop VM/backend command>
CAPACITY_DESTROY_HOOK=<destroy VM/database command>
CAPACITY_HEALTH_URL=http://<private-vm>/health

For the Lima profile, set `CAPACITY_DB_PASSWORD`, `CAPACITY_REDIS_PASSWORD`, `CAPACITY_AUTH_SECRET`, and `CAPACITY_SCRUB_ATTESTATION_SECRET` in the shell. They are run-only local secrets and are not stored in the config.
```
