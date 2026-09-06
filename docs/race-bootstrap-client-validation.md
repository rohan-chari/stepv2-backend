# Race bootstrap client compatibility validation

Validated 2026-09-05 against the existing shared Flutter consumers. This is a
backend-only performance change under `race-bootstrap-performance-requirements.md`.
No frontend source, widget, dependency, native configuration or test was changed.

## Contract requirements verified in the client

- `lib/services/backend_api_service.dart`, `fetchRaceBootstrap` and
  `_isValidCompactRaceBootstrap`: both existing bootstrap contract names remain
  accepted. Compact responses require `race.participants` to be absent and valid
  race/progress pagination, summary identity/count fields and hydrated progress
  presentation (`animal` key and `accessories` list). Removing the duplicate
  details page is compatible only in the already eligible compact branch.
- The compact validator accepts an empty participant list. Mandatory malformed
  compact fields select the established details/progress fallback; missing
  optional projection metadata is accepted. Only a definite bootstrap 404 is
  remembered as endpoint unsupported. `PROGRESS_UNAVAILABLE` retains the screen's
  error state, and completed bootstrap without progress invokes the standalone
  progress read.
- `lib/screens/race_detail_screen.dart`, `_inviteMore`: `participantUserIds`
  supplies all invitation exclusions, including users absent from the displayed
  page. When absent on legacy responses, the full `participants` array supplies
  them. Preserve the complete ID array, including declined membership and existing
  ordering; replacing it with the accepted/displayed page would break clients.
- The same screen reads top-level accepted/team counts, viewer status/team/steps
  for off-page participants. Aggregate construction must return identical values
  and money metadata; no frontend adaptation is required.
- `fetchRaceProgressParticipants` and `_loadProgress` retain existing page
  metadata and requester placement. Paged responses replace the visible page;
  unpaged legacy responses retain their existing union behavior. The client
  trusts the server's echoed offset and total, so count/page consistency and
  unchanged out-of-range response semantics belong in backend HTTP tests.
- Ordinary navigation refuses an offset beyond the last known total and clamps
  negative offsets. An empty initial page renders `0-0 of 0`. Existing code also
  accepts an empty response whose echoed offset exceeds a newly reduced total;
  its pager may display `0-<offset> of <total>`. This pre-existing display edge is
  not changed or claimed fixed by the backend optimization. There is no new
  client requirement to clamp out-of-range responses differently.
- Refresh coalescing and request-local reuse are internal: their compatibility
  requirement is unchanged freshness, visibility, authorization, error fallback
  and payload semantics, which backend integration tests must establish.

## Verification

The following focused command passed **79/79 tests**:

```sh
flutter test test/race_details_participants_pagination_test.dart test/weekly_race_page_projection_frontend_test.dart test/race_detail_screen_test.dart test/api_contract_payload_cleanup_frontend_test.dart --reporter expanded
```

These suites exercise real screen rendering with injected test services for
compact and legacy loading, off-page membership and invitation exclusion, team
counts, requester placement, page replacement, empty/loading/error states and
optional metadata. The HTTP parser suite separately verifies compact hydration
and fallback. They are compatibility evidence for the unchanged client, not
measurement of backend performance or substitutes for backend integration tests.

`flutter analyze` passed with **No issues found**.

## Platform and release scope

iOS and Android use the same unchanged Dart bootstrap/progress parsers and race
detail screen. Both capability-header variants advertise the existing paging
capability. No platform-specific API contract or new required server field is
introduced. Frozen clients still require existing full legacy arrays.

No new iOS or Android binaries were built: no app code, build configuration or
dependency is part of this backend release. Native build success is not claimed.
No UI placement changed, so no new manual placement checklist is required. The
frontend worktree's pre-existing unrelated edits were left untouched. No
production or staging system was accessed for this validation.
