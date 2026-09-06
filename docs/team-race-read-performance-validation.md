# Team race read latency fix

## Change

Active team requests with `view=participants-v1` keep the complete scalar
scoring roster instead of discarding it and loading the full user/cosmetic
graph again. Presentation is hydrated after privacy masking. These requests
now accept the lean-v3 snapshot already published by the resolution worker.

On a production cold team read, enqueue the existing durable DISPLAY_REFRESH
and return persisted standings without polling Redis for up to one second.
Fresh snapshots remain immediately usable; stale snapshots still enqueue a
refresh in the background. This applies to both paged and frozen unpaged team
clients. Solo requests and non-active serializers keep their existing paths.

No API fields, team roster pagination, game rules, schema, runtime controls,
or app binaries change. Both iOS and Android continue consuming the existing
contract, including older builds. Production and staging were not touched.

## Tests-first evidence

The new HTTP integration test was first run on unchanged `da1ff08`, using a
dedicated local PostgreSQL database ending in `_test` and a local Redis DB15.
The performance assertions failed for the intended reasons:

- Three race-core reads instead of two.
- Twenty-six Redis snapshot GETs on each cold team open instead of one.
- Cold paged and unpaged opens waited for approximately one second.

On the original four-member fixture, the observed HTTP bootstrap duration
fell from 1,127 ms to 95 ms, SQL count from 39 to 35, and the response remained
4,254 bytes. These are local single-request observations, not production
latency guarantees. The final fixture also includes equipped accessories.

## Verification

- New `team-race-read-performance.test.js`: 7/7 passed, no skipped cases.
  Covers full rosters despite limit=1, team sums, forfeited members, names and
  equipped accessory metadata, frozen unpaged clients, direct progress,
  null-timezone teams, Redis disabled, fresh/stale lean worker snapshots,
  Stealth masking, durable refresh completion, and denied viewers.
- Existing bootstrap performance, refresh coalescing, details pagination,
  team lifecycle, and API payload contract suites: 76/76 passed. The contract
  suite was rerun with its required local `ADMIN_EMAILS=admin@test.com` after
  an initial admin authorization failure caused by the omitted environment.
- Related progress/team query and worker-owned refresh checks: 97/97 passed.
- Flutter team scoreboard, active/completed race, contract conformance, and
  participant pagination suites: 78/78 passed. `flutter analyze` is clean.
- Independent code review: no production-code blockers. Its recommendation
  to await/assert stale refresh completion before test cleanup was applied;
  equipped-accessory propagation coverage was also added and passed.
- No native builds were needed for this backend-only change. No tests or
  assertions were removed, weakened, or skipped.

## Outstanding baseline failures

The additional existing `race-bootstrap-persisted-standings.test.js` suite is
not green. Its three indexed-first-page tests (50/500/5000 members) observe
16 index rows rather than the asserted 15. All three also fail on unchanged
`da1ff08` in a separate checkout against the same disposable database. That
baseline run additionally failed its tied-user ordering assertion.

The cause predates this patch: `40dba87` changed the solo persisted page's final
sort key from user ID to participant ID, while the expression index migration
and tied-user test still use user ID. The team patch does not change that
query, index, or solo branch. These existing assertions remain protected and
unchanged. The full repository suite is not claimed green, and this issue
remains outstanding for production-readiness sign-off.

## Deployment

The team patch itself needs only a backend code deployment; it adds no
migration and requires no mobile release. Deploy only after explicit fresh
production authorization, preserving the existing two HTTP workers and
separate background workers. Staging remains stopped. After deployment,
compare team bootstrap latency, progressError responses, and resolution queue
age; persisted cold responses retain the existing eventual refresh behavior.
