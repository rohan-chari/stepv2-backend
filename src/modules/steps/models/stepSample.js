const { prisma } = require("../../../db");
const {
  bumpScoringInputVersion,
} = require("../services/scoringInputVersion");

// One raw, set-based, ON CONFLICT DO UPDATE multi-row insert (Five-Minute Step
// Samples §3.3). Absent optional fields are inserted as NULL; EXCLUDED (the
// incoming sample) wins on a same-start conflict so a concurrent sync racing the
// reconcile delete can't 500 on the (user_id, period_start) unique key.
async function insertSamplesOn(client, userId, samples) {
  if (!samples || samples.length === 0) return;
  const rows = [];
  const params = [];
  let p = 1;
  for (const s of samples) {
    // id/created_at have no DB default (Prisma assigns them app-side), so the raw
    // insert must supply them: gen_random_uuid() (PG13+) and now().
    rows.push(
      `(gen_random_uuid(), $${p++}, $${p++}::timestamp, $${p++}::timestamp, $${p++}::int, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}::jsonb, now())`
    );
    params.push(
      userId,
      new Date(s.periodStart).toISOString(),
      new Date(s.periodEnd).toISOString(),
      s.steps,
      typeof s.sourceName === "string" ? s.sourceName : null,
      typeof s.sourceId === "string" ? s.sourceId : null,
      typeof s.sourceDeviceId === "string" ? s.sourceDeviceId : null,
      typeof s.deviceModel === "string" ? s.deviceModel : null,
      typeof s.recordingMethod === "string" ? s.recordingMethod : null,
      Object.prototype.hasOwnProperty.call(s, "metadata") && s.metadata != null
        ? JSON.stringify(s.metadata)
        : null
    );
  }
  const sql =
    `INSERT INTO step_samples
       (id, user_id, period_start, period_end, steps, source_name, source_id,
        source_device_id, device_model, recording_method, metadata, created_at)
     VALUES ${rows.join(", ")}
     ON CONFLICT (user_id, period_start) DO UPDATE SET
       period_end = EXCLUDED.period_end,
       steps = EXCLUDED.steps,
       source_name = EXCLUDED.source_name,
       source_id = EXCLUDED.source_id,
       source_device_id = EXCLUDED.source_device_id,
       device_model = EXCLUDED.device_model,
       recording_method = EXCLUDED.recording_method,
       metadata = EXCLUDED.metadata`;
  await client.$executeRawUnsafe(sql, ...params);
}

const StepSample = {
  // Granularity-aware overlap resolution (§3.3). Replaces the old blind
  // upsert-on-(user, period_start): with mixed hourly/5-min data a blind upsert
  // silently double-counts. Behaviorally a NO-OP for pure-hourly traffic
  // (hour-aligned rows never strictly contain each other and same-start
  // overwrite is preserved), so it is safe to deploy before any client sends
  // finer buckets. Own transaction for the fetch+delete+insert.
  async reconcileBatch(userId, samples, nowMs = Date.now()) {
    return prisma.$transaction((tx) =>
      this.reconcileBatchOn(tx, userId, samples, nowMs)
    );
  },

  // Same reconciliation, run against a caller-provided transaction client so
  // sync-v2's Transaction A can persist steps, samples, and the idempotency
  // reservation atomically.
  async reconcileBatchOn(client, userId, samples, nowMs = Date.now()) {
    if (!samples || samples.length === 0) return;

    const incoming = samples.map((s) => ({
      raw: s,
      start: new Date(s.periodStart).getTime(),
      end: new Date(s.periodEnd).getTime(),
    }));

    // The batch's covered range: what this request provides replacement data for.
    const coveredStart = Math.min(...incoming.map((i) => i.start));
    const coveredEnd = Math.max(...incoming.map((i) => i.end));

    // Fetch every stored sample overlapping the covered range in ONE query.
    // `steps` is read so the span guard only fires when the non-spanned overhang
    // actually carries step credit to protect.
    const storedRaw = await client.$queryRawUnsafe(
      `SELECT period_start AS "start", period_end AS "end", steps
       FROM step_samples
       WHERE user_id = $1
         AND period_end > $2::timestamp
         AND period_start < $3::timestamp`,
      userId,
      new Date(coveredStart).toISOString(),
      new Date(coveredEnd).toISOString()
    );
    const stored = storedRaw.map((r) => ({
      start: r.start.getTime(),
      end: r.end.getTime(),
      steps: r.steps,
    }));

    // Rules 1 & 2 decide which incoming samples to KEEP.
    const kept = incoming.filter((i) => {
      for (const s of stored) {
        // Rule 1 (drop-coarser): a stored finer sample lies strictly within I
        // (different start) — an old coarse row must never clobber finer rows.
        if (s.start !== i.start && i.start <= s.start && s.end <= i.end) {
          return false;
        }
      }
      for (const s of stored) {
        // Rule 2 (span guard): a stored sample overlaps I but is NOT fully
        // spanned by the batch's covered range — deleting it would destroy step
        // credit outside what this batch replaces (day-start-after-tz-travel).
        const overlaps = s.end > i.start && s.start < i.end;
        if (!overlaps) continue;
        // A stored row may extend past NOW: the iOS background sidecar posts
        // ANCHORED full-clock-hour rows, so a mid-hour post lands 14:00→15:00 at
        // 14:15. Time that hasn't elapsed yet cannot hold step credit, so the
        // guard must not protect it — otherwise the trailing overhang prorates
        // to >0 and every finer sample for that hour is rejected until the clock
        // passes 15:00, freezing the user's total and starving live powerup
        // windows (2026-07-26 incident). Clamp the row to its ELAPSED portion
        // for both the span check and the proration denominator; a row wholly in
        // the past is unaffected, so this is a no-op for normal traffic.
        const effectiveEnd = Math.min(s.end, nowMs);
        const fullySpanned = coveredStart <= s.start && effectiveEnd <= coveredEnd;
        if (fullySpanned) continue;
        // The guard exists to protect real credit, per its rationale. If the
        // non-spanned overhang prorates to zero steps (e.g. two hour-length
        // re-syncs shifted by a few ms — never real credit), let rule 3 replace S
        // so the newer value wins instead of stranding stale data.
        const dur = effectiveEnd - s.start;
        let overhangMs = 0;
        if (s.start < coveredStart) {
          overhangMs += Math.min(coveredStart, effectiveEnd) - s.start;
        }
        if (effectiveEnd > coveredEnd) overhangMs += effectiveEnd - coveredEnd;
        const overhangSteps =
          dur > 0 ? Math.round((s.steps || 0) * (overhangMs / dur)) : 0;
        if (overhangSteps > 0) return false;
      }
      return true;
    });

    if (kept.length === 0) return;

    // Rule 3: delete every stored sample overlapping ANY kept incoming window in
    // one set-based DELETE (parallel-array unnest), then batch-insert the kept
    // samples.
    const startArr = kept.map((i) => new Date(i.start).toISOString());
    const endArr = kept.map((i) => new Date(i.end).toISOString());
    await client.$executeRawUnsafe(
      `DELETE FROM step_samples s
       USING unnest($2::timestamp[], $3::timestamp[]) AS w(w_start, w_end)
       WHERE s.user_id = $1
         AND s.period_end > w.w_start
         AND s.period_start < w.w_end`,
      userId,
      startArr,
      endArr
    );

    await insertSamplesOn(client, userId, kept.map((i) => i.raw));
    await bumpScoringInputVersion(client, userId);
  },

  async findByUserIdAndTimeRange(userId, startTime, endTime) {
    return prisma.stepSample.findMany({
      where: {
        userId,
        periodEnd: { gt: new Date(startTime) },
        periodStart: { lt: new Date(endTime) },
      },
      orderBy: { periodStart: "asc" },
    });
  },

  // Cheap EXISTS over [windowStart, windowEnd): does this user have ANY sample
  // in the range? Used to decide whether precise (sample-driven) effect scoring
  // is available. Deliberately not a SUM — a user who walked zero steps but has
  // rows still HAS sample data, and LIMIT 1 lets the (user_id, period_start,
  // period_end) index answer without scanning a whole race window.
  async hasAnyInWindow(userId, windowStart, windowEnd) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT 1 FROM step_samples
        WHERE user_id = $1
          AND period_end > $2::timestamp
          AND period_start < $3::timestamp
        LIMIT 1`,
      userId,
      new Date(windowStart).toISOString(),
      new Date(windowEnd).toISOString()
    );
    return rows.length > 0;
  },

  async sumStepsInWindow(userId, windowStart, windowEnd) {
    const sums = await this.sumStepsInWindows(userId, [
      { start: windowStart, end: windowEnd },
    ]);
    return sums[0];
  },

  // Like sumStepsInWindow but ONLY counts CLOSED buckets — samples whose
  // periodEnd <= now (§3.4). Excludes any not-yet-closed bucket (whatever its
  // size) so Leech's credited window is monotonic across recomputes. Same plain
  // ::timestamp comparison style as sumStepsInWindows (columns hold UTC).
  async sumClosedStepsInWindow(userId, windowStart, windowEnd, now) {
    const start =
      typeof windowStart === "string" ? windowStart : new Date(windowStart).toISOString();
    const end =
      typeof windowEnd === "string" ? windowEnd : new Date(windowEnd).toISOString();
    const nowIso = typeof now === "string" ? now : new Date(now).toISOString();

    const samples = await prisma.$queryRawUnsafe(
      `SELECT period_start AS "start", period_end AS "end", steps
       FROM step_samples
       WHERE user_id = $1
         AND period_end > $2::timestamp
         AND period_start < $3::timestamp
         AND period_end <= $4::timestamp`,
      userId, start, end, nowIso
    );

    return prorateSamplesIntoWindow(
      samples,
      new Date(start).getTime(),
      new Date(end).getTime()
    );
  },

  // Batched variant of sumClosedStepsInWindow: ONE fetch spanning all windows,
  // then the same per-window proration over CLOSED buckets only. Results are
  // identical to calling sumClosedStepsInWindow per window. Used by the effect
  // segment walk so an open (in-progress) bucket never drives effect scoring:
  // proration splits a sample across its STAMPED span, so a bucket that is still
  // filling would be re-cut on every recompute -- bleeding a frozen user's score
  // down as the freeze window widens, and paying boosted credit for steps walked
  // after the boost ended. Same plain ::timestamp comparison style as
  // sumStepsInWindows (columns hold UTC).
  async sumClosedStepsInWindows(userId, windows, now) {
    if (!windows || windows.length === 0) return [];

    const parsed = windows.map((w) => ({
      start: typeof w.start === "string" ? w.start : new Date(w.start).toISOString(),
      end: typeof w.end === "string" ? w.end : new Date(w.end).toISOString(),
    }));
    const nowIso = typeof now === "string" ? now : new Date(now).toISOString();

    const fetchStart = parsed
      .map((w) => w.start)
      .reduce((a, b) => (new Date(a) <= new Date(b) ? a : b));
    const fetchEnd = parsed
      .map((w) => w.end)
      .reduce((a, b) => (new Date(a) >= new Date(b) ? a : b));

    const samples = await prisma.$queryRawUnsafe(
      `SELECT period_start AS "start", period_end AS "end", steps
       FROM step_samples
       WHERE user_id = $1
         AND period_end > $2::timestamp
         AND period_start < $3::timestamp
         AND period_end <= $4::timestamp`,
      userId, fetchStart, fetchEnd, nowIso
    );

    return parsed.map((w) =>
      prorateSamplesIntoWindow(
        samples,
        new Date(w.start).getTime(),
        new Date(w.end).getTime()
      )
    );
  },

  // Bulk fetch for cross-participant batching (see getHomeRaceCard): all of
  // several users' samples overlapping [rangeStart, rangeEnd), with the same
  // overlap predicate sumStepsInWindows uses, so prorating these rows against
  // any window inside the range gives identical results to a per-user query.
  async findRowsForUsersInRange(userIds, rangeStart, rangeEnd) {
    if (!userIds || userIds.length === 0) return [];
    const start =
      typeof rangeStart === "string" ? rangeStart : new Date(rangeStart).toISOString();
    const end =
      typeof rangeEnd === "string" ? rangeEnd : new Date(rangeEnd).toISOString();

    return prisma.$queryRawUnsafe(
      `SELECT user_id AS "userId", period_start AS "start", period_end AS "end", steps
       FROM step_samples
       WHERE user_id = ANY($1::text[])
         AND period_end > $2::timestamp
         AND period_start < $3::timestamp`,
      userIds, start, end
    );
  },

  // Batched variant of sumStepsInWindow: ONE fetch spanning all windows, then
  // the same per-window proration. Returns an array of sums parallel to
  // `windows` ({start, end} each). Exists so per-day loops (see
  // calculateSubsequentSteps) cost one query instead of one per day; results
  // are identical to calling sumStepsInWindow per window because the overlap
  // check discards any fetched sample that falls between windows.
  async sumStepsInWindows(userId, windows) {
    if (!windows || windows.length === 0) return [];

    // All timestamps stored as 'timestamp without time zone' representing UTC.
    // Use raw SQL with plain timestamp comparison -- no ::timestamptz casts.
    const parsed = windows.map((w) => ({
      start: typeof w.start === "string" ? w.start : new Date(w.start).toISOString(),
      end: typeof w.end === "string" ? w.end : new Date(w.end).toISOString(),
    }));

    const fetchStart = parsed
      .map((w) => w.start)
      .reduce((a, b) => (new Date(a) <= new Date(b) ? a : b));
    const fetchEnd = parsed
      .map((w) => w.end)
      .reduce((a, b) => (new Date(a) >= new Date(b) ? a : b));

    const samples = await prisma.$queryRawUnsafe(
      `SELECT period_start AS "start", period_end AS "end", steps
       FROM step_samples
       WHERE user_id = $1
         AND period_end > $2::timestamp
         AND period_start < $3::timestamp`,
      userId, fetchStart, fetchEnd
    );

    return parsed.map((w) =>
      prorateSamplesIntoWindow(
        samples,
        new Date(w.start).getTime(),
        new Date(w.end).getTime()
      )
    );
  },
};

// A sample overlapping the window contributes its steps, prorated linearly by
// the overlapped fraction of its duration. Shared by the single- and batched-
// window sums so the two can never diverge.
function prorateSamplesIntoWindow(samples, windowStartMs, windowEndMs) {
  let total = 0;
  for (const sample of samples) {
    const sampleStart = sample.start.getTime();
    const sampleEnd = sample.end.getTime();
    const sampleDuration = sampleEnd - sampleStart;

    if (sampleDuration <= 0) continue;

    const overlapStart = Math.max(sampleStart, windowStartMs);
    const overlapEnd = Math.min(sampleEnd, windowEndMs);
    const overlapDuration = overlapEnd - overlapStart;

    if (overlapDuration <= 0) continue;

    if (overlapDuration >= sampleDuration) {
      total += sample.steps;
    } else {
      total += Math.round(sample.steps * (overlapDuration / sampleDuration));
    }
  }

  return total;
}

module.exports = { StepSample, prorateSamplesIntoWindow };
