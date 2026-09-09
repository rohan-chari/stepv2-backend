# Locked immediate challenge API contract

Locked 2026-09-09 for frontend/backend implementation. Source: approved immediate Join requirements section 5 and architect section 15. No deployment authorized.

## 5. API contract

### 5.1 Add POST `/races/seeded/:seedKind/join-current`

Authenticated; same account/review protections as existing challenge routes.
New endpoint only. Body:

```json
{ "requestId": "a-client-generated-uuid" }
```

The client generates one ID per deliberate Join attempt and reuses it on
network retry. A committed receipt pins seed, window, membership, and join
instant. Reusing the ID for another seed is 409. A retry after midnight must
not create a second entry in the new day. A separate tap for a newly displayed
window gets a new request ID. Natural membership uniqueness protects callers
that generate multiple IDs within the same window.

HTTP 200 for newly joined, already joined, and receipt replay:

```json
{
  "joined": true,
  "alreadyJoined": false,
  "seedKind": "DAILY_10K",
  "raceId": "assigned-race-id",
  "participantId": "assigned-participant-id",
  "windowStart": "2026-09-10T04:00:00.000Z",
  "windowEnd": "2026-09-11T04:00:00.000Z",
  "joinedAt": "2026-09-10T18:05:00.000Z",
  "scoringStartsAt": "2026-09-10T18:05:00.000Z",
  "raceStatus": "ACTIVE"
}
```

`alreadyJoined` is true for existing membership or receipt replay. An expired
receipt replay returns the original race/instants and its current lifecycle
status (`ACTIVE` or `COMPLETED`), never claims membership in a new window. If
the race has been administratively cancelled, use `CANCELLED`; the UI refreshes
the current card and gives factual feedback rather than claiming current entry.

Error shape:

```json
{ "error": "Could not join right now. Try again.", "code": "CHALLENGE_JOIN_BUSY", "retryable": true }
```

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | INVALID_SEED_KIND | Unsupported challenge kind. |
| 400 | INVALID_REQUEST | Missing/malformed UUID or forbidden placement input. |
| 400 | UPDATE_REQUIRED | Caller lacks existing private-cohort support. |
| 401 | existing auth error | Preserve current authentication contract. |
| 403 | CHALLENGE_NOT_ELIGIBLE | Existing account restrictions, not inactivity. |
| 404 | SEED_NOT_FOUND_OR_DISABLED | Seed absent/disabled. |
| 409 | IDEMPOTENCY_CONFLICT | Request ID already bound to a different seed. |
| 409 | CHALLENGE_FORFEITED | Intentional forfeit in this current window; no group shopping. |
| 503 | CHALLENGE_JOIN_BUSY | Bounded contention/retry budget exhausted; Retry-After: 1. |
| 500 | INTERNAL_ERROR | Unexpected failure, no false success; request ID safe to retry. |

Capacity exhaustion, prior group preparation, and automatic inactivity status
are NOT error conditions for an otherwise eligible manual Join.

### 5.2 Additive current projection on featured cards

Add `currentJoin` to private challenge cards in `/races/featured`, compact
`/races/public?view=browser-v1`, and the shared discovery-summary representation
where cards are returned. Keep all existing fields, including `myStatus`,
`upcoming`, `raceId`, and old `ELECTED` semantics unchanged for frozen clients.

```json
{
  "seedKind": "DAILY_10K",
  "bucketPrivate": true,
  "myStatus": "ELECTED",
  "currentJoin": {
    "version": 1,
    "state": "JOINABLE",
    "windowStart": "2026-09-10T04:00:00.000Z",
    "windowEnd": "2026-09-11T04:00:00.000Z",
    "raceId": null,
    "participantCount": null,
    "scoringStartsAt": null,
    "reason": null
  }
}
```

States: `JOINABLE`, `JOINED`, `FORFEITED`, `UNAVAILABLE`.
JOINED includes the viewer's nonempty raceId, accepted participantCount, and
scoringStartsAt. FORFEITED may link only the viewer's race. UNAVAILABLE has a
stable reason such as `SEED_DISABLED` or `ACCOUNT_INELIGIBLE`; lack of a prepared
cohort is not UNAVAILABLE. No other cohort's count/ID/opponents are disclosed.
Unknown version/state/null/malformed fields degrade safely as section 9 states.

### 5.3 Retained contracts

- `/assign`: unchanged body default UPCOMING and successful 202 shape
  `{ "elected": true, "raceId": null, "finalizesAt": "..." }`.
  Its old success contract applies after preparation too; repeated elections
  are idempotent. No implicit CURRENT reinterpretation.
- `/me/featured-auto-join`: unchanged request/response; preserve preference
  durability and add durable late-election recovery in the write path.
- Legacy public Join/access remain compatible. Existing accepted LEGACY
  membership returns that race, never a second BUCKET membership. For an
  unassigned current-capable caller in a LEGACY-stamped window, the new endpoint
  may create/use a private CURRENT_JOIN_V1 group and claim BUCKET for that user.
  This is a separate per-user current-admission policy: do not rewrite the
  window's immutable legacy preparation mode or migrate accepted legacy users.
  It uses the same caps and stamped seed prizes as normal current admission.
  Such groups carry admissionVersion=1 and are discoverable only to members;
  old public/legacy callers continue on their historical public path.
  A preexisting legacy election without a participant is reconciled by the
  existing ledger policy before admission, never overwritten optimistically.
  Test simultaneous generic legacy Join versus current Join: exactly one
  ledger stream wins and the loser returns that accepted membership.

The new endpoint requires existing `seeded_race_buckets` support; an incapable
client receives 400 UPDATE_REQUIRED and continues using its existing endpoints.
No new client feature flag is introduced. For bucket-capable old clients, an
owned CURRENT_JOIN_V1 group uses the existing private-card shape/View behavior
even in a LEGACY window. Incapable clients retain the existing private-stream
visibility rules. Shared discovery must filter by ownership, not mode alone.


Architect clarification: the existing public legacy Join retains BUCKET_STREAM_ELECTED when bucket admission wins; only the new endpoint returns the winning existing legacy membership. CHALLENGE_JOIN_BUSY always includes retryable:true and Retry-After: 1.

Additive LEGACY projection clarification (locked with orchestrator/frontend):
`currentJoin` is also present on capable LEGACY daily/weekly Featured cards.
All existing public fields, including `bucketPrivate`, stay unchanged. Updated
clients route by presence of `currentJoin`; malformed-present data is unavailable,
and absent public projection retains the historical generic Join path.

Implementation detail: settings side effects carry the captured request time to
upcoming election and legacy pending selection. They never recompute a new
next-window target after the preference transaction has committed.

Signup recovery uses the existing once-per-human onboarding ledger. Its nullable
`target_box_count` / `granted_box_count` columns treat all historical and immediate
rows as fully delivered. Recovery rows pin the original target and atomically
grant only available inventory capacity; remaining boxes resume on worker retries.
Manual Join alone never creates welcome-box eligibility.

Unfinished welcome delivery can resume in a later active canonical Daily/Weekly
membership after the original enrollment intentions expire. Creating a new
welcome entitlement still requires a captured SIGNUP intention; an ordinary
manual join cannot create one.

The nullable `users.seeded_automatic_eligible_at` timestamp supports interrupted
background scans. Existing eligible NULL rows retain their pre-migration identity.
A database trigger timestamps newly eligible inserts and transitions into both
opt-in and bucket capability, including older writers; repeated eligible writes
preserve the original timestamp. Exact request intentions remain independently
durable, so a delayed capability/preference write does not select another window.

Current admission takes an admission-only seed/window transaction guard before
selecting capacity and before the shared C0 → global → user → race → window
lock sequence. Background writers never acquire this outer guard. It prevents
competing HTTP joins from exhausting retries on stale placement snapshots while
preserving the existing bounded transaction, lock-timeout and retry limits.
