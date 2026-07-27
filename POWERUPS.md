# Powerup System

## Overview

Races can optionally enable powerups. When enabled, participants earn powerup boxes by hitting step thresholds, hold up to 3 at a time, and use them to gain advantages or disrupt opponents.

## Powerup Types

Rarity tiers are the generation pool used when a mystery box is opened
(`RARITY_TIERS` in `src/utils/powerupOdds.js`). The three shop-only powerups
(Imposter, Rainstorm, Signal Jammer) are NOT in any tier — they are bought with
coins, never rolled.

### Common

| Powerup | Target | Duration | Effect |
|---|---|---|---|
| **Protein Shake** | Self | Instant | +1,500 bonus steps |
| **Trail Mix** | Self | Instant | +steps per unique powerup type you've used this race |
| **Detour Sign** | Opponent | 3 hours | Hides the entire leaderboard from the target |
| **Runner's High** | Self | 3 hours | 2x step multiplier. Steps walked during the window are counted twice (base + buff) |
| **Pinecone Toss** | Opponent (adjacent) | Instant | Knock steps off the runner directly ahead of or behind you |

### Uncommon

| Powerup | Target | Duration | Effect |
|---|---|---|---|
| **Leg Cramp** | Opponent | 2 hours | Freezes target's step progression. All steps they walk during the window are subtracted from their race total |
| **Stealth Mode** | Self | 4 hours | Hides your progress on the leaderboard. Opponents see "???" for your name and no step count. You can still see your own progress |
| **Wrong Turn** | Opponent | 1 hour | Reverses the target's steps during the window |
| **Cleanse** | Self | Instant | Clears every opponent-inflicted debuff on you (your own buffs are untouched) |

### Rare

| Powerup | Target | Duration | Effect |
|---|---|---|---|
| **Red Card** | Auto (leader) | Instant | Deducts 10% of the current leader's steps from their total. Cannot be used while you are in the lead |
| **Second Wind** | Self | Instant | Bonus steps based on your gap to the leader: 25% of the gap, clamped to 500-5,000 |
| **Compression Socks** | Self | Until consumed | Shield that blocks the next offensive powerup used against you. Lasts indefinitely until triggered |
| **Fanny Pack** | Self | 24 hours | Unlocks an extra powerup slot |
| **Lucky Horseshoe** | Self | Until consumed | Guarantees your next mystery box is a minimum rarity |
| **Pocket Watch** | Self | Instant | Extends all of your active timed buffs |
| **Trail Mine** | Self (trap) | Until triggered | Drops a hidden trap at your current step position |
| **Sneaky Swap** | Opponent | Instant | Steals a random held powerup from the target |
| **Shortcut** | Opponent | Instant | Steal up to 1,000 steps from target (added to your total, subtracted from theirs) |
| **Mirror** | Self | Until consumed | Reflects the next (reflectable) offensive powerup back onto the attacker |

## Earning Powerups

- Each race has a configurable `powerupStepInterval` (e.g. 5,000 steps)
- When your race total crosses the next threshold, you earn a powerup box
- Multiple thresholds can be crossed in a single sync (e.g. going from 0 to 16,000 earns 3 boxes)
- Each participant tracks `nextBoxAtSteps` independently

### Inventory

- Maximum capacity: **3 powerups**
- If your inventory is full when you cross a threshold, no powerup is earned (the threshold still advances)
- You can discard powerups to free space

<!-- BEGIN GENERATED: balance (npm run powerups:docs) -->

## Odds (Rubber Banding)

Rarity odds depend on your position in the race. Trailing players get better drops.

| Position | Common | Uncommon | Rare |
|---|---|---|---|
| 1st (leader) | 48.0% | 25.0% | 27.0% |
| Last place | 20.0% | 35.0% | 45.0% |

Middle positions are interpolated linearly between these extremes.

Within a rarity tier each powerup has equal odds, except for these weighted types (1.0 = a normal share):

| Powerup | Weight |
|---|---|
| **Red Card** | 0.5 |

## Drop Pool

What a mystery box can actually roll. A powerup having a rarity does not make it droppable — it must be listed here.

- **Common** — Protein Shake, Trail Mix, Detour Sign, Runners High, Pinecone Toss
- **Uncommon** — Leg Cramp, Stealth Mode, Wrong Turn, Rally Flag
- **Rare** — Red Card, Second Wind, Compression Socks, Fanny Pack, Lucky Horseshoe, Trail Mine, Sneaky Swap, Shortcut, Cleanse, Mirror

Store-only (bought with coins, never rolled from a mystery box): Pocket Watch, Imposter, Rainstorm, Signal Jammer, Leech, Defense Scan, Hitchhike, Quick Rinse, Uprising, Ghost Pepper, Coin Flip, Mystery Potion, Decoy, Power Outage, Umbrella, Drill Sergeant, Piggy Bank, Bounty.

Team races only (droppable, but a solo race never rolls them): Rally Flag.

Barred from the **daily reward box**: Uprising, Ghost Pepper, Coin Flip, Mystery Potion, Decoy, Power Outage, Umbrella, Rally Flag, Drill Sergeant, Piggy Bank, Bounty. The rest remain winnable as a daily-box RARE prize.

## Upgrade Costs

Coin cost by rarity and level. Level 0 is the base form and is free.

| Rarity | Lvl 1 | Lvl 2 | Lvl 3 |
|---|---|---|---|
| Common | 5 | 15 | 45 |
| Uncommon | 10 | 30 | 90 |
| Rare | 15 | 45 | 135 |

Upgradeable: Protein Shake, Shortcut, Detour Sign, Trail Mix, Runners High, Leg Cramp, Stealth Mode, Wrong Turn, Compression Socks, Lucky Horseshoe, Campfire Rest, Trail Magnet, Pocket Watch, Trail Mine, Pinecone Toss.

## Lucky Horseshoe

Chance that the next mystery box is forced to RARE, by upgrade level. On a miss the floor is UNCOMMON. The rarity is rolled when the Horseshoe is USED and stored on the effect, so an upgrade never changes a Horseshoe already in flight.

| Level | Chance of RARE |
|---|---|
| 0 | 0.0% |
| 1 | 20.0% |
| 2 | 45.0% |
| 3 | 100.0% |

## Daily Reward Box

Odds interpolate on your consecutive-day login streak, capped at **30 days**.

| Streak | Common | Uncommon | Rare |
|---|---|---|---|
| 1 day | 70.0% | 25.0% | 5.0% |
| 30+ days | 20.0% | 35.0% | 45.0% |

Coin payouts per tier, interpolated by streak progress:

| Tier | Min | Max |
|---|---|---|
| COMMON | 10 | 30 |
| UNCOMMON | 40 | 80 |
| RARE_FALLBACK | 100 | 200 |

A RARE hit pays coins instead of a prize 0.0% of the time (displacing the powerup slice only). Accessory weighting mode: `inverse`.

<!-- END GENERATED: balance -->
## Usage Rules

- Powerup must be in `HELD` status and belong to you
- Race must be `ACTIVE`
- Targeted powerups (Leg Cramp, Banana Peel) require a `targetUserId` that is not yourself
- Red Card requires you to **not** be in the lead (auto-targets whoever is)
- Self-only powerups (Protein Shake, Runner's High, Stealth Mode, Compression Socks, Second Wind) cannot target others

## Blocking (Compression Socks)

When an offensive powerup is used against someone with an active Compression Socks shield:

1. The attack is blocked — no damage applied
2. The shield is consumed (effect status set to `BLOCKED`)
3. The attacker's powerup is still marked `USED`
4. A `POWERUP_BLOCKED` event appears in the race feed

### Shield precedence: Mirror beats Compression Socks

A target can hold **both** an active Mirror and an active Compression Socks at
once. When attacked, the **Mirror takes precedence** — it is checked first:

1. The Mirror reflects the attack back onto the attacker (the attacker takes the
   damage), is consumed (status `EXPIRED`), and emits `POWERUP_REFLECTED`.
2. The Compression Socks shield is **not** touched — it stays `ACTIVE`, banked
   for the next attack.

So a dual-shield holder gets two saves in order: the first incoming attack
reflects off the Mirror (punishing the attacker), and the next one is absorbed
by the still-active Compression Socks. The socks-block path only runs when no
Mirror is present. (Implemented in `src/commands/usePowerup.js`; see the
dual-shield integration test in `test/integration/powerups-dual-shield.test.js`.)

### Shop-only powerups: Mirror-proof, Socks-blockable

The three coin-shop-only powerups — **Imposter**, **Rainstorm**, and **Signal
Jammer** (`SHOP_POWERUP_TYPES` in `usePowerup.js`) — follow a different defense
rule than earned offensive powerups:

- **Mirror can NEVER reflect them.** A target holding an active Mirror is *not*
  protected and their Mirror is *not* consumed — the shop powerup lands as if no
  Mirror were present. (Signal Jammer skips the Mirror pre-check via
  `SHOP_POWERUP_TYPES`; Rainstorm has no per-victim Mirror branch; Imposter is
  not offensive and is never reflectable.)
- **Compression Socks DO block all three.** The socks are consumed
  (status `BLOCKED`), a `POWERUP_BLOCKED` event is written/emitted, and the
  attacker's powerup is marked `USED`:
  - *Signal Jammer* — single-target socks block (it stays in `OFFENSIVE_TYPES`).
  - *Imposter* — a dedicated socks block near its targeting validation. Since
    Imposter targets a single rival, only that rival's socks matter; swapping
    slots with a shielded rival is refused.
  - *Rainstorm* — per-victim socks block. Each other racer with an active shield
    stays dry (their socks are consumed); everyone else gets the 0.5x debuff. A
    victim's Mirror no longer protects them from the rain.

## Step Calculation with Powerups

```
finalSteps = baseSteps - frozenSteps + buffedSteps + bonusSteps
```

- **baseSteps**: Steps from daily records + step samples (the normal race total)
- **frozenSteps**: Sum of steps walked during all Leg Cramp windows (subtracted)
- **buffedSteps**: Sum of steps walked during all Runner's High windows (added again, effectively 2x)
- **bonusSteps**: Net from Protein Shake (+1,500), Banana Peel (+/-1,000), Red Card (-10% of leader), Second Wind (+500-5,000)

For timed effects (Leg Cramp, Runner's High), the system uses StepSample data for precision when available, falling back to snapshots recorded at effect start/expiry.

## Effect Expiration

- Timed effects (Leg Cramp, Runner's High, Stealth Mode) expire automatically
- Expiration is checked each time `getRaceProgress` is called
- On expiry, a `stepsAtExpiry` snapshot is stored for Leg Cramp and Runner's High
- Compression Socks never expire on time — they are consumed when blocking an attack

## Race Feed Events

| Event | Example |
|---|---|
| `POWERUP_EARNED` | "Alex earned a Protein Shake!" |
| `POWERUP_USED` | "Alex used Leg Cramp on Jordan! Their steps are frozen for 2 hours." |
| `POWERUP_BLOCKED` | "Jordan's Compression Socks blocked Alex's Leg Cramp!" |
| `POWERUP_DISCARDED` | "Alex discarded a Banana Peel." |
| `EFFECT_EXPIRED` | "Leg Cramp wore off." |

## Constants

```
MAX_INVENTORY           = 3

LEG_CRAMP_DURATION      = 2 hours
RUNNERS_HIGH_DURATION   = 3 hours
STEALTH_MODE_DURATION   = 4 hours

PROTEIN_SHAKE_BONUS     = 1,500 steps
BANANA_PEEL_STEAL       = 1,000 steps
RED_CARD_PERCENT        = 10% of leader's steps
SECOND_WIND_FACTOR      = 25% of gap to leader
SECOND_WIND_MIN         = 500 steps
SECOND_WIND_MAX         = 5,000 steps
```
