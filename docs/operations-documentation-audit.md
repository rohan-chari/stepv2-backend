# Operations Documentation Audit

Date: 2026-09-18

Scope: Bara backend and frontend repositories.

## Goal

Reduce operational ambiguity by making current instructions easy to find,
archiving historical release/deploy notes, and preventing agents from treating
old one-off rollout documents as live authority.

## Canonical sources after cleanup

### Backend

- `OPERATIONS.md` — production/staging topology, backups, migrations, PM2,
  queue/Redis rollout, deployment, verification, rollback, and troubleshooting.
- `AGENTS.md` — engineering/agent policy.
- `README.md` — repository entrypoint only.
- Reusable specialized runbooks:
  - `docs/capacity-load-runbook.md`
  - `docs/redis-cache-runbook.md`
  - `docs/race-experience-identity-search-index-runbook.md`

The legacy `BACKUP.md`, `DEPLOYMENT.md`, and `DEPLOY_RUNBOOK.md` filenames
remain only as short pointers to `OPERATIONS.md` so old links do not become
broken instructions.

### Frontend

- `README.md` — exact Flutter run/build commands and build-time defines.
- `RELEASE.md` — TestFlight/App Store/Google Play release workflow.
- `AGENTS.md` — engineering/agent policy.
- `docs/bara-billing-store-setup.md` — specialized billing/store setup.

The legacy `DEPLOYMENT.md` filename remains only as a pointer to
`RELEASE.md`.

## Problems found

The audit found real conflicting instructions, not just duplication.

Examples removed from live authority included:

- backend README instructions using numeric PM2 id `3`;
- an obsolete production port `3000`;
- a claim that prod and staging both tracked `main`;
- direct `pm2 restart 3` deployment instructions;
- “always deploy staging first” language conflicting with current
  staging-stopped-by-default policy;
- frontend agent guidance describing production as only “two PM2 workers” even
  though the backend currently has two HTTP workers plus background roles;
- backup wording saying the dump was retained locally despite the actual
  requirement to delete the local PII-bearing copy in the same session;
- duplicate long-form deployment procedures spread across backend
  `DEPLOYMENT.md` and `DEPLOY_RUNBOOK.md`;
- one-time September release handoffs living beside current documentation.

## Archive disposition

Historical material was retained under:

- `docs/archive/operations-history/`
- `docs/archive/releases/`
- `docs/archive/research/`

Archive README files explicitly state that archived content is not current
operational authority.

At the end of this cleanup:

- backend has 34 archived documentation/evidence entries under `docs/archive/`;
- frontend has 27 archived entries under `docs/archive/`.

Existing `docs/evidence/` and `docs/artifacts/` remain evidence stores, not
runbooks.

## Guardrails added

Backend:

- `test/contracts/operations-documentation-authority.test.js`

It verifies that root operational compatibility files point to
`OPERATIONS.md`, that numeric PM2-id commands do not return to live root
instructions, that queue Redis and notification ownership remain explicit, and
that current specialized runbooks do not point back to retired runbooks.

Frontend:

- `test/documentation_authority_test.dart`

It verifies that exact build commands stay in `README.md`, release workflow
stays in `RELEASE.md`, legacy deployment points to the canonical workflow, and
archived documentation remains labeled historical.

## Important current deployment blockers surfaced by the audit

The documentation cleanup does not make the scalability branch production
ready by itself.

Before recommending merge/deploy for the current queue-first branch:

1. Resolve production notification ownership.
   `src/index.js` supports a dedicated `notification` process role, but the
   reviewed `ecosystem.config.js` does not currently declare a notification
   PM2 process. Do not infer ownership during deploy.
2. Provision and verify the dedicated `QUEUE_REDIS_URL`.
3. Recalculate/review the database pool budget if another production process is
   added.
4. Verify all queue stream consumers and trimming after boot.
5. Complete the branch's remaining specialized test gates.
6. Perform the final diff/release review.

These requirements are now encoded in `OPERATIONS.md` so they remain visible
even after this conversation ends.

## Future rule

If a procedure becomes part of normal release/deploy behavior, merge it into
the canonical handbook instead of creating another dated top-level runbook.

Feature-specific historical notes may still be created for evidence, but they
belong in the archive once the rollout is complete.
