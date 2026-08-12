# Race experience and discoverable identity — locked backend contract

This document pins the backend interface approved in
`stepv2-frontend/docs/race-experience-and-identity-requirements.md`. It is
additive. Existing endpoints, request fields, response fields, statuses, and
error messages remain valid for frozen clients.

## Runtime flags

All three keys are declared in `KNOWN_FLAGS` and default to `false`:

- `discoverableIdentityOnboardingEnrollmentEnabled` — server-only. It stamps
  the immutable create-branch cohort bit only when the same provision request
  advertises `X-Client-Features: discoverable_identity`.
- `racesInviteDecisionGateEnabled` — exposed as a literal Boolean at
  `user.featureFlags.racesInviteDecisionGateEnabled` on every authenticated
  own-user envelope. Only literal `true` enables the client gate.
- `quickRaceShareAutoFriendEnabled` — server-only.

## Data contract

The `users` table gains nullable `first_name`, `last_name`,
`discoverable_name_search`, and `name_setup_completed_at`, plus
`name_setup_onboarding_required BOOLEAN NOT NULL DEFAULT false`. No provider
name or existing user is backfilled.

`friendship_auto_link_suppressions` has the composite primary key
`(user_a_id, user_b_id)`, both user foreign keys cascade on delete, `reason`
defaults to `REMOVED`, `created_at` defaults to now, and a database check
requires `user_a_id < user_b_id`. The migration backfills every currently
`DECLINED` friendship using its lexicographically sorted pair.

`friend_search_rate_windows` has one row per user (`user_id` primary key and
cascading foreign key), with `window_start` and integer `count`. It stores no
query text.

`pg_trgm` backs exact partial GIN indexes for `lower(display_name)` and
`discoverable_name_search`. Both exclude review accounts; the discoverable-name
index additionally requires completed setup and a non-null search value.

## Authenticated own-user serialization

Provision, `GET /auth/me`, `GET /auth/session`, reviewer auth, the step-goal
compat response, display-name writes, and all other authenticated own-user
envelopes include these additive keys for every client:

```json
{
  "firstName": null,
  "lastName": null,
  "nameSetupOnboardingRequired": false,
  "nameSetupCompletedAt": null
}
```

`discoverableNameSearch` is private and is never serialized. Existing response
keys remain unchanged. Identity fields do not vary by client-feature cache key.

## `PUT /auth/me/discoverable-name`

Request:

```json
{ "firstName": "Nathan", "lastName": "Chari" }
```

`lastName` may be null or empty and is stored as null. A successful request
returns `200`:

```json
{
  "user": {
    "id": "user-uuid",
    "firstName": "Nathan",
    "lastName": "Chari",
    "nameSetupOnboardingRequired": true,
    "nameSetupCompletedAt": null
  },
  "suggestedDisplayName": "NathanChari"
}
```

The suggestion is valid and currently available but advisory. The write never
sets completion. Repeated valid calls replace pending values. Errors are:

- `400 {"code":"INVALID_FIRST_NAME","error":"…"}`
- `400 {"code":"INVALID_LAST_NAME","error":"…"}`
- the existing `401` auth envelope
- generic `500`

Names trim/collapse whitespace. First name is 1–50 Unicode grapheme clusters;
last name is optional or 1–50. Letters, combining marks, apostrophes, hyphens,
and internal spaces are allowed. Control characters, emoji, URLs, and profanity
are rejected. Search normalization is NFKD, combining-mark removal, lowercase,
non-letter/number runs to one ASCII space, then trim/collapse.

## `PUT /auth/me/display-name`

The existing `{ "displayName": "NathanChari" }` request retains its exact
behavior. The optional additive confirmation is:

```json
{ "displayName": "NathanChari", "completeDiscoverableNameSetup": true }
```

Literal `true` requires valid persisted Page-1 data and atomically writes the
display name plus `nameSetupCompletedAt=now()`. Omitted or literal `false` is a
legacy rename and never completes setup. It never changes
`nameSetupOnboardingRequired`.

Additional errors:

- `400 {"code":"INVALID_DISCOVERABLE_SETUP_FLAG","error":"…"}`
- `400 {"code":"DISCOVERABLE_NAME_REQUIRED","error":"…"}`
- `409 {"code":"DISPLAY_NAME_TAKEN","error":"…","suggestedDisplayName":"NathanChari27"}`

A collision changes neither the prior display name nor completion timestamp.
Page 1 invalidates every auth-me variant. Page 2 invalidates every auth-me
variant and the user's cosmetics cache.

## Friends search

`GET /friends/search?q=` remains display-name-only and retains its old
`{id, displayName, profilePhotoUrl}` rows.

Capable clients use `POST /friends/search`:

```json
{ "q": "Nathan Chari" }
```

Success is `200 {"users":[…]}` with at most 20 unique rows:

```json
{
  "id": "user-uuid",
  "displayName": "NathanChari",
  "profilePhotoUrl": null,
  "discoverableName": "Nathan Chari"
}
```

`discoverableName` is omitted or null for incomplete users. Search excludes the
caller and review accounts. It matches handles for all eligible accounts and
matches real names only when setup is complete. Rank order is exact handle,
exact discoverable name, handle prefix, discoverable-name prefix, other
substring; ties are `lower(display_name) NULLS LAST, id`.

The normalized query must contain at least two characters. Each authenticated
account receives exactly 30 valid attempts per UTC-minute fixed window. Invalid
requests do not consume quota. Errors are:

- `400 {"error":"Search query is required","code":"INVALID_SEARCH_QUERY"}`
- `400 {"error":"Search query must be at least 2 characters","code":"SEARCH_QUERY_TOO_SHORT"}`
- `429 {"error":"Too many searches","code":"SEARCH_RATE_LIMITED"}` plus an
  integer `Retry-After` header.

Raw query text is never persisted, logged, or placed in a URL by this endpoint.

## Invitation list additions

Existing `GET /races` and invite-response endpoints remain in place. An invited
race summary adds ISO-string-or-null `createdAt`, `scheduledStartAt`, and
`myInviteExpiresAt`. An invited tournament summary adds ISO `createdAt` and:

```json
{
  "creator": {
    "id": "user-uuid",
    "displayName": "MayaChen",
    "profilePhotoUrl": null
  }
}
```

Those two fields are scoped to `INVITED` tournament rows in `GET /races`.
Accepted/completed rows and frozen create, detail, mutation, and
`GET /tournaments/public` response shapes do not gain them.

No response endpoint is removed or repurposed, and existing error codes remain
authoritative.

## Automatic friendship

With its flag off, all join behavior is unchanged. With it on, a successful
share-token join of a `QUICK_CREATE` race commits participant acceptance and the
friendship decision in one transaction. The existing join response stays
`{participant, raceId}`.

Precedence is: accepted no-op; suppression no-op; declined no-op; pending in
either direction becomes accepted; otherwise create accepted creator→joiner.
Suppression wins over a pending row. A friendship-write failure rolls back the
participant join. Public browse joins and non-quick share joins never auto-link.

Decline atomically writes `DECLINED` plus suppression. Removal atomically deletes
the friendship plus suppression. Manual resend may reopen `PENDING` without
deleting suppression; only explicit recipient acceptance establishes friendship.
Every automatic link source, including both referral attribution paths, consults
suppression.
