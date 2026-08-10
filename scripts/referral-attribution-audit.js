#!/usr/bin/env node
// Referral-attribution observability report (invite-code onboarding spec,
// part B / step 7).
//
// WHY THIS EXISTS: referral attribution is inference — an iOS clipboard
// handoff at provision plus an IP-correlated link_opens fallback. Real capture
// over the 2026-08-08/09 weekend was ~1 in 5-6 invites, and every miss was
// SILENT: it surfaced only when a user complained and needed a manual prod
// repair (dylanhuynh, emersonz). This report makes both halves visible without
// waiting for a complaint:
//
//   1. UNATTRIBUTED BURSTS — referral links that were opened but produced no
//      referral row for that code within 48h. Candidate lost attributions.
//   2. SOURCE BREAKDOWN — how each referral WAS attributed, total and PER DAY.
//      The per-day series is the gate on flipping
//      REFERRAL_IP_FALLBACK_NET_ENABLED on: it shows tier-1 volume and lets us
//      judge the false-positive surface tier 2 would add.
//
// STRICTLY READ-ONLY: SELECTs only, no writes of any kind, so it is safe to
// point at prod (same posture as `npm run powerups:store list`). Exits 0 even
// when it finds problems — it is a report, not a CI gate.
//
// Usage:
//   npm run referrals:audit                          # local, last 7 days
//   npm run referrals:audit -- --days=14 --db=prod
//   npm run referrals:audit -- --db=staging

require("dotenv").config();

const DB_ALIASES = {
  local: "DATABASE_URL",
  staging: "STAGING_DATABASE_URL",
  prod: "PROD_DATABASE_URL",
};

// A referral row created within this long after a link open counts as "that
// burst was attributed". Matches the IP-fallback window: a real user installs,
// onboards and signs in over minutes-to-days, not seconds.
const ATTRIBUTION_GRACE_HOURS = 48;

function parseArgs(argv) {
  const opts = { days: 7, db: "local" };
  for (const arg of argv) {
    if (arg.startsWith("--days=")) {
      const value = Number(arg.slice(7));
      if (!Number.isInteger(value) || value < 1 || value > 365) {
        throw new Error("--days must be an integer between 1 and 365");
      }
      opts.days = value;
    } else if (arg.startsWith("--db=")) {
      opts.db = arg.slice(5);
    } else if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

// Point Prisma at the requested database BEFORE src/db is required — it reads
// DATABASE_URL at module load and caches the pool.
function selectDatabase(alias) {
  const envKey = DB_ALIASES[alias];
  if (!envKey) {
    throw new Error(
      `Unknown --db target "${alias}". Expected one of: ${Object.keys(DB_ALIASES).join(", ")}`
    );
  }
  const url = process.env[envKey];
  if (!url) {
    throw new Error(`${envKey} is not set in .env — cannot target "${alias}"`);
  }
  process.env.DATABASE_URL = url;
  return url;
}

function describeTarget(alias, url) {
  const host = url.replace(/\/\/[^@]*@/, "//***@").split("@").pop().split("?")[0];
  return `${alias} (${host})`;
}

function pad(value, width) {
  return String(value).padEnd(width);
}

function padStart(value, width) {
  return String(value).padStart(width);
}

function heading(text) {
  console.log(`\n${text}`);
  console.log("─".repeat(text.length));
}

// ── Report 1: source breakdown ──────────────────────────────────────────────
//
// NULL is rendered as "(none)" and means "attributed before this column
// existed" — deliberately not backfilled, since no source can be recovered
// after the fact. Once the deploy has been live longer than the window, a
// non-trivial "(none)" count means a write path is NOT stamping and is a bug.
async function sourceBreakdown(prisma, since) {
  const rows = await prisma.$queryRaw`
    SELECT COALESCE(source, '(none)') AS source, COUNT(*)::int AS count
    FROM referrals
    WHERE created_at >= ${since}
    GROUP BY 1
    ORDER BY 2 DESC, 1 ASC
  `;

  heading(`Attribution source breakdown (total)`);
  if (rows.length === 0) {
    console.log("  no referrals created in this window");
    return;
  }
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  const width = Math.max(...rows.map((r) => r.source.length), 6);
  for (const row of rows) {
    const share = ((row.count / total) * 100).toFixed(1);
    console.log(
      `  ${pad(row.source, width)}  ${padStart(row.count, 5)}  ${padStart(share, 5)}%`
    );
  }
  console.log(`  ${pad("TOTAL", width)}  ${padStart(total, 5)}`);
}

// Per-day series — the tier-2 enablement gate. Dates are bucketed in pure SQL
// (never in JS off a node-pg-shifted Date): prod datetimes are tz-naive and
// letting the driver interpret them silently moves rows across day boundaries.
async function sourceBreakdownPerDay(prisma, since) {
  const rows = await prisma.$queryRaw`
    SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
           COALESCE(source, '(none)') AS source,
           COUNT(*)::int AS count
    FROM referrals
    WHERE created_at >= ${since}
    GROUP BY 1, 2
    ORDER BY 1 ASC, 3 DESC
  `;

  heading("Attribution source breakdown (per day)");
  if (rows.length === 0) {
    console.log("  no referrals created in this window");
    return;
  }

  const sources = [...new Set(rows.map((r) => r.source))].sort();
  const days = [...new Set(rows.map((r) => r.day))];
  const byDay = new Map();
  for (const row of rows) {
    if (!byDay.has(row.day)) byDay.set(row.day, {});
    byDay.get(row.day)[row.source] = row.count;
  }

  const colWidth = Math.max(...sources.map((s) => s.length), 5);
  console.log(
    `  ${pad("day", 10)}  ${sources.map((s) => padStart(s, colWidth)).join("  ")}`
  );
  for (const day of days) {
    const counts = byDay.get(day);
    console.log(
      `  ${pad(day, 10)}  ${sources
        .map((s) => padStart(counts[s] || 0, colWidth))
        .join("  ")}`
    );
  }
}

// ── Report 2: unattributed bursts ───────────────────────────────────────────
//
// A "burst" is all referral-kind link opens for one code on one day. If no
// referrals row for that code was created between the first open and
// ATTRIBUTION_GRACE_HOURS after the last one, the burst produced nothing —
// somebody tapped an invite and we never connected them.
//
// Expect a nonzero baseline: people open invite links without installing, and
// an already-attributed human re-opening a link can never produce a second row
// (one attribution per human, ever). This is a trend signal, not an alarm.
async function unattributedBursts(prisma, since) {
  const rows = await prisma.$queryRaw`
    WITH bursts AS (
      SELECT code,
             to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
             COUNT(*)::int AS opens,
             MIN(created_at) AS first_open,
             MAX(created_at) AS last_open
      FROM link_opens
      WHERE kind = 'referral'
        AND code IS NOT NULL
        AND created_at >= ${since}
      GROUP BY 1, 2
    )
    SELECT b.code, b.day, b.opens, b.first_open
    FROM bursts b
    WHERE NOT EXISTS (
      SELECT 1 FROM referrals r
      WHERE r.code = b.code
        AND r.created_at >= b.first_open
        AND r.created_at <= b.last_open + (${ATTRIBUTION_GRACE_HOURS} * INTERVAL '1 hour')
    )
    ORDER BY b.opens DESC, b.day DESC, b.code ASC
  `;

  heading(
    `Unattributed link-open bursts (no referral within ${ATTRIBUTION_GRACE_HOURS}h)`
  );
  if (rows.length === 0) {
    console.log("  none — every referral link opened in this window attributed");
    return;
  }

  const codeWidth = Math.max(...rows.map((r) => r.code.length), 4);
  console.log(`  ${pad("code", codeWidth)}  ${pad("day", 10)}  opens`);
  for (const row of rows) {
    console.log(
      `  ${pad(row.code, codeWidth)}  ${pad(row.day, 10)}  ${padStart(row.opens, 5)}`
    );
  }
  const totalOpens = rows.reduce((sum, r) => sum + r.opens, 0);
  console.log(
    `\n  ${rows.length} burst(s), ${totalOpens} open(s) that produced no attribution.`
  );
  console.log(
    "  Note: opens without an install, and re-opens by an already-attributed"
  );
  console.log(
    "  human, both land here legitimately. Watch the TREND, not the absolute."
  );
}

// Context for the numbers above: how many link opens even carry the tier-2
// hash yet. Immediately after deploy this is low (old rows are NULL and age
// out over 48h), and tier 2 cannot match a NULL row by design.
async function coverage(prisma, since) {
  const [row] = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS opens,
           COUNT(ip_hash)::int AS with_ip_hash,
           COUNT(ip_net_hash)::int AS with_net_hash
    FROM link_opens
    WHERE kind = 'referral' AND created_at >= ${since}
  `;
  heading("Link-open hash coverage");
  console.log(`  referral opens        ${padStart(row.opens, 6)}`);
  console.log(`  with ip_hash (tier 1) ${padStart(row.with_ip_hash, 6)}`);
  console.log(`  with ip_net_hash (t2) ${padStart(row.with_net_hash, 6)}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    console.log(
      "Usage: npm run referrals:audit -- [--days=N] [--db=local|staging|prod]"
    );
    return;
  }

  const url = selectDatabase(opts.db);
  // Required AFTER selectDatabase (see the note on that function).
  const { prisma } = require("../src/db");

  const since = new Date(Date.now() - opts.days * 24 * 60 * 60 * 1000);

  console.log(`Referral attribution audit`);
  console.log(`  target: ${describeTarget(opts.db, url)}`);
  console.log(`  window: last ${opts.days} day(s), since ${since.toISOString()}`);
  console.log(`  mode:   READ-ONLY (SELECT only)`);

  try {
    await sourceBreakdown(prisma, since);
    await sourceBreakdownPerDay(prisma, since);
    await coverage(prisma, since);
    await unattributedBursts(prisma, since);

    const netEnabled = String(
      process.env.REFERRAL_IP_FALLBACK_NET_ENABLED ?? "0"
    ).trim().toLowerCase();
    heading("Tier-2 (network-prefix) fallback");
    console.log(
      `  REFERRAL_IP_FALLBACK_NET_ENABLED=${netEnabled} in THIS shell` +
        ` (${netEnabled === "1" || netEnabled === "true" ? "ON" : "OFF"}).`
    );
    console.log(
      "  This is the local value, not the server's — check the app host's env."
    );
    console.log(
      "  Flip it on only once the per-day series above justifies the added"
    );
    console.log(
      "  false-positive surface (a carrier-NAT /24 is shared by strangers)."
    );
  } finally {
    await prisma.$disconnect();
  }
}

// Exit 0 always: this is a report, not a gate. Real failures (bad args,
// unreachable DB) still surface as a nonzero exit via the catch below.
main().catch((error) => {
  console.error(`\nreferral-attribution-audit failed: ${error.message}`);
  process.exit(1);
});
