# Home Suggested Races API contract

**Status:** Locked for implementation on 2026-08-11.

This document pins the backend interface approved in
`stepv2-frontend/docs/home-suggested-races-requirements.md`. The endpoint is
additive. Frozen clients continue to use `GET /home/race-card`,
`GET /races/featured`, `GET /races/public`, and
`GET /tournaments/public`; none of those contracts may change as part of this
feature.

## Request

`GET /home/suggested-races`

- Authentication: the existing bearer session token is required.
- Query parameters: none are required.
- Client capabilities: `X-Client-Features` continues to be an optional,
  comma-separated feature header. `team_races` controls team-race eligibility
  and `tournaments` controls tournament eligibility. `home_suggested_races` is
  recognized for rollout visibility but is not required to call or authenticate
  the endpoint.

## Success response

Status: `200`

The top-level object has exactly these keys:

```json
{
  "suggestions": [],
  "resolved": {
    "featuredRaces": true,
    "publicRaces": true,
    "tournaments": true
  }
}
```

`suggestions` is already ordered:

1. at most one eligible `DAILY_10K` featured race;
2. at most one eligible `WEEKLY_50K` featured race;
3. at most four eligible public races;
4. at most four eligible tournaments, with featured tournaments before
   user-created tournaments.

The maximum is ten entries. Empty categories do not increase another
category's cap. Inside public races, order is `createdAt DESC, id ASC`. Inside
each tournament group, order is `createdAt DESC, id ASC` before the combined
four-tournament cap.

All three `resolved` values are required literal Booleans on every `200`.
Entries from a failed branch are omitted; the server does not return cached
entries. Ownership is exact:

- `resolved.featuredRaces` owns every `FEATURED_RACE` entry;
- `resolved.publicRaces` owns every `PUBLIC_RACE` entry;
- `resolved.tournaments` owns every `TOURNAMENT` entry.

Without the `tournaments` feature, `resolved.tournaments` is `true` and the
response contains no `TOURNAMENT` entries.

### `FEATURED_RACE`

Every featured entry has exactly these keys and types:

```json
{
  "kind": "FEATURED_RACE",
  "id": "race-id",
  "seedKind": "DAILY_10K",
  "name": "Daily 10K",
  "status": "ACTIVE",
  "endsAt": "2026-08-12T04:00:00.000Z",
  "participantCount": 42,
  "maxParticipants": 100,
  "isFull": false,
  "powerupsEnabled": true,
  "prizePool": null,
  "finishReward": null,
  "joinAction": "JOIN"
}
```

- `id` is a nonempty string mapped from canonical `raceId`.
- `seedKind` is exactly `DAILY_10K` or `WEEKLY_50K`.
- `name` is a nonempty string; `status` is exactly `ACTIVE`; `endsAt` is an
  ISO date-time string.
- `participantCount` is a nonnegative integer.
- `maxParticipants` is a positive integer. Canonical unlimited featured races
  use the existing compatibility value `100`.
- `isFull` and `powerupsEnabled` are Booleans.
- `prizePool` and `finishReward` are canonical objects or `null`.
- `joinAction` is exactly `JOIN`.

An `ACTIVE` live seed whose `endsAt` is not in the future is ineligible. A full
seed or a seed for which the viewer has an `ACCEPTED` or `INVITED` participant
row is ineligible. Hiding a current seed never substitutes the upcoming race.
Review/demo visibility follows the existing release-channel rules.

### `PUBLIC_RACE`

Every public entry has exactly these keys and types:

```json
{
  "kind": "PUBLIC_RACE",
  "id": "race-id",
  "name": "Lunch Break Sprint",
  "status": "PENDING",
  "maxDurationDays": 1,
  "endsAt": null,
  "startedAt": null,
  "participantCount": 3,
  "maxParticipants": 10,
  "buyInAmount": 0,
  "payoutPreset": "TOP_HALF_GRADED",
  "powerupsEnabled": true,
  "prizePool": null,
  "isTeamRace": false,
  "teamSize": null,
  "teamAName": null,
  "teamBName": null,
  "teams": null,
  "joinAction": "JOIN"
}
```

- `id` and `name` are nonempty strings.
- `status` is exactly `PENDING` or `ACTIVE`.
- `maxDurationDays` is a positive integer.
- `endsAt` and `startedAt` are ISO date-time strings or `null`.
- `participantCount` is a nonnegative integer.
- `maxParticipants` is a positive integer or `null`.
- `buyInAmount` is a nonnegative integer; `payoutPreset` is a string or
  `null`.
- `powerupsEnabled` and `isTeamRace` are Booleans.
- `prizePool` is the canonical object or `null`.
- `teamSize` is a positive integer or `null`; `teamAName` and `teamBName` are
  strings or `null`; `teams` is the canonical object or `null`.
- `joinAction` is exactly `JOIN`.

Eligibility exactly matches public discovery: public `PENDING`/`ACTIVE` under
the existing individual/team rules, not full, not a tournament matchup, not
review-created, supported by the client's team capability, and with no viewer
participant row. Home additionally requires `seedId IS NULL`. Every predicate
is applied in Postgres before `LIMIT 4`.

The internal public query gains optional `excludeSeeded` and suggestion-mode
inputs, both defaulting to `false`; `/races/public` omits them. Seed exclusion
must remain correct when the featured branch fails.

### `TOURNAMENT`

Every tournament entry has exactly these keys and types:

```json
{
  "kind": "TOURNAMENT",
  "id": "tournament-id",
  "seedKind": "DAILY_DASH",
  "name": "Daily Dash",
  "status": "PENDING",
  "bracketSize": 8,
  "matchupDurationDays": 1,
  "acceptedCount": 5,
  "buyInAmount": 0,
  "potCoins": 800,
  "prizePool": null,
  "powerupsEnabled": true,
  "powerupStepInterval": 2000,
  "createdAt": "2026-08-11T20:00:00.000Z",
  "joinAction": "JOIN"
}
```

- `id` and `name` are nonempty strings; `status` is exactly `PENDING`.
- `bracketSize` and `matchupDurationDays` are positive integers.
- `acceptedCount`, `buyInAmount`, and `potCoins` are nonnegative integers.
- `seedKind` is a string or `null`.
- `prizePool` is the canonical object or `null`.
- `powerupsEnabled` is Boolean; `powerupStepInterval` is a positive integer or
  `null`.
- `createdAt` is an ISO date-time string.
- `joinAction` is exactly `JOIN`.

Only canonical tournament summaries whose server `joinable` value is literal
`true` are eligible. This excludes viewer-owned/invited brackets, full
brackets, and another featured bracket of a seed in which the viewer remains
alive. Every predicate is applied in Postgres before the combined `LIMIT 4`.
The Home contract never adds `scheduledStartAt`.

## Partial resolution

The three category reads run concurrently under `Promise.allSettled`.
Rejection of one optional branch keeps status `200`, sets only that branch's
resolution bit to `false`, and omits only entries owned by that branch:

```json
{
  "suggestions": [],
  "resolved": {
    "featuredRaces": true,
    "publicRaces": false,
    "tournaments": true
  }
}
```

The endpoint performs at most three category database round-trips, has no
per-card query, and returns at most 1 + 1 + 4 + 4 rows. Eligibility precedes
every category limit, so arbitrarily many newer ineligible rows cannot hide an
older eligible row.

## Errors

Authentication and unexpected route-level errors use the existing authenticated
`AppError`/error-middleware envelope and status codes. Category-query failures
are partial-resolution `200` responses as described above, not route errors.

## Compatibility lock

- No migration is required.
- `GET /home/race-card` remains byte-compatible.
- `GET /races/featured` remains byte-compatible.
- `GET /races/public` remains byte-compatible; its internal new inputs default
  to `false` and the route does not pass them.
- `GET /tournaments/public` remains byte-compatible.
- In particular, legacy `/tournaments/public` summaries do not gain
  `createdAt` or `creator`; the new endpoint sources its required tournament
  `createdAt` independently.
- Old clients never call the new endpoint and ignore the new feature token.
- New clients can treat a definite `404` as endpoint absence and use their
  specified legacy fallback. That fallback must tolerate legacy tournament
  summaries having no `createdAt`. Other errors do not select fallback.
