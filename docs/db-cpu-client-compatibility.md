# Database CPU remediation: client compatibility review

Reviewed September 10, 2026 against frontend `a7596ef842b24e238da290075b01614bf56c16f2` and the approved CPU remediation specification. This is a source review and frontend static-analysis baseline, not a claim that backend integration tests have passed.

## Contract that implementation must preserve

There are no new client fields, capabilities, routes, statuses, or error envelopes. A frozen iOS or Android binary must receive its existing response for its existing headers. Query preparation, capture cleanup and notification recovery cannot require a client release.

| Public path | Compatibility obligation and existing test evidence to rerun |
| --- | --- |
| `POST /steps` | With no feature header, preserve HTTP 200 and the exact `{record}` envelope: `createdAt,date,id,stepGoal,steps,userId`. Preserve both `skipRaceResolution` values and atomic queue handoff. `test/integration/step-intake-legacy-contract.test.js`. |
| `POST /steps/samples` | No feature header required. Preserve HTTP 200 `{count: normalizedCount}`, including identical-input count and no additional source/queue generation; empty input remains HTTP 400 `{error:"samples must be a non-empty array"}`. Same legacy-contract suite. |
| `POST /steps/sync-v2` | Preserve durable acceptance/idempotency and the same result on retry using an unchanged key/body. The client retries ambiguous failures once and only permits legacy fallback for definite unsupported/pre-persistence cases. Do not turn a committed acceptance into a fallback signal. |
| `GET /races/:id/progress`, bootstrap and participant variants | Preserve committed totals, inventory, paging, generation boundaries and read-only behavior. `read-only-race-progress.test.js` explicitly exercises absent headers; `race_bootstrap`; `race_participants_paging`; and `race_participants_paging,race_bootstrap_compact`, under fresh/expired/Redis-off reads. Those old header strings remain real regression cases even though the newest client advertises `api_payload_compact_v1`. |
| Public discovery and viewer overlays | Preserve eligibility/capacity filtering before LIMIT, ordering, and viewer-specific membership/invitation/subscription state. `query-efficiency-suggestions.test.js` covers mostly-full, mostly-open and unlimited public fixtures; `discovery-featured-bracket-joinable.test.js` and `team-races-10v10-discovery.test.js` cover capability-dependent discovery. A prepared array bind must not share viewer data across requests. |
| Inbox list/read | `inbox_v1` remains necessary. Absent header must preserve HTTP 404 `{error:"Inbox is unavailable",code:"FEATURE_DISABLED"}`; unauthenticated capable requests retain HTTP 401 `{error:"Authorization bearer token is required"}`. Preserve list ordering/cursors, pagination-independent unread counts and ownership checks. `inbox-unread-contract.test.js`, `inbox-read-all.test.js`. |
| Notification recovery | No duplicated visible alert or provider attempt; no loss of required notification after recovery. Existing `centralized-notification-delivery.test.js` covers delivery deduplication, payload preservation, due scheduling, two-worker races and terminal/transient dispositions. These are service/worker fixtures, not all public HTTP tests; pair with the Inbox HTTP contracts above. |

Source anchors: frontend `lib/services/backend_api_service.dart` (`recordSteps`, `recordStepSamples`, `recordStepSyncV2`, `fetchRaceBootstrap`, `fetchRaceProgressCompact`, `fetchPublicRaceBrowser`, `fetchInboxAlerts`); backend `src/shared/http/requestPathPayloadContracts.js` and `src/modules/races/routes.js`.

## Existing client degradation and mirrored surfaces

The main shell uploads steps and reads Inbox counts. Race detail consumes bootstrap/progress; public races consumes browser discovery; Inbox consumes alert pages. Bootstrap treats a definite 404 as unsupported, safely parses maps and contract names, and falls back to standalone reads for invalid compact data. Compact progress preserves legacy progress and uses separate inventory loading when the compact inventory is unavailable. Public discovery accepts the legacy `{races}` packet so optional browser branches can be loaded through existing calls. Required malformed envelopes become controlled `ApiException` failures rather than a dependency on a new CPU-remediation field.

`lib/demo/demo_race_api_service.dart` and `lib/tutorial/tutorial_preview_data.dart` override bootstrap/progress for the real mirrored race screen. Base-service runtime-type guards keep new base methods from escaping those injected demo services to a backend. This remediation adds no method or visible field, so no demo, tutorial, screen or widget change is needed.

Both platform header sets retain `race_participants_paging`, `inbox_v1`, and `api_payload_compact_v1`; existing platform-specific capabilities remain as they are. No build-time defines or native dependencies change.

## Validation and limitations

- `flutter analyze`: PASS, no issues found, 4.6 seconds on the reviewed worktree.
- Flutter source, tests, screens/widgets and native configuration changed by this task: none.
- No widget tests were added or run because there is no frontend behavior change; the mandatory acceptance evidence belongs to real backend HTTP/worker tests with legacy and current headers.
- iOS/Android builds: not run; specification §12 explicitly requires no app build for this backend-only scope. This is not a claim that new native artifacts were built.
- Unrelated existing Meta native changes were preserved. Static analysis does not validate those native changes.
- Final backend validation: 209 distinct integration checks across 33 files pass with the required fixture-specific Redis settings, including boundary crossing, Redis failure, fresh commit fences, notification recovery and old headers. Exact results and configuration reruns are recorded in [validation](db-cpu-remediation-validation.md); source review alone was not used as acceptance evidence.
