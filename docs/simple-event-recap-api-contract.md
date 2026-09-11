# Simple event recap — locked API contract

Approved source: frontend `docs/simple-event-recap-requirements.md`, sections 1, 4 and 5.
Contract locked for backend/frontend parallel implementation. No release flag.

Both iOS and Android advertise `simple_event_recap_v1` in `X-Client-Features`.
All endpoints require existing authentication. No existing endpoint gains required input.

## GET /home/event-recap

HTTP 200, exactly one envelope:

```json
{"state":"pending","event":{"id":"event-id","revision":3,"startsAt":"2026-09-11T22:00:00.000Z","endsAt":"2026-09-11T22:30:00.000Z","expiresAt":"2026-09-12T04:00:00.000Z","raceCount":3}}
```

```json
{"state":"ready","globalEventSummary":{"id":"recap-id","eventId":"event-id","extraRaceSteps":3000,"raceCount":3,"settledAt":"2026-09-11T22:40:00.000Z","expiresAt":"2026-09-12T04:00:00.000Z","validForMs":19200000}}
```

```json
{"state":"none"}
```

## POST /home/event-recap

```json
{"eventId":"event-id","revision":3,"rawSteps":1000}
```

HTTP 200 ready/none envelopes above. Integer, nonnegative rawSteps; product must
fit signed 32-bit extraRaceSteps. Server owns race count, window and multiplier.
First committed result is immutable. Acknowledged/suppressed/expired/superseded
saved results return none. Unknown additional economic/identity/window fields
are never trusted.

Errors use existing AppError response shape:

- 401 existing authentication errors.
- 400 INVALID_INPUT: malformed body, raw count or numeric overflow.
- 404 NOT_FOUND: unknown or not-owned event.
- 409 EVENT_NOT_READY: event has not ended.
- 409 EVENT_CHANGED: input revision or candidate stamp changed/unavailable.
- 410 EVENT_EXPIRED: expired/superseded unsaved candidate.
- 500 existing generic transient failure.

The latest completed daily 2× entitlement is selected before any visibility
filter. Expiry is midnight in its captured timezone. A saved replay is never
recalculated. No earlier recap resurfaces after latest consumption.

## Permanent old-client compatibility

Both Home shapes keep optional `globalEventSummary` with the exact ready payload
above. POST `/home/global-event-summaries/:id/acknowledge` keeps HTTP 200
`{"acknowledged":true}`, 409 ALREADY_ACKNOWLEDGED and owner-safe 404.

GET `/home/global-event-summary-work/:id` preserves authentication, capability
and UUID validation, then returns HTTP 200
`{"state":"EXPIRED_UNDELIVERED","expiresAt":"<server-now-UTC>"}` uniformly.
It never queries retired storage. New syncs omit old work receipts; stored
historical idempotency responses remain unchanged.

Old successful sync-v2/sample uploads can save the same formula only from a
bounded, closed, contiguous, nonoverlapping accepted sample union covering the
whole event window. Gaps, excess samples and failed/daily-only writes defer.
Clients declaring simple_event_recap_v1 finalize only via explicit POST.

New clients silently defer on older-server 404 or malformed responses, and never
fall back to retired work polling. Display-only raw input cannot alter scoring,
step data, rewards, coins or other users.
