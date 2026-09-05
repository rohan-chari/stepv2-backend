const { readFactRootPage, materializeFactRoots } = require("./durableCaptureFacts");
const { prorateSamplesIntoWindow } = require("../models/stepSample");

function yieldCapture() {
  const error = new Error("Durable scoring page budget exhausted");
  error.code = "CAPTURE_YIELD";
  return error;
}

// A crossing-day sample belongs to its first overlapping pinned ordinary day.
// Long spans belong only to the sentinel. No population-sized seen-ID set.
function ownsSample(root, roots, fact) {
  const start = new Date(fact.periodStart).getTime();
  const end = new Date(fact.periodEnd).getTime();
  if (Math.floor(end / 86400000) - Math.floor(start / 86400000) >= 32) {
    return root.day === "0001-01-01";
  }
  return root.id === roots.find((candidate) => candidate.day !== "0001-01-01" &&
    new Date(candidate.day).getTime() < end &&
    new Date(candidate.day).getTime() + 86400000 > start)?.id;
}

function sampleContribution({ root, scope, method, args, fact }) {
  const result = { answer: 0, openAnswer: 0, matchCount: 0 };
  if (!fact || !ownsSample(root, scope.ownershipRoots || scope.roots, fact)) return result;
  const start = new Date(fact.periodStart);
  const end = new Date(fact.periodEnd);
  if (!(end > new Date(scope.sampleStart) && start < new Date(scope.sampleEnd))) return result;
  const from = new Date(args[1]).getTime();
  const through = new Date(args[2]).getTime();
  if (!(end.getTime() > from && start.getTime() < through)) return result;
  result.matchCount = 1;
  const amount = prorateSamplesIntoWindow([{ start, end, steps: Number(fact.steps) || 0 }], from, through);
  result.openAnswer = amount;
  result.answer = method !== "sumClosedStepsInWindow" || end <= new Date(args[3]) ? amount : 0;
  return result;
}

async function runScoringMethod({ client, scope, key, kind, method, args, budget }) {
  const [saved] = await client.$queryRawUnsafe(`SELECT state,
    state_digest=encode(sha256(convert_to(state::text,'UTF8')),'hex') AS valid FROM durable_capture_method_progress
    WHERE scope_digest=$1 AND method_digest=$2`, scope.digest, key);
  if (saved && (saved.valid !== true || !saved.state || saved.state.version !== 2 ||
      !Number.isInteger(saved.state.rootIndex) || saved.state.rootIndex < 0 || saved.state.rootIndex > scope.roots.length ||
      !Number.isInteger(saved.state.afterPage) || saved.state.afterPage < 0 ||
      !Number.isInteger(saved.state.rowsSeen) || saved.state.rowsSeen < 0 ||
      !Number.isSafeInteger(saved.state.matchCount) || saved.state.matchCount < 0 ||
      !saved.state.baseline || !Number.isFinite(saved.state.baseline.answer) ||
      !Number.isFinite(saved.state.baseline.openAnswer) ||
      !Number.isSafeInteger(saved.state.baseline.matchCount) || saved.state.baseline.matchCount < 0)) {
    const error = new Error("Durable scoring method progress is corrupt");
    error.code = "INPUTS_NOT_RETAINED";
    throw error;
  }
  const state = saved?.state || {
    version: 2, rootIndex: 0, afterPage: 0, digest: null, rowsSeen: 0,
    answer: method === "hasAnyInWindow" ? false :
      method === "findByUserIdAndDate" ? null :
        method === "findByUserIdAndDateRange" ? [] : 0,
    openAnswer: 0, matchCount: 0,
    baseline: { answer: 0, openAnswer: 0, matchCount: 0 },
  };
  const persist = () => client.$executeRawUnsafe(`INSERT INTO durable_capture_method_progress
    (scope_digest,method_digest,user_id,state,state_digest)
    VALUES ($1,$2,$3,$4::jsonb,encode(sha256(convert_to(($4::jsonb)::text,'UTF8')),'hex'))
    ON CONFLICT (scope_digest,method_digest) DO UPDATE SET state=EXCLUDED.state,state_digest=EXCLUDED.state_digest,
      updated_at=clock_timestamp()`, scope.digest, key, scope.userId, JSON.stringify(state));
  while (state.rootIndex < scope.roots.length) {
    if (budget.pages <= 0) throw yieldCapture();
    budget.pages--;
    const root = scope.roots[state.rootIndex];
    const prepared = await materializeFactRoots({ client, rootIds: [root.id], limit: 1 });
    // Preparation is already durable and bounded. Spend remaining claim budget
    // on its next page/phase instead of discarding the entire remaining budget
    // after every DAILY→CURRENT transition of an empty chunk.
    if (prepared.remaining) continue;
    const result = await readFactRootPage({ client, rootId: root.id,
      afterPage: state.afterPage, expectedDigest: state.digest });
    for (const row of result.page?.rows || []) {
      const fact = row.fact;
      if (kind === "sampleModel" && row.kind === "sample") {
        const contribution = sampleContribution({ root, scope, method, args, fact });
        const baseline = sampleContribution({ root, scope, method: "sumClosedStepsInWindow",
          args: [scope.userId, scope.sampleStart, scope.sampleEnd, scope.sampleEnd], fact });
        // A raw dependency segment already streams this root's full pages.
        // Preserve its ordinary full-scope input at constant per-row cost so a
        // later uploader's BASE request need not read those same pages again.
        state.baseline ||= { answer: 0, openAnswer: 0, matchCount: 0 };
        state.baseline.answer += baseline.answer;
        state.baseline.openAnswer += baseline.openAnswer;
        state.baseline.matchCount += baseline.matchCount;
        state.matchCount = (state.matchCount || 0) + contribution.matchCount;
        if (method === "hasAnyInWindow") {
          state.answer ||= contribution.matchCount > 0;
        } else {
          state.answer += contribution.answer;
          state.openAnswer += contribution.openAnswer;
        }
      } else if (kind === "stepsModel" && row.kind === "daily") {
        const at = new Date(fact.date).getTime();
        if (at < new Date(scope.dailyStart).getTime() || at > new Date(scope.dailyEnd).getTime()) continue;
        const { rowId: _rowId, ...daily } = fact;
        if (method === "findByUserIdAndDate" &&
            new Date(fact.date).toISOString().slice(0, 10) === new Date(args[1]).toISOString().slice(0, 10)) {
          state.answer = daily;
        } else if (method === "findByUserIdAndDateRange" &&
            at >= new Date(args[1]).getTime() && at <= new Date(args[2]).getTime()) state.answer.push(daily);
      }
    }
    state.rowsSeen += result.page?.rows.length || 0;
    state.afterPage = result.nextPage;
    state.digest = result.page?.cumulativeDigest || state.digest;
    if (result.done) {
      if (state.rowsSeen !== Number(result.root.rowCount)) {
        const error = new Error("Durable scoring page count mismatch");
        error.code = "INPUTS_NOT_RETAINED";
        throw error;
      }
      state.rootIndex++;
      state.afterPage = 0;
      state.digest = null;
      state.rowsSeen = 0;
    }
    await persist();
  }
  return { answer: state.answer, openAnswer: state.openAnswer, matchCount: state.matchCount || 0,
    baseline: state.baseline };
}

module.exports = { runScoringMethod, sampleContribution };
