# Position-aware mystery-box drops — requirements

Status: **DRAFT — awaiting owner approval**
Author: spec-first pass, 2026-07-26
Owner decision on approach: **subtractive only** (no offense/defense weighting axis)

---

## 1. Summary & user story

> As a player, when I open a mystery box I should never be handed an item that
> does nothing for me because of where I am in the race.

Two real complaints drove this:

1. *"Someone at the bottom of a race has a higher chance of landing rares… if
   they get a lot of Cleanses that's kind of useless."*
2. *"I shouldn't be being fed Runner's High while I'm in first place."*

Both are the same defect. Position enters the drop pipeline in exactly **one**
place — `interpolateOdds` (`src/modules/powerups/powerupOdds.js:29-35`), which
only moves probability mass between the three rarity tiers. Once a tier is
chosen, `pickTypeFromPool` (`:61-72`) is entirely position-blind: its signature
is `(pool, rng, config)` and position is not reachable from any of them.

The result is that the catch-up mechanic actively backfires. For a last-place
player we raise RARE from 0.27 → 0.45 (`balanceConfig.defaults.js:273-276`), and
the RARE tier is where the position-dead items are concentrated.

### The dead items, grounded in the implementations

**Hard-blocked for a leader** — the server throws a 400 and the item is unusable:

| Type | Rejection | Where |
|---|---|---|
| `RED_CARD` | "You cannot use Red Card while you are in the lead" | `usePowerup.js:1505-1507` |
| `SECOND_WIND` | "You cannot use Second Wind while you are in the lead" | `usePowerup.js:2707-2709` |

Both also reject on a **tie at the top** (`usePowerup.js:1508-1510`, `:2707-2709`).
Both are RARE.

**Silent no-ops for a trailer** — item is consumed, nothing happens:

| Type | Why it's dead at the back | Where |
|---|---|---|
| `TRAIL_MINE` | Plants at *your own* step total; only detonates on a player crossing it **from below**. In last place the entire field is already above you, so the crossing test can never fire. | `raceStateResolution.js:505-517` |
| `CLEANSE` | Clears only opponent-inflicted debuffs. Nobody attacks the back of the field → "No debuffs to clear." | `usePowerup.js:2502-2539` (feed line `:2527`) |
| `MIRROR` | Arms a reflect. Never attacked → expires having done nothing, with no feed event at all. | `usePowerup.js:2476-2500` |

`TRAIL_MINE` is a **total** dud for last place (mechanically impossible to fire).
`CLEANSE`/`MIRROR` are probabilistic duds — they depend on being attacked, which
correlates with position but is not determined by it.

### Live bug found while speccing

`dropPool.RARE[0]` is `RED_CARD` (`balanceConfig.defaults.js:158`), and the Lucky
Horseshoe minimum-rarity fallback assigns `config.dropPool[minRarity][0]`
verbatim (`openMysteryBox.js:108-117`). A **leader** who plays a max-level Lucky
Horseshoe and hits that fallback branch is deterministically handed the single
item the server guarantees they cannot use. This is in scope and must be fixed.

### Note on Runner's High specifically

The owner's example is real as a *feel* complaint but is not a mechanical no-op:
`RUNNERS_HIGH` (`usePowerup.js:2678-2700`) is a 2× multiplier on future steps,
which works identically regardless of position. It is low-agency for a leader,
not broken.

**Owner decision (D1): damp it for leaders — do not exclude it.** It is a
down-weight, never a hard exclusion, because the item always functions. This is
a deliberate, owner-approved balance tilt rather than a defect fix, and is the
one place this change intentionally shapes the drop table by feel. Leaders draw
Runner's High less often; they can still draw it.

---

## 2. Scope / non-goals

### In scope
- A position-aware **exclusion** applied when picking a type within an
  already-chosen rarity tier.
- The same exclusion applied to the player-facing odds disclosure, so displayed
  odds and actual roll odds cannot drift.
- Fixing the Lucky Horseshoe `dropPool[minRarity][0]` fallback.
- A mild, config-tunable **down-weight** (not exclusion) for `CLEANSE`/`MIRROR`/
  `STEALTH_MODE` at the back of the field, and for `RUNNERS_HIGH` at the front.
- Verifying and, if needed, fixing the pre-existing `SECOND_WIND` rejection-order
  bug (§3.6) — owner decision D4.

### Explicit non-goals
- **No offense/defense weighting axis.** The existing `OFFENSE_TYPES` /
  `DEFENSE_TYPES` map (`src/modules/powerups/constants/powerupCategories.js:24-58`)
  stays exactly where it is — consumed only by the shop filter pills via
  `getPowerupShopCatalog.js:12,116`. It is not wired into the roller. (It also
  disagrees with comeback intent: `SHORTCUT` is tagged "offense" while
  `SECOND_WIND` and `TRAIL_MINE` are "utility".)
- **No change to `positionOdds`.** The tier curve is untouched.
- **No change to any powerup's mechanics or use-time validation.**
- **No new rubber-banding.** Trailers do not get *more* offense; they simply stop
  being handed items that cannot function. The only probability tilts in the
  whole change are the four owner-approved down-weights in §3.3.
- No frontend work beyond what already ships. No new UI, no new copy.
- No powerup is *hard-excluded* unless the server would refuse to let that player
  use it, or it is mechanically incapable of firing. Everything else is a
  down-weight at most.

---

## 3. Design

### 3.1 The predicate must match the use-time guard exactly

The naive design keys off `normalizedPosition` (0 = leader, 1 = last). **That is
wrong** and must not be used, for two reasons:

1. **Ties.** `RED_CARD` and `SECOND_WIND` reject when
   `leader.totalSteps === myParticipant.totalSteps` — a player sorted into
   position 2 who is *tied* on steps is also blocked. Sort order among equal step
   counts is arbitrary, so a position-index test would exclude the wrong player.
2. **Team races.** `openMysteryBox.js:78-92` collapses team races to rank 1-of-2
   / 2-of-2 for *tier* purposes. But `RED_CARD`'s use-time check targets the
   **individual** race leader. A member of the leading team who is not personally
   the step leader can still play Red Card. Using the collapsed team rank would
   wrongly strip the item from most of the winning team.

Therefore the exclusion predicates are computed from **individual step totals,
in both solo and team races**, independently of the tier position:

- `isStepLeader` — true iff no participant has strictly more steps than you
  (i.e. you are at or tied for the maximum). Matches the `RED_CARD` /
  `SECOND_WIND` rejection condition.
- `isStepLast` — true iff no participant has strictly fewer steps than you.
  Matches "nobody is behind me", the condition that makes `TRAIL_MINE` unable to
  fire.

These two booleans, plus the existing `normalizedPosition`, form the new roll
context.

### 3.2 Where it hooks in

`powerupOdds.js` currently has a documented invariant (header `:41-43`, `:74-76`):
the roller and the odds display must read the same tables or they drift silently.
That invariant is the design constraint.

Introduce one shared function:

```
eligiblePoolFor(rarity, ctx, config) -> { pool: string[], weights: number[] }
```

- Filters `config.dropPool[rarity]` by the position rules in `ctx`.
- Computes each surviving type's weight as
  `weightForType(type, config) × positionMultiplierFor(type, ctx, config)`.
- **Empty-pool guard (required):** if filtering removes every type in the tier,
  return the *unfiltered* pool. The roll must never fail and a tier must never
  become unreachable.

Both call sites consume it:
- `pickTypeFromPool` — the actual roll (`powerupOdds.js:61-72`, called at `:112`)
- `typeOddsForPosition` — the disclosure (`:77-91`, weight lookup at `:83`)

Because the filter operates strictly *within* an already-chosen tier, the tier
distribution from `rarityOddsForPosition` is **mathematically unchanged**. This
is a hard requirement, not a nicety — see §6.

### 3.3 Config block

Added to `DEFAULT_CONFIG` in `balanceConfig.defaults.js`:

```js
positionRules: {
  // HARD EXCLUSIONS. Only for items the server refuses to let this player use,
  // or that are mechanically incapable of firing. Nothing else belongs here.
  //
  // Excluded when the player is at/tied for the most steps — both throw a 400
  // at use time for a leader, so dropping them hands out a brick.
  leaderExcluded: ["RED_CARD", "SECOND_WIND"],
  // Excluded when nobody is behind the player — Trail Mine can only detonate
  // on a player crossing the planter's step total from below.
  lastPlaceExcluded: ["TRAIL_MINE"],

  // DOWN-WEIGHTS. Relative weight multipliers for items that still function but
  // are low-value at one end of the field. 1.0 == no change. All four entries
  // below are owner-approved judgment calls (D1-D3), not defect fixes.
  //
  // Applied toward the FRONT. Runner's High works fine in first place, it just
  // feels flat when you have already won the position (D1).
  leadingDownweight: { RUNNERS_HIGH: 0.5 },
  // Applied toward the BACK. These depend on being attacked, which is rare at
  // the back of the field (D2, D3).
  trailingDownweight: { CLEANSE: 0.5, MIRROR: 0.5, STEALTH_MODE: 0.5 },

  // Normalized position (0 = leader, 1 = last) at which each down-weight group
  // reaches full strength. Between the threshold and mid-field the multiplier
  // lerps toward 1.0, so there is no cliff at any position.
  leadingDownweightFrom: 0.4,   // full strength at/below this
  trailingDownweightFrom: 0.6,  // full strength at/above this
},
```

A type may appear in at most one of the four lists; validation must reject
overlap (a type in both `leaderExcluded` and `leadingDownweight` is a config
authoring error, not a meaningful combination).

**Structural-guard hazard — read before writing this block.** The guard test
`test/services/balanceConfigStructuralGuard.test.js:51` fails the build on *any*
bare three-decimal array under `src/` (`ODDS_ROW = /\[\s*0?\.\d+\s*,\s*0?\.\d+\s*,\s*0?\.\d+\s*\]/`).
The shape above is safe: string arrays and a `{TYPE: number}` object, no decimal
triples. **Do not** reformat it into anything resembling `[0.5, 0.5, 1.0]`.
`balanceConfig.defaults.js` is itself exempt from the walk (`:22-25`), but any
*other* new file under `src/` is not.

### 3.4 Lucky Horseshoe fallback fix

`openMysteryBox.js:108-117` currently does:

```js
rolled = { type: config.dropPool[minRarity][0], rarity: minRarity };
```

Replace the `[0]` index with a real weighted pick from the **position-filtered**
pool for `minRarity`, using the same `ctx`. This both fixes the leader/Red Card
determinism bug and removes the latent trap where reordering `dropPool.RARE`
silently changes what a max Horseshoe awards.

### 3.5a Second Wind rejection order (owner decision D4 — fix in this batch)

Pre-existing, independent of the drop change. `SECOND_WIND`'s leader check throws
from *inside* the effect switch at `usePowerup.js:2707-2709`, i.e. **after** the
coin-deduction / mark-USED preamble. Every other rejection in the file is
documented (`:1556-1558`) as running before consumption specifically so a
rejected player keeps their item — `SIGNAL_JAMMER` even carries an explicit
`{ retainHeld: true }` flag (`:1570`). `RED_CARD`'s equivalent leader check
correctly runs pre-flight at `:1490-1512`.

Required work:
1. **Verify first.** Determine whether the surrounding transaction actually
   unwinds the coin deduction and the `status: "USED"` write when this throws. If
   it does, this is a code-tidiness issue and the fix is a move, not a repair.
2. If it does **not** unwind, this is a live bug: a leader who taps Second Wind
   loses the item and/or coins for a rejected action. Move the check into the
   pre-flight block alongside `RED_CARD`'s, preserving the exact error message
   and 400 status so client-side error handling is unchanged.
3. Regression test either way: a leader attempting Second Wind receives 400 **and**
   still holds the powerup afterwards, asserted through the HTTP endpoint.

Note this bug becomes much harder to reach once leaders stop being dealt Second
Wind from boxes — but it stays reachable, because Second Wind is also obtainable
outside the drop pool. Do not treat the drop change as a fix for it.

### 3.5 Position computation is duplicated — unify the new part

Position is computed twice today, independently:
- `openMysteryBox.js:74-92` (the roll)
- `getRaceProgress.js:96-118` (the disclosure)

They already have to agree. Adding predicates that both need makes that coupling
load-bearing, so `isStepLeader` / `isStepLast` must be derived by **one exported
helper** consumed by both call sites. Do not hand-roll the predicate twice.

Note `getRaceProgress` deliberately computes position from *true* step totals
rather than the illusion-masked board (`:903-906`); the new predicates must use
the same true totals so a stealthed or masked opponent cannot change what you
are eligible to roll.

---

## 4. API contract

**No request or response shape changes.** This is deliberate — it is what makes
the change safe for frozen clients.

`GET /races/:raceId/progress` continues to return:

```jsonc
"powerupData": {
  "dropOdds": {
    "configVersion": 12,
    "position": 4,
    "totalParticipants": 7,
    "rarity":  { "COMMON": 0.31, "UNCOMMON": 0.31, "RARE": 0.38 },
    "byType":  { "PROTEIN_SHAKE": 0.062, "...": 0.0 }
  }
}
```

What changes is only the **values inside `byType`** — an excluded type reports
`0` (or is omitted) for that player, and the freed mass redistributes across the
rest of its tier.

`rarity` values are **unchanged by this feature**.

Every other rarity-carrying payload (`inventory[].rarity`, the open/open-batch
responses, `/powerups/catalog`, the daily-box endpoints) is untouched.

---

## 5. Data model / migrations

**No migration.** No Prisma schema change, no new column, no backfill.

The only persisted change is the content of the `BalanceConfig.config` JSON blob
(`prisma/schema.prisma:1572+`), which is a free-form `Json` column.

Config round-trip constraints that must be respected:
- `mergeOverDefaults` (`balanceConfig.js:41-56`) only recurses into keys present
  in `base` (`:49`). A new block **must** be added to `DEFAULT_CONFIG` or a
  stored partial config will replace rather than merge it.
- Arrays are replaced wholesale, never merged (`:44`).
- Stored configs written before this deploy simply resolve to the new code
  default — a deploy alone is sufficient, no admin save required. This is the
  same guarantee `enforceStoreOnlyExclusion` (`:57-90`) was written to provide.
- `validateConfig` (`:123-401`) is **not** a whitelist and does not strip unknown
  keys, so the block survives a save round trip.

**Admin UI risk (must be verified, not assumed):** the admin balance screen
(`stepv2-frontend/lib/screens/admin_balance_config_screen.dart:1040-1046`) renders
from known blocks and prints "This config carries no X block" for anything it
doesn't know. If that screen reconstructs an object on save rather than
round-tripping the raw JSON, an admin save would **drop `positionRules`**. This
is the exact class of failure as the documented `renderMetadata` sanitizer wipes.
The backend agent must confirm the save path preserves unknown keys before this
ships; if it does not, `positionRules` needs either admin-screen support or an
explicit server-side merge-preserve.

---

## 6. Backward compatibility & rollout

### The one hard invariant
`odds_sheet.dart:63-77` returns `null` — **hiding the entire odds sheet** — if the
`rarity` block fails `_parseDistribution` (non-empty, all finite ≥ 0, sums to
1.0 ± 0.01). Because filtering happens strictly *within* a tier, the `rarity`
block is untouched and this cannot trigger. Any implementation that changes tier
probabilities instead of within-tier weights violates the spec.

`byType` is explicitly parsed as unnormalized slices that do **not** sum to 1
(`odds_sheet.dart:72-74`) and rendered as a plain sorted list (`:328-336`), so
a type reporting 0 or vanishing degrades cleanly on every shipped client.

### Frozen old clients
- No new field is read, so **no minimum app version is required**.
- Unknown/missing types in `byType` degrade to the raw enum string via
  `PowerupCopy.nameFor`; they do not crash.
- The bundled reel filler (`case_opening_strip.dart:519-573`) is cosmetic decoy
  tiles only — the real result is planted at `_resultPosition` (`:514`,
  `:592-594`). It is already stale versus the live config; this change does not
  make it worse.
- Old clients keep rendering whatever `byType` they are given, including
  per-player-different values, which is already the norm (odds are computed
  per-request from each user's own position, `getRaceProgress.js:96-135`).

### Deploy order
Backend only. No app release is coupled to this. No feature flag is strictly
required, but ship behind a config-level off switch: an empty `leaderExcluded` /
`lastPlaceExcluded` and `trailingDownweight: {}` restores exact current
behaviour, editable without a deploy.

### Player-visible side effect worth accepting
Two players in the same race will see different `byType` numbers. This is
already true (position drives the tier odds), and the payload already carries
`position` and `totalParticipants` (`getRaceProgress.js:130-131`, parsed at
`odds_sheet.dart:79-80`) to explain it.

---

## 7. Test plan (tests FIRST, before any logic)

Per CLAUDE.md: integration tests are the default; unit tests only where an
integration test structurally cannot express the property. Existing tests must
not be modified or deleted.

### Integration (`test/integration/`) — the primary proof
1. **Leader never rolls a brick.** Seed a race, make user A the clear step
   leader, open N boxes through the real `POST /races/:id/powerups/:id/open`
   endpoint. Assert `RED_CARD` and `SECOND_WIND` never appear in any response.
2. **Tied-for-first is also protected.** Two users on identical step totals; both
   must be excluded — this is the case a position-index implementation gets
   wrong.
3. **Last place never rolls Trail Mine.** Same shape, asserting `TRAIL_MINE`
   absent for the bottom player.
4. **Mid-pack is unaffected.** A player who is neither leader nor last can still
   roll all three types across enough opens.
5. **Team race uses individual predicates.** In a team race, a member of the
   *leading team* who is not the individual step leader **can** still roll
   `RED_CARD`. This is the regression the naive design causes.
6. **Disclosure matches the roll.** `GET /races/:id/progress` for the leader
   reports `byType.RED_CARD === 0` (or absent), and the `rarity` block still sums
   to 1.0 ± 0.001. Assert on the HTTP response, not a helper's return value.
7. **Lucky Horseshoe fallback.** Leader with an active max Horseshoe forced down
   the `minRarity` fallback branch receives a usable RARE, never `RED_CARD`.
8. **Config off switch.** With `positionRules` cleared, a leader can roll
   `RED_CARD` again — proves the kill switch works.
9. **Down-weights are tilts, never removals.** Over a large sample of opens, a
   leader still rolls `RUNNERS_HIGH` at least once, and a last-place player still
   rolls `CLEANSE`, `MIRROR` and `STEALTH_MODE` at least once — at a visibly
   reduced rate versus mid-pack. This is the test that distinguishes D1-D3 from
   an exclusion and would catch a mis-implementation that drops them to zero.
10. **Second Wind rejection retains the item** (D4, §3.5a): a leader POSTs use on
    Second Wind, receives 400, and a follow-up `GET /races/:id/inventory` still
    shows the powerup HELD with coins unchanged.

### Unit (justified: many positional cases, cheap to enumerate)
11. `eligiblePoolFor` empty-pool guard — a config that excludes an entire tier
    falls back to the unfiltered pool rather than returning null.
12. `typeOddsForPosition` and `pickTypeFromPool` agree: over a large seeded-RNG
    sample the empirical type distribution matches the disclosed `byType` within
    tolerance, at leader, mid, and last positions. This is the anti-drift test the
    module's own header demands.
13. `isStepLeader` / `isStepLast` tie handling, single-participant race, and
    all-equal-steps field.
14. Down-weight interpolation has no cliff: the multiplier for a type in
    `trailingDownweight` is 1.0 at mid-field, reaches full strength at
    `trailingDownweightFrom`, and moves monotonically between the two. Same for
    `leadingDownweight` in the opposite direction.
15. Config validation rejects a type appearing in more than one of the four
    lists (§3.3).

### Guards that must stay green (do not edit)
- `test/services/balanceConfigStructuralGuard.test.js` — especially `ODDS_ROW`
  (`:51`), see §3.3.
- `test/services/shellBlockableStructuralGuard.test.js:30-51` — every
  `OFFENSE_TYPES` member in exactly one of `dropPool` / `storeOnlyTypes`.
- `test/utils/powerupOdds.test.js` — existing tier-membership and interpolation
  assertions. Note `:42` ("last place gets more rares") must still pass; this
  change does not touch the tier curve.
- `test/integration/balance-config-player.test.js:150` — `dropOdds` rarity sums
  to 1.0.

---

## 8. Acceptance criteria

- [ ] A player at or tied for the step lead can never be dealt `RED_CARD` or
      `SECOND_WIND` from a mystery box, in solo or team races.
- [ ] A player with nobody behind them can never be dealt `TRAIL_MINE`.
- [ ] `CLEANSE` / `MIRROR` / `STEALTH_MODE` are damped, not removed, at the back
      of the field; `RUNNERS_HIGH` is damped, not removed, at the front. All four
      remain reachable at every position (test 9).
- [ ] A leader rejected on Second Wind keeps the powerup and their coins (D4).
- [ ] The `rarity` tier distribution is byte-identical to today for every
      position — verified by the existing odds tests.
- [ ] `byType` disclosure and actual roll frequencies agree within tolerance at
      leader / mid / last (test 10).
- [ ] Lucky Horseshoe's `minRarity` fallback performs a real weighted pick from
      the filtered pool; the `[0]` index is gone.
- [ ] `isStepLeader` / `isStepLast` are computed by one shared helper used by both
      `openMysteryBox` and `getRaceProgress`.
- [ ] Clearing `positionRules` in config restores exact pre-change behaviour with
      no deploy.
- [ ] No Prisma migration. No API shape change. No app-version gate.
- [ ] Admin-save round trip preserves `positionRules` (§5) — verified, not assumed.
- [ ] No existing test modified or deleted.
- [ ] `npm run test:unit` and `npm run test:integration` run separately, never
      bare `npm test`, never against the prod DB.

---

## 9. Owner decisions (resolved — zero open questions)

**Approach.** Subtractive only. No offense/defense weighting axis; the existing
`powerupCategories.js` map stays confined to the shop filter pills.

**D1 — `RUNNERS_HIGH`: damp for leaders.** Owner opted to honour the originating
complaint despite it not being a mechanical no-op. Implemented as a down-weight
(`leadingDownweight`), never a hard exclusion, since the item always functions.
Explicitly recorded as a balance tilt, not a defect fix.

**D2 — `CLEANSE`/`MIRROR` damp strength: mild, 0.5**, reaching full strength at
normalized position 0.6 and lerping to 1.0 by mid-field.

**D3 — `STEALTH_MODE`: in scope**, added to `trailingDownweight` at the same 0.5.
Soft dud, so down-weight only.

**D4 — `SECOND_WIND` rejection-order bug: verify and fix in this batch.** See
§3.5a for the required verify-then-fix sequence and the regression test.

**Standing constraint from the approach choice:** a type may only be *hard
excluded* if the server would refuse the use, or the mechanic cannot fire. Every
other position adjustment is a down-weight. Any future addition to
`leaderExcluded` / `lastPlaceExcluded` must meet that bar.

---

## 10. Revision log

**Phase 2, pass 1 — correctness of the exclusion predicate.**
The first draft keyed exclusions off `normalizedPosition <= 0` / `>= 1`. Two
defects found and fixed in §3.1: (a) it misses the **tie** case that both
`RED_CARD` and `SECOND_WIND` explicitly reject on, because sort order among equal
step totals is arbitrary; (b) it breaks **team races**, where the tier position is
collapsed to 1-of-2 / 2-of-2 but the use-time leader check is individual — the
naive version would strip Red Card from most of the winning team. Predicates are
now defined as `isStepLeader` / `isStepLast` over true individual step totals and
are required to come from one shared helper (§3.5).

**Phase 2, pass 2 — blast radius and hidden couplings.**
Added: (a) the **empty-pool guard** in §3.2 — without it an aggressive config
could make a whole tier unreachable and return `null` from the roll; (b) §6's
hard invariant that filtering must stay *within* a tier, because changing tier
probabilities makes the `rarity` block miss the 1.0 ± 0.01 check and
`odds_sheet.dart:63-77` then hides the **entire** odds sheet, not just one row;
(c) the `ODDS_ROW` structural-guard hazard in §3.3, which fails the build on any
bare decimal triple under `src/`; (d) the **admin-save whitelist risk** in §5,
matching the documented `renderMetadata` sanitizer-wipe history; (e) the Lucky
Horseshoe `dropPool[minRarity][0]` bug (§3.4) — found by reading, not reported by
research, and the single sharpest instance of the defect since it is
deterministic rather than probabilistic; (f) test 12, the roll-vs-disclosure
agreement test, which is the only thing preventing the two code paths from
drifting apart as the module header warns.

**Phase 3 — owner interview, folded in.**
Four decisions recorded in §9. Structural consequences: the config block in §3.3
was reorganised from one down-weight group into an explicit
**hard-exclusion vs down-weight** split, because D1 and D3 add items that still
function and must never be hard-excluded — without the split, a later editor
would have had no principle for deciding which list a new type belongs in. That
principle is now written down as a standing constraint in §9 and as a non-goal in
§2. Added `leadingDownweight` / `leadingDownweightFrom` for D1 (the first
front-of-field rule; every prior rule was rear-of-field), an overlap-rejection
validation rule, §3.5a for D4, and tests 9, 10, 14, 15 — test 9 in particular
exists because D1-D3 are tilts and a plausible mis-implementation silently turns
a 0.5 multiplier into a removal, which no other test would catch.
