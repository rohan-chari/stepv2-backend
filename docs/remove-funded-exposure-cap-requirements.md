# Remove funded-exposure admission cap

## Summary & user story

Allow a user to create or join additional app-funded races regardless of their
existing aggregate funded-race exposure. This removes the cross-competition
funded-exposure admission guard that currently rejects with
`FUNDED_EXPOSURE_LIMIT`.

## Scope / non-goals

In scope: remove enforcement of both aggregate funded exposure and daily funded
exposure limits for user-created funded races and funded user tournaments.

Out of scope: deleting historical exposure columns, changing prize formulas,
changing seeded-race enrollment, changing participant limits, changing legacy
buy-in races, changing frontend UI, or changing coin payout amounts. The
implementation must preserve the existing seeded enrollment policy at its
caller boundaries, including the independent seeded-bucket guard; this change
must not accidentally make seeded enrollment unlimited.

The phrase “remove the cap” is interpreted as removing only the funded-exposure
admission cap, not every unrelated race or abuse limit. If that interpretation
is wrong, stop before implementation.

## Current implementation evidence

- `src/modules/races/services/fundedExposure.js` defines the 600-coin and
  80-coins/day limits and rejects in `reserveFundedExposures`.
- Admission is called by race and tournament creation/join paths through the
  shared funded-exposure service.
- Exposure stamps remain useful historical accounting data and must remain
  readable; the change is enforcement-only.
- Production currently has Shreyt29 at approximately 950 total exposure and
  100 coins/day, confirming the requested behavior.

## API contract and compatibility

No endpoint shape changes. Existing clients continue sending the same requests.
The backend stops returning `FUNDED_EXPOSURE_LIMIT` for these funded admission
paths. Older clients remain compatible because they already handle successful
funded-race creation/join responses; no new field or endpoint is required.

The required HTTP coverage is: funded race creation, public race join,
share-link race join, race invite acceptance, funded tournament creation,
public tournament join, share-link tournament join, and tournament invite
acceptance. Existing success shapes/statuses, full/capacity errors, buy-in
errors, authorization errors, and transactional no-partial-membership behavior
must remain unchanged. `FUNDED_EXPOSURE_LIMIT` must disappear only from the
in-scope funded admission paths.

The error code remains available for any unrelated caller that still explicitly
uses the conflict helper, unless implementation review proves that no caller
needs it. No client-side flag or release flag may be added.

## Data model / migrations

No migration. Keep `funded_exposure_millicoins` and
`funded_exposure_rate_millicoins_per_day` as historical settlement/accounting
stamps. Keep `FundedExposureGuard` rows solely as per-user concurrency locks;
they are not mutable exposure counters and are not serialized to clients. Do
not rewrite existing memberships or run a production data update. No Redis
surface is introduced.

## Implementation plan

1. Add integration tests first for every listed race/tournament route, proving
   that a user above both old and current exposure thresholds is admitted and
   that no partial membership is written.
2. Add regression tests proving seeded enrollment retains its caller-level
   policy, legacy buy-in admission remains unchanged, and unrelated capacity,
   authorization, and buy-in errors remain unchanged.
3. Remove enforcement from user-funded admission while retaining locking, stamp
   calculation, and persistence; preserve the independent seeded-bucket guard.
4. Update unit tests and `docs/economy.md` to describe unlimited funded
   admission and its abuse/economy implications.
5. Run backend unit and integration suites against a dedicated test database,
   then run the code-reviewer.

## Economy analysis requirements

Before implementation, the game analyst must assess the removal's impact on
coin issuance, shared-step duplication, powerup/box concentration, and abuse
vectors, and record required monitoring or safeguards in `docs/economy.md`.
The analyst must specify concrete metrics, alert thresholds, an owner, and
code-only rollback criteria. No runtime feature flag or kill switch may be
introduced.

### Economy review result — approval blocker

The game-analyst review returned `UNSOUND` for unlimited funded memberships.
Its production-backed estimate is that one additional 1-day, 2-player race
adds 20 minted coins and 2.89 median-player boxes per day; if 372 live funded
users each add one, net issuance rises from approximately 8,728 to 16,168
coins/day. It also identified unlimited duplicated walking, collusion, and
tournament tie farming as critical/high abuse paths.

The analyst requires one of these before implementation:

1. Retain an atomic per-user ceiling or equivalent funded-payout velocity
   budget, with five live funded memberships identified as the highest
   defensible bound; or
2. Require at least 2,000 raw steps per entrant before funded payout
   eligibility, plus the specified aggregate monitoring thresholds.

The user must explicitly approve either a replacement safeguard or an
exceptional unlimited-cap release despite the `UNSOUND` verdict. The latter
requires documenting acceptance of the quantified risk; it does not add a
runtime flag or kill switch.

Approval record: the user repeated the directive “remove the cap” after the
`UNSOUND` verdict and selected the unlimited-cap path. That directive is the
explicit risk acceptance for this exceptional release.

## Rollout / backward compatibility

Backend-only deployment; no app release is needed. Deploy backend first, with
no migration. During the two-worker rolling reload, old workers may still
return `FUNDED_EXPOSURE_LIMIT`; deployment verification must confirm both HTTP
workers report the new commit/behavior before declaring the change live. If
verification fails, stop and roll back by reloading the previous commit; do not
change production data. Frozen clients continue to use the same request and
response contracts. Production deployment requires separate explicit approval
after the code and tests are ready.

## Acceptance criteria

- A funded race admission is not rejected because aggregate or daily funded
  exposure is high.
- A funded user tournament admission has the same behavior.
- All eight specified public/invite admission paths are covered.
- Seeded enrollment and legacy buy-in behavior remain unchanged.
- Exposure stamps and locking remain intact.
- Legacy buy-in behavior is unchanged.
- Required integration tests fail before the implementation and pass after it.
- Backend tests pass; no production data is changed; deployment is explicitly
  reported as ready but not performed.

## Revision log

- Initial draft: clarified that “cap” means the shared funded-exposure guard,
  preserved historical stamps, and separated it from unrelated race limits.
- Gap pass 1: added legacy buy-in compatibility, no-migration/no-data-update
  constraints, and explicit test-first HTTP coverage.
- Gap pass 2: added tournament coverage and economy-analysis requirements.
- Architect review: preserved seeded caller-level guards, expanded all public
  and invite route coverage, clarified mixed-worker rollout, and separated
  historical stamps from lock rows.
- Game-analyst review: marked unlimited admission `UNSOUND`, quantified the
  issuance/box-farming impact, and added the replacement-safeguard or explicit
  risk-acceptance gate.
