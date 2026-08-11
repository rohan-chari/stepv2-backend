require("dotenv").config();
const { prisma } = require("../src/db");
const {
  POWERUP_COPY_SEED,
} = require("../src/modules/powerups/constants/powerupCopySeed");

// Syncs ONLY the PowerupCopy table from powerupCopySeed.js. Nothing else in the
// database is read or written — no challenges, no stakes, no shop items, no
// balance config.
//
// Why this exists separately from `node prisma/seed.js`: user-facing powerup
// copy is the one thing in the seed that legitimately needs to be re-applied on
// a deploy (the seed file IS its source of truth — there is no admin editor for
// it). Everything else in seed.js either reasserts values that are live-tuned
// elsewhere or flips `active` on rows it does not own. Running the whole seed to
// ship a wording change is a blast radius nobody asked for.
//
// Dry run by default: prints a field-level diff and exits 0 without writing.
// Pass --apply to perform the upserts.
const COPY_FIELDS = [
  "name",
  "description",
  "shortDescription",
  "upgradeTierLabels",
];

function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  }
  return (a ?? null) === (b ?? null);
}

function preview(value) {
  const text = Array.isArray(value) ? JSON.stringify(value) : String(value ?? "");
  return text.length > 110 ? `${text.slice(0, 107)}...` : text;
}

// host/database of DATABASE_URL, never the credentials. This script is meant to
// be run against prod by hand, so it says out loud what it is pointed at before
// it writes anything.
function targetLabel() {
  try {
    const url = new URL(process.env.DATABASE_URL);
    return `${url.host}${url.pathname}`;
  } catch {
    return "unknown (DATABASE_URL unparseable)";
  }
}

async function sync() {
  const apply = process.argv.includes("--apply");

  console.log(`[powerup-copy] target: ${targetLabel()}`);

  const existing = await prisma.powerupCopy.findMany();
  const byType = new Map(existing.map((row) => [row.powerupType, row]));

  const changes = [];
  const missing = [];

  for (const row of POWERUP_COPY_SEED) {
    const current = byType.get(row.powerupType);
    if (!current) {
      missing.push(row.powerupType);
      continue;
    }
    for (const field of COPY_FIELDS) {
      if (!sameValue(current[field], row[field])) {
        changes.push({ type: row.powerupType, field, from: current[field], to: row[field] });
      }
    }
  }

  // A type in the DB but not in the seed is left completely alone. This script
  // never deletes and never deactivates: a frozen client may still be rendering
  // that row's copy.
  const orphans = existing
    .filter((row) => !POWERUP_COPY_SEED.some((s) => s.powerupType === row.powerupType))
    .map((row) => row.powerupType);

  if (missing.length > 0) {
    console.log(`[powerup-copy] ${missing.length} row(s) absent from the DB, will be created:`);
    for (const type of missing) console.log(`  + ${type}`);
  }
  if (orphans.length > 0) {
    console.log(`[powerup-copy] ${orphans.length} DB row(s) not in the seed, left untouched:`);
    for (const type of orphans) console.log(`  = ${type}`);
  }
  if (changes.length > 0) {
    console.log(`[powerup-copy] ${changes.length} field(s) differ:`);
    for (const change of changes) {
      console.log(`  ~ ${change.type}.${change.field}`);
      console.log(`      db:   ${preview(change.from)}`);
      console.log(`      seed: ${preview(change.to)}`);
    }
  }

  if (changes.length === 0 && missing.length === 0) {
    console.log("[powerup-copy] OK — the database already matches the seed.");
    return;
  }

  if (!apply) {
    console.log("\n[powerup-copy] DRY RUN — nothing written. Re-run with --apply to write.");
    return;
  }

  let written = 0;
  for (const row of POWERUP_COPY_SEED) {
    const payload = {
      name: row.name,
      description: row.description,
      shortDescription: row.shortDescription,
      upgradeTierLabels: row.upgradeTierLabels,
    };
    await prisma.powerupCopy.upsert({
      where: { powerupType: row.powerupType },
      update: payload,
      create: { powerupType: row.powerupType, ...payload },
    });
    written++;
  }
  console.log(`\n[powerup-copy] applied — upserted ${written} row(s).`);
}

sync()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[powerup-copy] failed:", error);
    process.exit(1);
  });
