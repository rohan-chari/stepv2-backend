# Powerup System

## Overview

Races can optionally enable powerups. When enabled, participants earn powerup boxes by hitting step thresholds, hold up to 3 at a time, and use them to gain advantages or disrupt opponents.

## Powerup Types

### Common

| Powerup | Target | Duration | Effect |
|---|---|---|---|
| **Protein Shake** | Self | Instant | +1,500 bonus steps |
| **Banana Peel** | Opponent | Instant | Steal up to 1,000 steps from target (added to your total, subtracted from theirs) |

### Uncommon

| Powerup | Target | Duration | Effect |
|---|---|---|---|
| **Leg Cramp** | Opponent | 2 hours | Freezes target's step progression. All steps they walk during the window are subtracted from their race total |
| **Runner's High** | Self | 3 hours | 2x step multiplier. Steps walked during the window are counted twice (base + buff) |
| **Stealth Mode** | Self | 4 hours | Hides your progress on the leaderboard. Opponents see "???" for your name and no step count. You can still see your own progress |

### Rare

| Powerup | Target | Duration | Effect |
|---|---|---|---|
| **Red Card** | Auto (leader) | Instant | Deducts 10% of the current leader's steps from their total. Cannot be used while you are in the lead |
| **Second Wind** | Self | Instant | Bonus steps based on your gap to the leader: 25% of the gap, clamped to 500-5,000 |
| **Compression Socks** | Self | Until consumed | Shield that blocks the next offensive powerup (Leg Cramp, Red Card, or Banana Peel) used against you. Lasts indefinitely until triggered |

## Earning Powerups

- Each race has a configurable `powerupStepInterval` (e.g. 5,000 steps)
- When your race total crosses the next threshold, you earn a powerup box
- Multiple thresholds can be crossed in a single sync (e.g. going from 0 to 16,000 earns 3 boxes)
- Each participant tracks `nextBoxAtSteps` independently

### Inventory

- Maximum capacity: **3 powerups**
- If your inventory is full when you cross a threshold, no powerup is earned (the threshold still advances)
- You can discard powerups to free space

## Odds (Rubber Banding)

Rarity odds depend on your position in the race. Trailing players get better drops.

| Position | Common | Uncommon | Rare |
|---|---|---|---|
| 1st (leader) | 70% | 25% | 5% |
| Last place | 20% | 35% | 45% |

Middle positions are interpolated linearly between these extremes.

Within a rarity tier, each powerup has equal odds (e.g. Common = 50% Protein Shake, 50% Banana Peel).

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
