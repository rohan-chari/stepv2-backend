const { digestCanonical } = require("./globalEventSummaryCapture");
const { runScoringMethod, sampleContribution } = require("./durableScoringMethod");
const { coordinatedOptimizationMetrics: metrics } = require("../../../shared/observability/coordinatedOptimizationMetrics");

function invalid(message) {
  const error = new Error(message);
  error.code = "INPUTS_NOT_RETAINED";
  return error;
}

function empty(method) {
  return { answer: method === "hasAnyInWindow" ? false : method === "findByUserIdAndDate" ? null :
    method === "findByUserIdAndDateRange" ? [] : 0, openAnswer: 0, matchCount: 0 };
}

function validate(row, method) {
  if (!row || row.valid !== true || !row.result || !Number.isFinite(row.result.openAnswer) ||
      !Number.isSafeInteger(row.result.matchCount) || row.result.matchCount < 0 ||
      (method === "hasAnyInWindow" && typeof row.result.answer !== "boolean") ||
      (method.startsWith("sum") && !Number.isFinite(row.result.answer)) ||
      (method === "findByUserIdAndDateRange" && !Array.isArray(row.result.answer))) {
    throw invalid("Durable interval projection is corrupt");
  }
  return row.result;
}

function dailyRelevant(scope, args, fact, method) {
  if (!fact) return false;
  const date = new Date(fact.date).getTime();
  if (date < new Date(scope.dailyStart).getTime() || date > new Date(scope.dailyEnd).getTime()) return false;
  if (method === "findByUserIdAndDate") return new Date(fact.date).toISOString().slice(0, 10) ===
    new Date(args[1]).toISOString().slice(0, 10);
  return date >= new Date(args[1]).getTime() && date <= new Date(args[2]).getTime();
}

// This is one MVCC statement: a concurrent compactor cannot make a removed
// journal suffix look like proof of no changes. Gap/compacted/oversized ranges
// deliberately return no proof and use immutable paged reconstruction instead.
async function advanceJournal({ client, scope, root, previous, kind, method, args, budget }) {
  const from = BigInt(previous.revision);
  const through = BigInt(root.revision);
  if (through < from || through - from > 256n) return null;
  // A collected head can restart at revision zero. Different root IDs at
  // equal revisions are not interchangeable across that retirement boundary.
  if (through === from) return null;
  if (budget.pages <= 0) {
    const error = new Error("Durable projection proof budget exhausted");
    error.code = "CAPTURE_YIELD";
    throw error;
  }
  budget.pages--;
  const [proof] = await client.$queryRawUnsafe(`
    SELECT h.compacted_revision::text,h.revision::text,
      COALESCE((SELECT jsonb_agg(to_jsonb(j) ORDER BY j.revision) FROM (
        SELECT revision::text,kind,before_fact,after_fact FROM durable_capture_fact_journal
        WHERE user_id=$1 AND day=$2::date AND revision>$3::bigint AND revision<=$4::bigint
        ORDER BY revision LIMIT 257
      ) j),'[]'::jsonb) AS changes
    FROM durable_capture_fact_heads h WHERE h.user_id=$1 AND h.day=$2::date
      AND EXISTS (SELECT 1 FROM durable_capture_fact_roots r
        WHERE r.id=$5::uuid AND r.user_id=h.user_id AND r.day=h.day AND r.revision=$3::bigint)`,
  scope.userId, root.day, String(from), String(through), previous.root_id);
  if (!proof || from < BigInt(proof.compacted_revision) || through > BigInt(proof.revision) ||
      proof.changes.length !== Number(through - from)) return null;
  const ordered = proof.changes.sort((a, b) => BigInt(a.revision) < BigInt(b.revision) ? -1 : 1);
  if (ordered.some((change, index) => BigInt(change.revision) !== from + BigInt(index + 1))) return null;
  const result = { ...previous.result };
  for (const change of ordered) {
    if (kind === "sampleModel" && change.kind === "sample") {
      const before = sampleContribution({ root, scope, method, args, fact: change.before_fact });
      const after = sampleContribution({ root, scope, method, args, fact: change.after_fact });
      result.matchCount += after.matchCount - before.matchCount;
      result.openAnswer += after.openAnswer - before.openAnswer;
      if (method !== "hasAnyInWindow") result.answer += after.answer - before.answer;
    } else if (kind === "stepsModel" && change.kind === "daily" &&
        (dailyRelevant(scope, args, change.before_fact, method) || dailyRelevant(scope, args, change.after_fact, method))) {
      // Daily fallback has object/date selection semantics, independently
      // versioned from sample sums. Never substitute a sample-only proof.
      return null;
    }
  }
  if (result.matchCount < 0) throw invalid("Durable interval journal projection underflow");
  if (method === "hasAnyInWindow") result.answer = result.matchCount > 0;
  metrics.increment("global_summary_capture_prepared_method_total", { kind: "interval_journal_reuse" });
  return result;
}

function semanticKey(scope, root, kind, method, args) {
  // A contiguous sample overlapping this root can belong to an earlier root
  // iff it overlaps the nearest earlier ordinary pinned day. More distant
  // prefix/suffix days cannot change that decision. Daily facts and sentinel
  // samples have one owner independent of the ordinary-day vector.
  if (!scope.ownershipPredecessors) {
    scope.ownershipPredecessors = new Map();
    let previous = null;
    for (const value of [...scope.roots].sort((a, b) => a.day.localeCompare(b.day))) {
      scope.ownershipPredecessors.set(value.id, previous);
      if (value.day !== "0001-01-01") previous = value.day;
    }
  }
  const predecessor = kind === "sampleModel" && root.day !== "0001-01-01"
    ? scope.ownershipPredecessors.get(root.id) : null;
  return digestCanonical({ version: 2, inputVersion: scope.version, userId: scope.userId,
      day: root.day, ownershipPredecessorDay: predecessor, kind, method, args,
      sampleStart: scope.sampleStart, sampleEnd: scope.sampleEnd,
      dailyStart: scope.dailyStart, dailyEnd: scope.dailyEnd }).digest;
}

async function saveProjection(client, semantic, scope, root, result) {
  await client.$executeRawUnsafe(`INSERT INTO durable_capture_interval_projections
    (semantic_digest,root_id,user_id,day,revision,result,result_digest)
    VALUES ($1,$2::uuid,$3,$4::date,$5::bigint,$6::jsonb,
      encode(sha256(convert_to(($6::jsonb)::text,'UTF8')),'hex'))
    ON CONFLICT (semantic_digest,root_id) DO NOTHING`,
  semantic, root.id, scope.userId, root.day, root.revision, JSON.stringify(result));
}

async function resolveIntervalProjection({ client, scope, key, kind, method, args, budget }) {
  budget.roots ??= 32;
  // Daily rows have exactly one UTC-day owner. Sample windows deliberately
  // retain the complete ownership vector because samples can cross midnight.
  let roots = scope.roots;
  if (kind === "stepsModel") {
    if (!scope.dailyRootsByDay) {
      scope.dailyRootsByDay = new Map(scope.roots.filter((root) => root.day !== "0001-01-01")
        .map((root) => [root.day, root]));
    }
    if (method === "findByUserIdAndDate") {
      const root = scope.dailyRootsByDay.get(new Date(args[1]).toISOString().slice(0, 10));
      roots = root && dailyRelevant(scope, args, { date: root.day }, method) ? [root] : [];
    } else {
      roots = [...scope.dailyRootsByDay.values()]
        .filter((root) => dailyRelevant(scope, args, { date: root.day }, method));
    }
  }
  // Version 3 checkpoints index the full vector even for exact-date reads;
  // never reinterpret their cursor as an index into this selected vector.
  const methodKey = digestCanonical({ version: 4,
    key: key || digestCanonical({ kind, method, args }).digest }).digest;
  scope.rootVectorDigest ||= digestCanonical(scope.roots.map((root) => [root.id, root.day, root.revision])).digest;
  const rootVectorDigest = roots === scope.roots ? scope.rootVectorDigest :
    digestCanonical(roots.map((root) => [root.id, root.day, root.revision])).digest;
  const [saved] = await client.$queryRawUnsafe(`SELECT state,
    state_digest=encode(sha256(convert_to(state::text,'UTF8')),'hex') AS valid
    FROM durable_capture_method_progress WHERE scope_digest=$1 AND method_digest=$2`, scope.digest, methodKey);
  if (saved && (saved.valid !== true || saved.state?.version !== 4 || saved.state.mode !== "ROOT_AGGREGATE" ||
      saved.state.rootVectorDigest !== rootVectorDigest || !Number.isInteger(saved.state.rootIndex) ||
      saved.state.rootIndex < 0 || saved.state.rootIndex > roots.length)) {
    throw invalid("Durable root aggregation cursor is corrupt or belongs to different pinned inputs");
  }
  if (saved) validate({ valid: true, result: saved.state.total }, method);
  const state = saved?.state || { version: 4, mode: "ROOT_AGGREGATE", rootVectorDigest,
    rootIndex: 0, total: empty(method) };
  const total = state.total;
  const persist = () => client.$executeRawUnsafe(`INSERT INTO durable_capture_method_progress
    (scope_digest,method_digest,user_id,state,state_digest)
    VALUES ($1,$2,$3,$4::jsonb,encode(sha256(convert_to(($4::jsonb)::text,'UTF8')),'hex'))
    ON CONFLICT (scope_digest,method_digest) DO UPDATE SET state=EXCLUDED.state,state_digest=EXCLUDED.state_digest,
      updated_at=clock_timestamp()
    WHERE (durable_capture_method_progress.state->>'rootIndex')::integer<=(EXCLUDED.state->>'rootIndex')::integer`,
  scope.digest, methodKey, scope.userId, JSON.stringify(state));
  while (state.rootIndex < roots.length) {
    if (budget.roots <= 0) {
      const error = new Error("Durable root aggregation budget exhausted");
      error.code = "CAPTURE_YIELD";
      throw error;
    }
    budget.roots--;
    const root = roots[state.rootIndex];
    metrics.increment("global_summary_capture_projection_root_operations");
    if (kind === "stepsModel") metrics.increment("global_summary_capture_daily_projection_root_operations");
    const semantic = semanticKey(scope, root, kind, method, args);
    const projectionSelect = `SELECT root_id,revision::text,result,
        result_digest=encode(sha256(convert_to(result::text,'UTF8')),'hex') AS valid
      FROM durable_capture_interval_projections WHERE semantic_digest=$1`;
    // Prefer the immutable ID with its primary-key lookup. Revision numbers
    // can repeat after head retirement; sorting only by revision could keep
    // selecting a retired epoch's answer and force a needless page reread.
    let [stored] = await client.$queryRawUnsafe(`${projectionSelect} AND root_id=$2::uuid`, semantic, root.id);
    if (!stored) [stored] = await client.$queryRawUnsafe(`${projectionSelect}
      AND revision<=$2::bigint ORDER BY revision DESC LIMIT 1`, semantic, root.revision);
    if (stored) validate(stored, method);
    let result = stored?.root_id === root.id ? stored.result : stored ?
      await advanceJournal({ client, scope, root, previous: stored, kind, method, args, budget }) : null;
    if (!result) {
      const rootScope = { ...scope, digest: digestCanonical({ semantic, rootId: root.id }).digest,
        roots: [root], ownershipRoots: scope.roots };
      result = await runScoringMethod({ client, scope: rootScope, key: semantic, kind, method, args, budget });
      if (kind === "sampleModel" && result.baseline) {
        const baselineArgs = [scope.userId, scope.sampleStart, scope.sampleEnd];
        await saveProjection(client, semanticKey(scope, root, kind, "sumStepsInWindow", baselineArgs),
          scope, root, { ...result.baseline, answer: result.baseline.openAnswer });
        await saveProjection(client, semanticKey(scope, root, kind, "sumClosedStepsInWindow",
          [...baselineArgs, scope.sampleEnd]), scope, root, result.baseline);
        await saveProjection(client, semanticKey(scope, root, kind, "hasAnyInWindow", baselineArgs),
          scope, root, { ...result.baseline, answer: result.baseline.matchCount > 0 });
      }
      const { baseline: _baseline, ...scalar } = result;
      result = scalar;
    }
    if (stored?.root_id !== root.id) {
      await saveProjection(client, semantic, scope, root, result);
      if (kind === "sampleModel" && method === "sumClosedStepsInWindow") {
        await saveProjection(client, semanticKey(scope, root, kind, "sumStepsInWindow", args.slice(0, 3)),
          scope, root, { ...result, answer: result.openAnswer });
      }
    }
    total.openAnswer += result.openAnswer;
    total.matchCount += result.matchCount;
    if (method === "hasAnyInWindow") total.answer ||= result.answer;
    else if (method === "findByUserIdAndDate") total.answer = result.answer ?? total.answer;
    else if (method === "findByUserIdAndDateRange") total.answer.push(...result.answer);
    else total.answer += result.answer;
    state.rootIndex++;
    await persist();
  }
  return total;
}

// Independent derived answers never pin raw facts. Fixed-age bounded deletion
// is safe: a miss reprojects pinned immutable input, never current mutable data.
async function compactIntervalProjections({ client, limit = 256 }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 256) throw new Error("Invalid projection retention limit");
  return client.$executeRawUnsafe(`WITH selected AS (
    SELECT semantic_digest,root_id FROM durable_capture_interval_projections
    WHERE created_at<CURRENT_TIMESTAMP-INTERVAL '30 days'
    ORDER BY created_at,semantic_digest,root_id LIMIT $1 FOR UPDATE SKIP LOCKED
  ) DELETE FROM durable_capture_interval_projections p USING selected s
    WHERE p.semantic_digest=s.semantic_digest AND p.root_id=s.root_id`, limit);
}

module.exports = { resolveIntervalProjection, compactIntervalProjections };
