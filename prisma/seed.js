require("dotenv").config();
const { prisma } = require("../src/db");

const challenges = [
  { title: "Sole Survivor", description: "Only one sole survives. Most steps wins.", type: "HEAD_TO_HEAD", resolutionRule: "higher_total" },
];

const stakes = [
  { name: "Coffee Run", description: "Loser makes a coffee run for the winner", category: "food", relationshipTags: ["partner", "friend", "family", "coworker"], format: "IN_PERSON" },
  { name: "Plan a Date Night", description: "Loser plans and pays for a date night", category: "experience", relationshipTags: ["partner"], format: "IN_PERSON" },
  { name: "Cook Dinner", description: "Loser cooks the winner's favorite meal", category: "food", relationshipTags: ["partner", "family", "sibling"], format: "IN_PERSON" },
  { name: "Lunch Treat", description: "Loser buys the winner lunch", category: "food", relationshipTags: ["friend", "coworker"], format: "IN_PERSON" },
  { name: "Movie Pick", description: "Winner picks the next movie night film", category: "experience", relationshipTags: ["partner", "friend", "family", "sibling"], format: "IN_PERSON" },
  { name: "Spotify Playlist", description: "Loser curates a custom playlist for the winner", category: "digital", relationshipTags: ["friend", "partner", "sibling"], format: "VIRTUAL" },
  { name: "Lawn Mowing", description: "Loser mows the winner's lawn", category: "act_of_service", relationshipTags: ["family", "sibling", "parent"], format: "IN_PERSON" },
  { name: "Breakfast in Bed", description: "Loser serves the winner breakfast in bed", category: "food", relationshipTags: ["partner", "parent"], format: "IN_PERSON" },
  { name: "Ice Cream Run", description: "Loser treats the winner to ice cream", category: "food", relationshipTags: ["friend", "family", "sibling", "parent"], format: "IN_PERSON" },
  { name: "Chore Swap", description: "Loser takes over one of the winner's chores for a week", category: "act_of_service", relationshipTags: ["partner", "family", "sibling", "parent"], format: "IN_PERSON" },
  { name: "Dog Walking Duty", description: "Loser walks the winner's dog for a week", category: "act_of_service", relationshipTags: ["partner", "family", "sibling"], format: "IN_PERSON" },
  { name: "Venmo $5", description: "Loser sends the winner $5", category: "digital", relationshipTags: ["friend", "coworker", "sibling"], format: "VIRTUAL" },
];

async function seed() {
  const activeTitles = new Set(challenges.map((c) => c.title));

  // Deactivate challenges no longer in the seed
  console.log("Deactivating removed challenges...");
  const deactivated = await prisma.challenge.updateMany({
    where: { title: { notIn: [...activeTitles] }, active: true },
    data: { active: false },
  });
  console.log(`Deactivated ${deactivated.count} old challenges`);

  // Re-activate any that were previously deactivated but are back in the seed
  await prisma.challenge.updateMany({
    where: { title: { in: [...activeTitles] }, active: false },
    data: { active: true },
  });

  console.log("Seeding challenges...");
  let created = 0;
  for (const c of challenges) {
    const existing = await prisma.challenge.findFirst({
      where: { title: c.title },
    });
    if (!existing) {
      await prisma.challenge.create({ data: c });
      created++;
    }
  }
  console.log(`Created ${created} challenges (${challenges.length - created} already existed)`);

  // Deactivate stakes no longer in the seed
  const activeStakeNames = new Set(stakes.map((s) => s.name));
  console.log("Deactivating removed stakes...");
  const deactivatedStakes = await prisma.stake.updateMany({
    where: { name: { notIn: [...activeStakeNames] }, active: true },
    data: { active: false },
  });
  console.log(`Deactivated ${deactivatedStakes.count} old stakes`);

  // Re-activate any that were previously deactivated but are back in the seed
  await prisma.stake.updateMany({
    where: { name: { in: [...activeStakeNames] }, active: false },
    data: { active: true },
  });

  console.log("Seeding stakes...");
  let stakesCreated = 0;
  for (const s of stakes) {
    const existing = await prisma.stake.findFirst({
      where: { name: s.name },
    });
    if (!existing) {
      await prisma.stake.create({ data: s });
      stakesCreated++;
    }
  }
  console.log(`Created ${stakesCreated} stakes (${stakes.length - stakesCreated} already existed)`);

  // NOTE: cosmetics are intentionally NOT applied on deploy. The DBs are kept
  // in sync by the admin editor's peer mirror (mirrorShopItemToPeer), so a
  // deploy-time applyCosmetics() would clobber live/mirrored tuned values from
  // data/cosmetics.json. cosmetics.json remains the git source of truth and the
  // create/seed path — apply it MANUALLY via `npm run cosmetics:apply` when
  // adding a new item or seeding a fresh DB, and `npm run cosmetics:pull` after
  // tuning to persist DB values back to git.

  // Powerup store catalog (coin-purchasable powerups). Additive + idempotent:
  // upserts by sku so re-seeding never duplicates or disturbs cosmetics. Old app
  // versions never read this table.
  console.log("Seeding powerup shop items...");
  const powerupShopItems = [
    {
      sku: "POWERUP_IMPOSTER",
      name: "Imposter",
      description:
        "Swap your leaderboard position with a rival's for 1 hour. Purely cosmetic — real standings and payouts are unaffected. Mirrors can't reflect it, but Compression Socks block it.",
      priceCoins: 75,
      powerupType: "IMPOSTER",
      active: true,
      sortOrder: 0,
    },
    {
      sku: "POWERUP_RAINSTORM",
      name: "Rainstorm",
      description:
        "Summon a downpour: every other racer's steps count for half for 1 hour. Mirrors can't reflect it, but Compression Socks keep a racer dry.",
      priceCoins: 75,
      powerupType: "RAINSTORM",
      active: true,
      // Owner decision (§9.2.1). NOTE the blast radius: testOnly is NOT
      // "store-only". getEligiblePowerupPool derives its pool from
      // PowerupShopItem.findActive({ channel }), which applies the testOnly
      // release-channel filter — so this ALSO removes Rainstorm from daily
      // reward box drops and the spin reel on the prod channel, not just the
      // store. That is the intended outcome; do not work around it.
      //
      // Seed only. The existing PROD row is unaffected by re-seeding (the upsert
      // `update` block below deliberately omits testOnly) and needs a separate
      // owner-executed UPDATE.
      testOnly: true,
      sortOrder: 1,
    },
    {
      // Store-only, gated from old clients via the `jammer` X-Client-Features
      // token (catalog filter in getPowerupShopCatalog). Targeted attack.
      sku: "POWERUP_SIGNAL_JAMMER",
      name: "Signal Jammer",
      description:
        "Jam a rival's signal — they can't use any powerups for 1 hour. They can still buy and stash powerups; they just can't fire them. Mirrors can't reflect it, but Compression Socks block it.",
      priceCoins: 75,
      powerupType: "SIGNAL_JAMMER",
      active: true,
      sortOrder: 2,
    },
    {
      sku: "POWERUP_CLEANSE",
      name: "Cleanse",
      description:
        "Wash away every debuff a rival has stuck on you — frozen steps, wrong turns, detours, and more. Your own buffs stay put.",
      priceCoins: 150,
      powerupType: "CLEANSE",
      // Retired from the store AND the daily reward box (the box pool is drawn
      // from ACTIVE store powerups via getEligiblePowerupPool). Owners keep and
      // can still USE their existing copies, and CLEANSE stays droppable in-race
      // (powerupOdds RARE tier is unchanged). NOTE: re-seeding only flips this on
      // a fresh row — an already-seeded prod/staging row needs an explicit UPDATE
      // (see the deploy note).
      active: false,
      testOnly: false,
      sortOrder: 3,
    },
    {
      // Store-only, gated from old clients via the `powerups2` X-Client-Features
      // token (catalog filter in getPowerupShopCatalog). Targeted, leecher-driven
      // debuff — see the PowerupType enum note. Never a mystery-box / daily-box
      // prize (excluded from getEligiblePowerupPool).
      sku: "POWERUP_LEECH",
      name: "Leech",
      // DEPRECATED copy columns (§9.5.2): getPowerupShopCatalog now serves
      // name/description from the PowerupCopy catalog. Kept in sync here only so
      // a half-seeded environment still renders something sane. The 60-minute
      // wording is the authoritative one — a request advertising `powerups3`
      // creates a 60-minute effect; a legacy request still gets 30 (§7.5).
      description:
        "For 60 min, every 2 steps you take steals 1 step from a chosen rival and adds it to your score. Compression Socks block it; Mirrors can't reflect it",
      // 300 is the INTENDED live price (owner decision), and it is what the prod
      // row already holds. Source said 150 while prod said 300. The upsert
      // `update` block below (seed.js ~line 380) deliberately OMITS priceCoins
      // and active — both are admin-tuned and must never be reasserted on a
      // deploy — so re-seeding no longer reverts the live price. Do not
      // "restore" this to 150; it is the create-path starting value only.
      priceCoins: 300,
      powerupType: "LEECH",
      // Left ACTIVE deliberately. `active:false` RETIRES an item (the Cleanse
      // precedent at sortOrder 3); `testOnly:true` merely gates it to the
      // TestFlight release channel. Leech is being gated, not retired.
      active: true,
      // Was omitted, so it inherited the schema default of FALSE
      // (schema.prisma:535) — the mismatch that made an earlier spec draft
      // wrongly claim Leech was already testOnly. Set explicitly so fresh and
      // staging databases match the intended production state. Stays true
      // through this deploy and the carrying binary's rollout; the owner flips
      // it manually afterwards. Note the existing PROD row is NOT changed by
      // re-seeding (the upsert `update` block omits testOnly).
      testOnly: true,
      sortOrder: 4,
    },
    {
      // Store-only, `powerups2`-gated. Instantaneous intel read (shipped as
      // "X-Ray"): reveals every opponent's active defenses in one use. Creates no
      // effect. Never a mystery-box / daily-box prize.
      sku: "POWERUP_XRAY",
      name: "X-Ray",
      description:
        "Instantly scan every opponent and see who has a defense up — Compression Socks or a Mirror — and when it expires. Pure recon: it reveals nothing to anyone else.",
      priceCoins: 150,
      powerupType: "DEFENSE_SCAN",
      active: true,
      sortOrder: 5,
    },
    {
      // Store-only, `powerups3`-gated. Targeted 60-minute 1:1 raw-step COPY —
      // the caster gains, the target loses nothing. Never a mystery-box /
      // daily-box prize (excluded from getEligiblePowerupPool).
      //
      // testOnly:true is DELIBERATE and must stay true until the carrying iOS +
      // Android build has completed phased rollout. Flipping it is a separately
      // approved, OWNER-EXECUTED production change — never an agent's.
      sku: "POWERUP_HITCHHIKE",
      name: "Hitchhike",
      description:
        "For 60 min, every step a chosen rival takes is copied into your score — they lose nothing. Compression Socks block it; Mirrors can't reflect it",
      priceCoins: 150,
      powerupType: "HITCHHIKE",
      active: true,
      testOnly: true,
      sortOrder: 6,
    },
    {
      // Store-only, `powerups3`-gated. Self-only, instantaneous: halves the
      // remaining duration of every active timed opponent effect on you. Blocked
      // while jammed, exactly like Cleanse. See the testOnly note above.
      sku: "POWERUP_QUICK_RINSE",
      name: "Quick Rinse",
      description:
        "Cut the remaining time on every opponent effect currently on you in half. Your own buffs stay put",
      priceCoins: 75,
      powerupType: "QUICK_RINSE",
      active: true,
      testOnly: true,
      sortOrder: 7,
    },
    {
      // Store-only, powerups4-gated multi-target freeze. Remains dark through
      // the carrying app's phased rollout.
      sku: "POWERUP_QUICKSAND",
      name: "Quicksand",
      description: "Freeze the steps of up to three rivals for 2 hours. Compression Socks block each target independently; Mirrors can't reflect it.",
      priceCoins: 300,
      powerupType: "QUICKSAND",
      active: true,
      testOnly: true,
      sortOrder: 8,
    },
    // ── Powerups Wave 5 (store-only, `powerups5`-gated) ──────────────────────
    // All 11 ship active:true testOnly:true. testOnly gates them to the
    // TestFlight/dev release channel until the carrying iOS + Android build has
    // completed phased rollout; flipping it to false is a separately approved,
    // OWNER-EXECUTED production change. Prices are the launch seed values; live
    // price/active are admin-tuned and NOT reasserted on re-seed (see the note on
    // the update block below). See docs/powerups5-wave-requirements.md §3.
    {
      sku: "POWERUP_UPRISING",
      name: "Uprising",
      description:
        "Rally the underdogs: while you're in the bottom half of the standings, you and every racer below the midpoint get 2x steps for 2 hours.",
      priceCoins: 300,
      powerupType: "UPRISING",
      active: true,
      testOnly: true,
      sortOrder: 9,
    },
    {
      sku: "POWERUP_GHOST_PEPPER",
      name: "Ghost Pepper",
      description:
        "Go all-in: 3x steps for 30 minutes, then a 30-minute burnout where your steps are frozen. Self-inflicted — Cleanse and Quick Rinse can't wash it off.",
      priceCoins: 75,
      powerupType: "GHOST_PEPPER",
      active: true,
      testOnly: true,
      sortOrder: 10,
    },
    {
      sku: "POWERUP_COIN_FLIP",
      name: "Coin Flip",
      description:
        "Gamble on yourself: flip a coin. Heads doubles your steps for 1 hour; tails halves them. Self-inflicted — no shield or cleanse changes the result.",
      priceCoins: 40,
      powerupType: "COIN_FLIP",
      active: true,
      testOnly: true,
      sortOrder: 11,
    },
    {
      sku: "POWERUP_MYSTERY_POTION",
      name: "Mystery Potion",
      description:
        "Drink up and hope for the best — a random effect fires the moment you use it. Could help you, could hit a rival, could backfire.",
      priceCoins: 40,
      powerupType: "MYSTERY_POTION",
      active: true,
      testOnly: true,
      sortOrder: 12,
    },
    {
      sku: "POWERUP_DECOY",
      name: "Decoy",
      description:
        "Set a trap: the next single-target attack aimed at you is redirected to a random rival instead. Lasts until it triggers or 24 hours.",
      priceCoins: 150,
      powerupType: "DECOY",
      active: true,
      testOnly: true,
      sortOrder: 13,
    },
    {
      sku: "POWERUP_POWER_OUTAGE",
      name: "Power Outage",
      description:
        "Cut the power on the whole field: every rival is jammed and can't use powerups for 30 minutes. Compression Socks keep one racer online.",
      priceCoins: 150,
      powerupType: "POWER_OUTAGE",
      active: true,
      testOnly: true,
      sortOrder: 14,
    },
    {
      sku: "POWERUP_UMBRELLA",
      name: "Umbrella",
      description:
        "Stay dry for 12 hours: you're immune to area attacks like Rainstorm and Power Outage. Doesn't stop targeted hits.",
      priceCoins: 75,
      powerupType: "UMBRELLA",
      active: true,
      testOnly: true,
      sortOrder: 15,
    },
    {
      sku: "POWERUP_RALLY_FLAG",
      name: "Rally Flag",
      description:
        "Team races only: plant the flag and give every teammate 1.25x steps for 1 hour.",
      priceCoins: 150,
      powerupType: "RALLY_FLAG",
      active: true,
      testOnly: true,
      sortOrder: 16,
    },
    {
      sku: "POWERUP_DRILL_SERGEANT",
      name: "Drill Sergeant",
      description:
        "Issue a dare to a rival: hit 3,000 steps in the next 2 hours or lose 1,500. Mirrors can reflect it, Compression Socks block it.",
      priceCoins: 150,
      powerupType: "DRILL_SERGEANT",
      active: true,
      testOnly: true,
      sortOrder: 17,
    },
    {
      sku: "POWERUP_PIGGY_BANK",
      name: "Piggy Bank",
      description:
        "Save as you stride: for 24 hours, bank 1 coin for every 300 steps you take (up to 80). Coins are paid out when it fills or the race ends.",
      priceCoins: 40,
      powerupType: "PIGGY_BANK",
      active: true,
      testOnly: true,
      sortOrder: 18,
    },
    {
      sku: "POWERUP_BOUNTY",
      name: "Bounty",
      description:
        "Put a bounty on a rival ahead of you. If you out-place them by race end, collect 150 coins. Everyone can see the wager. Not for team races.",
      priceCoins: 75,
      powerupType: "BOUNTY",
      active: true,
      testOnly: true,
      sortOrder: 19,
    },
  ];
  let powerupItemsUpserted = 0;
  for (const p of powerupShopItems) {
    await prisma.powerupShopItem.upsert({
      where: { sku: p.sku },
      // NOTE (balance-config §6.1.1): `priceCoins` and `active` are DELIBERATELY
      // absent from this update block. They are LIVE-TUNED through the admin
      // powerup-shop editor (PATCH /admin/powerup-shop/items/:id), so re-seeding
      // on deploy must never reassert the values baked into this file — that is
      // exactly how the Leech price silently reverted 300 -> 150 (audit §2.1).
      // Same reasoning as cosmetics, which are not applied on deploy at all
      // (see the comment above the powerup catalog). They stay in `create` so a
      // fresh DB still gets a sane starting price/active flag.
      update: {
        name: p.name,
        description: p.description,
        powerupType: p.powerupType,
        sortOrder: p.sortOrder,
      },
      create: p,
    });
    powerupItemsUpserted++;
  }
  console.log(`Upserted ${powerupItemsUpserted} powerup shop item(s)`);

  // Powerup COPY catalog (§9.5) — the single source of truth for every
  // user-renderable powerup's name/description/short description/tier labels.
  // Idempotent: keyed by powerupType, so re-running only refreshes strings and
  // never duplicates or deletes. MYSTERY_BOX is intentionally absent.
  const {
    POWERUP_COPY_SEED,
  } = require("../src/modules/powerups/constants/powerupCopySeed");
  let powerupCopyUpserted = 0;
  for (const row of POWERUP_COPY_SEED) {
    await prisma.powerupCopy.upsert({
      where: { powerupType: row.powerupType },
      update: {
        name: row.name,
        description: row.description,
        shortDescription: row.shortDescription,
        upgradeTierLabels: row.upgradeTierLabels,
      },
      create: {
        powerupType: row.powerupType,
        name: row.name,
        description: row.description,
        shortDescription: row.shortDescription,
        upgradeTierLabels: row.upgradeTierLabels,
      },
    });
    powerupCopyUpserted++;
  }
  console.log(`Upserted ${powerupCopyUpserted} powerup copy row(s)`);

  // Balance config version 1 (§4.4). Idempotent and NON-DESTRUCTIVE: it inserts
  // the code defaults only when the table is completely empty, and never
  // touches an existing row. Once an admin has tuned balance through the
  // editor, re-running the seed must not reach it — exactly the mistake that
  // reverted the Leech price, applied to a much bigger surface.
  const {
    balanceConfig: balanceConfigService,
  } = require("../src/modules/economy/balanceConfig");
  const seededConfig = await balanceConfigService.ensureSeeded();
  console.log(
    seededConfig
      ? `Balance config active at v${seededConfig.version} (untouched if it already existed)`
      : "Balance config: nothing to seed"
  );

  console.log("Seed complete!");
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
