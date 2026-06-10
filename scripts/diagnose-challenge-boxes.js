#!/usr/bin/env node
/**
 * READ-ONLY diagnostic for "no mystery boxes in the daily/weekly challenges".
 *
 * The daily/weekly "challenges" are the seeded featured races (RaceSeed kinds
 * DAILY_10K / WEEKLY_50K). In-race boxes only roll when, for an ACCEPTED
 * participant of an ACTIVE race, race.powerups_enabled is true AND
 * race.powerup_step_interval > 0 AND participant.next_box_at_steps > 0
 * (see racePowerupStateSync.js + rollPowerup.js). joinPublicRace never
 * initializes next_box_at_steps, so public/featured joiners default to 0.
 *
 * This script confirms WHICH layer is broken in prod, WITHOUT writing anything:
 *   1. Are powerups even enabled on the DAILY_10K / WEEKLY_50K seeds?
 *   2. Do the live ACTIVE seeded races inherit powerups_enabled + interval?
 *   3. For one user (default 'sugaroro'): their participant rows in those
 *      races — next_box_at_steps, status, steps — and how many boxes they hold.
 *   4. Is that user's apple-sub-hash already in the onboarding_box_grant ledger
 *      (which would silently suppress the 3 welcome boxes on first-race join)?
 *   5. Scope: how many accepted participants are stranded at next_box=0 in
 *      active powerup-enabled seeded races (the blast radius of the join bug).
 *
 * Usage: node scripts/diagnose-challenge-boxes.js [displayName]
 */
const fs = require("fs");
const crypto = require("node:crypto");
const { Client } = require("pg");

const DISPLAY_NAME = process.argv[2] || "sugaroro";
const SEED_KINDS = ["DAILY_10K", "WEEKLY_50K"];

const url = fs
  .readFileSync(__dirname + "/../.env", "utf8")
  .match(/^PROD_DATABASE_URL=(.+)$/m)[1]
  .trim()
  .replace(/^"|"$/g, "")
  .replace(/[?&]sslmode=[^&]*/g, "");

function hashAppleSub(appleSub) {
  if (typeof appleSub !== "string" || appleSub.length === 0) return null;
  return crypto.createHash("sha256").update(appleSub, "utf8").digest("hex");
}

const hr = (t) => console.log(`\n${"=".repeat(70)}\n${t}\n${"=".repeat(70)}`);

async function section(c, sql, params = []) {
  try {
    const { rows } = await c.query(sql, params);
    return rows;
  } catch (e) {
    console.log(`  [query failed: ${e.message}]`);
    return null;
  }
}

(async () => {
  const c = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    statement_timeout: 30000,
  });
  await c.connect();
  console.log(`Diagnosing daily/weekly-challenge mystery boxes for: "${DISPLAY_NAME}"`);

  // 1) Seed config -------------------------------------------------------
  hr("1) RaceSeed config (DAILY_10K / WEEKLY_50K)");
  const seeds = await section(
    c,
    `SELECT kind, name, powerups_enabled, powerup_step_interval, time_based, active
       FROM race_seeds WHERE kind = ANY($1) ORDER BY kind`,
    [SEED_KINDS]
  );
  if (seeds && seeds.length) {
    for (const s of seeds) {
      console.log(
        `  ${s.kind} (${s.name}) — powerups_enabled=${s.powerups_enabled} ` +
          `interval=${s.powerup_step_interval} time_based=${s.time_based} active=${s.active}`
      );
      if (!s.powerups_enabled || !s.powerup_step_interval) {
        console.log(
          `    >> LAYER-0 PROBLEM: powerups are OFF on this seed — NO ONE earns boxes from it.`
        );
      }
    }
  } else {
    console.log("  No seed rows found.");
  }

  // 2) Live seeded races -------------------------------------------------
  hr("2) Live ACTIVE/PENDING seeded races (inherited powerup config)");
  const races = await section(
    c,
    `SELECT r.id, r.name, r.status, r.powerups_enabled, r.powerup_step_interval,
            r.started_at, r.ends_at, rs.kind AS seed_kind,
            (SELECT count(*) FROM race_participants rp
               WHERE rp.race_id = r.id AND rp.status = 'accepted') AS accepted
       FROM races r JOIN race_seeds rs ON rs.id = r.seed_id
      WHERE rs.kind = ANY($1) AND r.status IN ('active','pending')
      ORDER BY rs.kind, r.started_at DESC`,
    [SEED_KINDS]
  );
  if (races && races.length) {
    for (const r of races) {
      console.log(
        `  [${r.seed_kind}] ${r.name} — status=${r.status} powerups_enabled=${r.powerups_enabled} ` +
          `interval=${r.powerup_step_interval} accepted=${r.accepted}`
      );
      console.log(`     id=${r.id} started=${r.started_at?.toISOString?.() ?? r.started_at}`);
    }
  } else {
    console.log("  No live seeded races found.");
  }

  // 3) The user ----------------------------------------------------------
  hr(`3) User "${DISPLAY_NAME}"`);
  const users = await section(
    c,
    `SELECT id, display_name, (apple_id IS NOT NULL AND apple_id <> '') AS has_apple_id,
            apple_id, first_race_onboarding_seen
       FROM users WHERE lower(display_name) = lower($1)`,
    [DISPLAY_NAME]
  );
  let user = null;
  if (users && users.length) {
    user = users[0];
    console.log(
      `  display_name="${user.display_name}" id=${user.id} has_apple_id=${user.has_apple_id} ` +
        `first_race_onboarding_seen=${user.first_race_onboarding_seen}`
    );
  } else {
    console.log(`  No exact (case-insensitive) match for "${DISPLAY_NAME}". Near matches:`);
    const cand = await section(
      c,
      `SELECT display_name FROM users
        WHERE display_name ILIKE '%' || $1 || '%' ORDER BY display_name LIMIT 15`,
      [DISPLAY_NAME.replace(/[%_]/g, "")]
    );
    if (cand && cand.length) {
      for (const u of cand) console.log(`    - ${u.display_name}`);
    } else {
      console.log("    (none)");
    }
  }

  // 4) The user's participant rows in seeded races -----------------------
  if (user) {
    hr(`4) "${DISPLAY_NAME}" participant rows in daily/weekly challenges`);
    const parts = await section(
      c,
      `SELECT rs.kind AS seed_kind, r.name AS race, r.status AS race_status,
              r.powerups_enabled, r.powerup_step_interval,
              rp.status AS p_status, rp.next_box_at_steps, rp.total_steps,
              rp.baseline_steps, rp.bonus_steps, rp.max_bonus_steps,
              rp.powerup_slots, rp.joined_at
         FROM race_participants rp
         JOIN races r ON r.id = rp.race_id
         JOIN race_seeds rs ON rs.id = r.seed_id
        WHERE rp.user_id = $1 AND rs.kind = ANY($2)
        ORDER BY r.started_at DESC LIMIT 20`,
      [user.id, SEED_KINDS]
    );
    if (parts && parts.length) {
      for (const p of parts) {
        const armed = p.next_box_at_steps > 0;
        console.log(
          `  [${p.seed_kind}] ${p.race} (race ${p.race_status}, powerups=${p.powerups_enabled}/${p.powerup_step_interval})`
        );
        console.log(
          `     p_status=${p.p_status} next_box_at_steps=${p.next_box_at_steps} ` +
            `${armed ? "(ARMED)" : ">> NOT ARMED — gate can never fire"} ` +
            `total_steps=${p.total_steps} bonus=${p.bonus_steps}/${p.max_bonus_steps} slots=${p.powerup_slots}`
        );
      }
    } else {
      console.log(`  "${DISPLAY_NAME}" has NO participant rows in any seeded race.`);
    }

    // 5) The user's box inventory in seeded races ------------------------
    hr(`5) "${DISPLAY_NAME}" box/powerup rows in challenges (by status)`);
    const boxes = await section(
      c,
      `SELECT rs.kind AS seed_kind, pw.status, count(*)::int AS n
         FROM race_powerups pw
         JOIN races r ON r.id = pw.race_id
         JOIN race_seeds rs ON rs.id = r.seed_id
        WHERE pw.user_id = $1 AND rs.kind = ANY($2)
        GROUP BY rs.kind, pw.status ORDER BY rs.kind, pw.status`,
      [user.id, SEED_KINDS]
    );
    if (boxes && boxes.length) {
      for (const b of boxes) console.log(`  [${b.seed_kind}] ${b.status}: ${b.n}`);
    } else {
      console.log(`  Zero powerup/box rows for "${DISPLAY_NAME}" in any challenge.`);
    }

    // 6) Onboarding ledger ----------------------------------------------
    hr(`6) Onboarding welcome-box ledger`);
    const hashHex = hashAppleSub(user.apple_id);
    if (!hashHex) {
      console.log("  User has no apple_id — onboarding-box grant would skip (no stable identity).");
    } else {
      const led = await section(
        c,
        `SELECT granted_at FROM onboarding_box_grant WHERE apple_sub_hash = $1`,
        [hashHex]
      );
      if (led && led.length) {
        console.log(
          `  PRESENT in ledger (hash ${hashHex.slice(0, 8)}…) granted_at=${led[0].granted_at?.toISOString?.() ?? led[0].granted_at}`
        );
        console.log(`  >> Welcome boxes already consumed once — any later first-race join grants 0 (silent).`);
      } else {
        console.log(`  Not in ledger (hash ${hashHex.slice(0, 8)}…) — eligible for the 3 welcome boxes.`);
      }
    }
  }

  // 7) Blast radius ------------------------------------------------------
  hr("7) Blast radius: accepted participants in active powerup-enabled seeded races");
  const scope = await section(
    c,
    `SELECT rs.kind,
            count(*) FILTER (WHERE rp.next_box_at_steps = 0)               AS stranded_zero,
            count(*) FILTER (WHERE rp.next_box_at_steps = 0 AND rp.total_steps > 0) AS stranded_zero_with_steps,
            count(*) FILTER (WHERE rp.next_box_at_steps > 0)               AS armed
       FROM race_participants rp
       JOIN races r ON r.id = rp.race_id
       JOIN race_seeds rs ON rs.id = r.seed_id
      WHERE r.status = 'active' AND r.powerups_enabled AND r.powerup_step_interval > 0
        AND rp.status = 'accepted'
      GROUP BY rs.kind ORDER BY rs.kind`,
    []
  );
  if (scope && scope.length) {
    for (const s of scope) {
      console.log(
        `  [${s.kind}] stranded_at_0=${s.stranded_zero} (of those, ${s.stranded_zero_with_steps} have walked steps) | armed(>0)=${s.armed}`
      );
    }
  } else {
    console.log("  No accepted participants in active powerup-enabled seeded races (could mean powerups are off — see section 1/2).");
  }

  hr("READ-ONLY: no rows were modified.");
  await c.end();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
