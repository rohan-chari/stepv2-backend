# Enabled powerup concurrency test plan

Status: proposed integration tests; not implemented or executed. No production changes.

## Scope and evidence

Production catalog read at 2026-09-08T15:43:41.940Z using a read-only transaction:
release `3b241ffbb3bfcbaeea5153d18f1efd6e69a293a4`, active balance config version 5.
Shop eligibility is `active=true`, `test_only=false`, subject to client feature
gates. Race eligibility below is the configured drop pool after default
store-only exclusions, subject to client, team and position gates. It does not
mean every item can drop for every runner in every position.

- Shop (6): RAINSTORM, LEECH, DEFENSE_SCAN, HITCHHIKE, QUICK_RINSE, GHOST_PEPPER.
- Race drops (20): PROTEIN_SHAKE, TRAIL_MIX, DETOUR_SIGN, RUNNERS_HIGH,
  PINECONE_TOSS, LEG_CRAMP, STEALTH_MODE, WRONG_TURN, RALLY_FLAG, RED_CARD,
  SECOND_WIND, COMPRESSION_SOCKS, LUCKY_HORSESHOE, TRAIL_MINE, SNEAKY_SWAP,
  SHORTCUT, CLEANSE, MIRROR, POWER_OUTAGE, DECOY.
- RALLY_FLAG is team-only. Signal Jammer and other disabled powerups are outside
  this matrix. Outage's restriction on using powerups remains in scope.
- X-Ray is DEFENSE_SCAN; Pickpocket is SNEAKY_SWAP. Pickpocket steals an item;
  it is not a mutual inventory swap.

Mechanics checked against that release's
`src/modules/powerups/commands/usePowerup.js`,
`src/modules/powerups/constants/powerupGating.js`,
`src/modules/powerups/powerupOdds.js`, and
`src/modules/economy/balanceConfig.defaults.js`. See also
[race lock research](race-lock-concurrency-research.md).

## Hypothesis and interpretation

Current exclusive job-row and race-row guards serialize same-race powerup uses.
Participant lock narrowing alone does not remove that serialization. The proposed
next experiment is shared race guards for audited local actions, exclusive locks
for their complete participant/effect/inventory dependencies, and exclusive race
guards for broad operations and scoring/lifecycle writers.

An overlap test passes only when the second independent HTTP action commits
while the first action remains paused inside its transaction. Both succeeding
eventually does not establish concurrency. A conflict test passes when the
second waits and then revalidates against committed state, or safely rejects
without partial writes. Run both transaction orders.

"Local candidate" below is a hypothesis, not approval to narrow that handler.
Linked effects, redirects, wallet updates and downstream hooks can expand the
dependency set. Rank-dependent and broad operations retain exclusive guards in
the initial experiment. Correctly waiting is a passing result for those cases.

## Shop-enabled cases

A, B, C and D are distinct accepted, active runners in one race unless stated.
Seed valid scores, inventory capacity and balances; supply targets only where
the public API requires them.

| Powerup | Valid combination / success assertion | Conflict and rejection cases | Initial treatment |
| --- | --- | --- | --- |
| Rainstorm | A uses Rainstorm while C uses Protein Shake. Both outcomes must match one complete serial ordering; repeat with mixed Socks, Mirror and Decoy defenses. | Storm versus B activating Socks; two storms from the same caster; no eligible opponents. Preserve current defense precedence and caster stacking rule. | Broad guard; no same-race overlap requirement. |
| Leech | A attaches to B while C attaches to D; score later steps through the real sync path and check both transfers. | A and C attach to B: only the permitted live link survives, losing request preserves/refunds its item. Mirror must not reflect this shop attack; Socks can block it. Repeat cap checks after Decoy redirect and versus Cleanse. | Linked dependency audit before narrowing. |
| X-Ray | A scans a race containing Socks, Mirror and Decoy; verify the opponent defense snapshot and item consumption, with no scan feed event or active scan effect. | Scan versus B activating/consuming a defense; response must correspond to a coherent permitted ordering. In teams, omit teammates. Duplicate scanner use cannot consume twice. | Broad consistent read initially; do not assume a read-only effect means a write-free command. |
| Hitchhike | A links to B while C links to D; subsequent sync copies steps to the correct riders without subtracting from hosts. | Two riders claim the same host; same rider claims two hosts; Decoy redirects onto an occupied host. Rejection must preserve the Decoy, Socks, inventory and coins. Mirror does not reflect the shop attack. | Linked dependency audit before narrowing. |
| Quick Rinse | A has Rainstorm, C has Wrong Turn; both rinse their own effects. Only remaining timed debuff windows are shortened. | Two rinses by A: first succeeds, second respects cooldown. No eligible debuffs rejects. Rinse versus new attack/expiry/Cleanse must use fresh effect state; self-buffs remain untouched. | Local candidate, but linked-effect scoring boundaries need audit. |
| Ghost Pepper | A uses Ghost Pepper while C uses Runner's High; score samples before boost, during boost, during burnout and after expiry. | Two peppers by A: reject stacking during either boost or burnout. An expired but not yet retired row must not block reuse. Cleanse must not remove self-inflicted burnout. | Local candidate plus scoring-boundary coverage. |

## Race-drop-enabled cases

| Powerup | Valid combination / success assertion | Conflict and rejection cases | Initial treatment |
| --- | --- | --- | --- |
| Protein Shake | A uses Protein Shake while C uses Trail Mix; both independent bonuses survive. | A uses Protein Shake while B Shortcuts A; final totals must match the actual order. Duplicate use awards once. | Local candidate. |
| Trail Mix | A uses Trail Mix while C uses Protein Shake; each player's own history determines the bonus. | A uses a previously unused type concurrently with Trail Mix: count it only if its successful use precedes Trail Mix. Repeated uses of one type do not inflate distinct-type count. | Local candidate with actor history locked. |
| Detour Sign | A targets B while C targets D; both effects can commit independently. | A and C target B: no duplicate active Detour; defense activation, Stealth and redirect races must revalidate. | Targeted local candidate. |
| Runner's High | A activates it while C activates Ghost Pepper. | Two activations by A must not stack. Sync at the activation/expiry boundary must neither lose nor double-count boosted steps. | Local candidate. |
| Pinecone Toss | A tosses FRONT while another runner changes score; choose the adjacent runner from the valid ordered state. Repeat BEHIND and team enemy adjacency. | Missing/invalid direction, explicit target, no runner in that direction. A score change must not leave a stale victim selection. | Rank-dependent; broad guard initially. |
| Leg Cramp | A targets B while C targets D; each receives its own effect. | Two cramps on B reject stacking. Cramp versus Wrong Turn on B: direct second use rejects; indirect Mirror/Decoy landing preserves the existing mutually exclusive-effect rule. | Targeted candidate after boundary/redirect audit. |
| Stealth Mode | A activates Stealth while C uses Protein Shake. | B Shortcuts A versus A activating Stealth: Stealth-first rejects the manual target; attack-first applies normally. Red Card auto-targeting a stealthed leader remains allowed. Duplicate Stealth rejects. | Local candidate; synchronize targetability reads. |
| Wrong Turn | A targets B while C targets D; later step scoring applies each reversal correctly. | Two Wrong Turns on B; Wrong Turn versus Leg Cramp; expiry/Cleanse versus sync cannot leave both conflicting effects active or apply reversal past its boundary. | Targeted candidate after boundary/redirect audit. |
| Rally Flag | A activates for their team while an opponent uses Protein Shake; only eligible teammates receive the buff. | Two teammates activate flags: one succeeds, one rejects with item preserved. Solo use rejects. Forfeited members are excluded. Flag versus settlement must be ordered. | Team-wide; broad guard initially. |
| Red Card | A uses Red Card while C's Protein Shake changes the leader; target must match the serialized ranking. | Tied leaders, caster leading in solo race, explicit target, no eligible enemy. Teams target the top eligible enemy rather than a teammate. | Rank-dependent; broad guard initially. |
| Second Wind | Trailing A uses it while leader B uses Protein Shake; compute the bonus using the gap from the valid ordering. | A is leader or tied for lead: reject without consumption. A concurrent Shortcut changing that gap cannot yield a stale bonus. | Rank-dependent; broad guard initially. |
| Compression Socks | A equips Socks while C equips Mirror; unrelated activations are overlap candidates. | Two attacks against B's one Socks shield: consume it once; the next otherwise-valid attack sees no shield. Two equips cannot create duplicate shields. | Local candidate; lock participant even when no effect row exists yet. |
| Lucky Horseshoe | A activates it while C uses Protein Shake. | A opens a mystery box concurrently: only a box opened after activation receives the benefit. Two box opens cannot consume one Horseshoe twice; duplicate active Horseshoes reject. | Actor-local candidate, requires box-claim writer audit. |
| Trail Mine | A plants a mine while C changes position; record plant position and already-ahead runners from one consistent state. | Last-place plant rejects. Concurrent crossing syncs detonate once; a runner already ahead at planting must not trigger it. Check public feed hides planting and reports detonation correctly. | Rank/trigger dependencies; broad guard initially. |
| Pickpocket (Sneaky Swap) | A steals from B while C steals from D, with spare capacity and stealable held items. | A and C compete for B's sole stealable item; B uses/discards that item concurrently; no duplicate ownership. Empty/unstealable-only inventory rejects. Mirror reflection can legitimately find nothing. Old swap request fields must not make the attacker give away an item. | Inventory dependency audit before narrowing. |
| Shortcut | A targets B while C targets D; both should commit independently in the proposed local protocol. | Same victim, same caster, reversed A-to-B/B-to-A, zero-step target, defense insertion, Mirror reflection and Decoy redirect all need complete dependency locking and fresh validation. | Primary targeted local candidate. |
| Cleanse | A cleanses Rainstorm while C cleanses Wrong Turn; both remove only eligible opponent effects. | No debuffs rejects; Cleanse versus a newly applied attack must match ordering. Removing a Leech/Hitchhike-related eligible effect must preserve already-earned scoring and terminate future impact correctly. | Candidate only after linked-effect boundary audit. |
| Mirror | A equips Mirror while C equips Socks. | Two reflectable attacks compete for B's one Mirror: reflect once. B holding Mirror and Socks follows existing Mirror precedence. Leech/Hitchhike/Rainstorm must not begin reflecting because locks changed. | Local candidate; reflection expands the affected participant set. |
| Power Outage | A uses Outage on 2,000 participants with a reproducible mixture of no defenses, Socks, Mirror, Decoy and existing Outage. Check exact affected/blocked/redirected outcomes. | Outage versus B's Shortcut, Socks activation, Cleanse and Quick Rinse; two Outages; duplicate redirected landings. Never apply twice to one landing or consume one defense twice. Mirror is not an Outage shield. | Broad guard; bulk-operation correctness and load coverage. |
| Decoy | A equips Decoy while C equips Socks. | Two attacks compete for B's Decoy; only one consumes it. Redirect into C while D attacks C must contend on C. Include no legal landing and landing defenses; follow one-hop/current precedence rules, without unbounded redirect chains. Duplicate active Decoy rejects. | Activation is local candidate; resolving redirects requires broader dependency discovery. |

## Cross-powerup scenarios that directly test the lock theory

1. **Independent pair:** A Shortcut B, C Shortcut D. Pause the first transaction
   after dependency locks. Second must commit before release under the proposed
   protocol; current production guards are expected to make it wait.
2. **Hidden shared participant:** B has Decoy; A's Shortcut redirects to C while
   D Shortcuts C. This must wait/revalidate despite distinct original targets.
3. **Reflection conflict:** B has Mirror; A Shortcuts B while C Shortcuts A.
   Both touch A after reflection, so independent execution is unsafe.
4. **Defense inserted after preflight:** B initially has no Socks. Pause A's
   attack after reading that state; let B's Socks activation win the protected
   ordering. A must reread and block, not use its stale absence result.
5. **One shield, two attacks:** B has Socks. A Shortcut B and C Detour B. The
   first valid attack consumes Socks; the other applies. Reverse ordering.
6. **Shop versus race reflection:** B has Mirror. A Leech B must preserve it;
   C Shortcut B must consume/reflect it. Run both orders. This catches a generic
   defense resolver accidentally treating all offensive powerups alike.
7. **Outage before Shortcut:** B has no Socks. A's Outage commits first, then
   B's Shortcut request must reject. Shortcut-first is allowed to complete.
   Do not treat submitting the request first as proof it won the transaction.
8. **Socks survives or is spent before Outage:** B has Socks. If C's Shortcut
   consumes it first, subsequent Outage jams B. If Outage consumes it first,
   B avoids that Outage and can use an otherwise-valid Shortcut afterward.
9. **Outage and counters:** After Outage lands, B's Cleanse is permitted and
   removes the eligible Outage; a subsequent Shortcut can succeed. Quick Rinse
   is also permitted but only shortens Outage, so immediate Shortcut remains
   rejected until the shortened expiry. Test both against a concurrent second
   Outage and protect already-closed scoring windows.
10. **Same actor, different targets:** A Shortcut B and A Detour C still share
    inventory/history/wallet state. This is not a disjoint-pair concurrency test.
11. **Disjoint actors, linked scores:** A has a live link involving B. A local
    action on B and another on the link beneficiary require the dependency audit;
    do not classify them independent merely because their request targets differ.
12. **Cross-race wallet:** Same user spends upgrade coins in two races with only
    enough balance for one paid use. Prevent overspending despite different race
    locks. Use actual upgradeable enabled types and retain existing refund rules.

## Shared test families

Parameterize over all 26 types using type-valid fixtures, not a single generic
target request. For each, exercise:

- Successful public HTTP response and the resulting public race/inventory state.
  Supplement with persisted effect, ownership, charge and event assertions.
- Concurrent duplicate use of the same item: one consumption and one application;
  preserve the existing retry response contract rather than inventing one.
- Rejection after waiting: race ended, actor forfeited, target became invalid,
  or Outage landed. Apply only predicates relevant to that type; cleanser
  exceptions must remain exceptions.
- Full rollback on failure after writes begin: no partial inventory, defense,
  score, wallet, feed or durable notification-intent changes. Do not require
  events for silent actions (X-Ray, Mirror, Socks and Decoy).
- Race-earned held items versus redeemed shop items where supported: preserve
  current retain-held/refund behavior, including concurrent retries.
- Current and supported older-client request headers and response fields.
  Catalog gating must not reveal unsupported items to frozen clients.
- Step sync, effect expiry and settlement overlapping use: after workers drain,
  public progress and final settlement agree; no lost bonus, duplicate transfer,
  resurrected debuff or stale snapshot publication.

For offensive types, add Socks/Mirror/Decoy/Stealth combinations only where
their actual targeting rules apply. Specifically, shop attacks do not reflect,
auto-targeted attacks differ from manually aimed ones, and area attacks have
their own landing/defense rules. Enumerate each defense alone, each applicable
pair, and all three together; include live and expired defense states.

## Harness, comparison and acceptance

- Real HTTP, real handler chain, multiple independent database connections and
  a dedicated disposable `*_test` PostgreSQL database. Never production tests.
- Build the concurrency tests first. Confirm proposed overlap cases fail on
  the production baseline because the second request waits at the race guards;
  existing correctness assertions should pass. Implement changes only afterward.
- Deterministic transaction barriers establish ordering; no arbitrary 500 ms
  sleep is evidence of speed. Barriers belong to the isolated test harness,
  not deployed flags. Use bounded failure timeouts and always release barriers.
- Fix timestamps and make random branches reproducible without replacing the
  real handler/model chain. For redirects, prefer fixtures with only one legal
  destination; for broader randomized coverage, save seeds and expected state.
- Capture both serial orderings on the baseline as a comparison aid. Explicit
  invariants above remain authoritative: baseline parity alone cannot bless an
  existing bug. Surface discrepancies rather than weaken assertions.
- Benchmark separately with no artificial pauses: production baseline,
  participant-lock-only patch, then any shared-guard prototype. Same fixture,
  indexes, worker count, connection pool, request mix and hardware; multiple
  repetitions and warmup. Record completion latency p50/p95/p99, successful
  throughput, SQL/rows written, DB CPU, lock waits, pool waits, retries and errors.
- Include 2,000-player weekly race, many small races, disjoint bursts, same-victim
  bursts, defense-heavy redirects, mixed shop/race use, and concurrent step sync.
  Measure downstream worker drain time and validate final state too.
- Expect independent operations to overlap; do not demand overlap for conflicts
  or broad effects. Reject a speed result if gameplay, inventory, scoring,
  durability or compatibility differs. No speed improvement is claimed here.
