const { artifactModels, digestCanonical } = require("./globalEventSummaryCapture");
const { resolveIntervalProjection } = require("./durableCaptureIntervalProjection");
const { coordinatedOptimizationMetrics: metrics } = require("../../../shared/observability/coordinatedOptimizationMetrics");

// Version this contract when artifactModels' raw-fact semantics change. Events
// and effects are deliberately evaluated by the scorer, not included in this
// cache of sample-window/daily-input answers.
const INPUT_SEMANTICS = 1;

async function preparedScoringModels({ client, capture, roots, budget = { pages: 16 } }) {
  const scopes = new Map();
  for (const userId of capture.userIds) {
    const rootIds = [...new Set(roots.filter((root) => root.userId === userId).map((root) => root.id))].sort();
    if (!rootIds.length) throw new Error("Missing durable scoring root vector");
    const scope = {
      version: INPUT_SEMANTICS, userId, rootIds,
      sampleStart: capture.payload.race.startedAt, sampleEnd: capture.payload.cutoffAt,
      dailyStart: capture.rangeStart, dailyEnd: capture.rangeEnd,
    };
    scopes.set(userId, { ...scope, digest: digestCanonical(scope).digest,
      roots: [...new Map(roots.filter((root) => root.userId === userId).map((root) => [root.id, root])).values()]
        .sort((a, b) => a.day.localeCompare(b.day)),
      answers: {}, pending: new Map(), dirty: false });
  }
  const stored = scopes.size ? await client.$queryRawUnsafe(
    `SELECT scope_digest,answers,
       answers_digest=encode(sha256(convert_to(answers::text,'UTF8')),'hex') AS valid
     FROM durable_capture_prepared_inputs WHERE scope_digest=ANY($1::text[])`,
    [...scopes.values()].map((scope) => scope.digest),
  ) : [];
  if (stored.some((row) => row.valid !== true || !row.answers || Array.isArray(row.answers) ||
      typeof row.answers !== "object")) {
    const error = new Error("Durable prepared scoring inputs are corrupt");
    error.code = "INPUTS_NOT_RETAINED";
    throw error;
  }
  const answersByDigest = new Map(stored.map((row) => [row.scope_digest, row.answers]));
  for (const scope of scopes.values()) scope.answers = answersByDigest.get(scope.digest) || {};

  function invoke(kind, method, args) {
    const scope = scopes.get(args[0]);
    if (!scope) throw new Error("Scorer requested an unpinned dependency");
    const key = digestCanonical({ kind, method, args }).digest;
    if (Object.hasOwn(scope.answers, key)) return Promise.resolve(scope.answers[key]);
    if (!scope.pending.has(key)) scope.pending.set(key, (async () => {
      const { answer, openAnswer } = await resolveIntervalProjection({ client, scope, key, kind, method, args, budget });
      scope.answers[key] = answer;
      scope.dirty = true;
      metrics.increment("global_summary_capture_prepared_method_total");
      // Other uploaders can apply their event to the same effect segment.
      // Their global-event term uses open sums, whereas ordinary effect terms
      // use closed sums. Prepare the open answer while this user's facts are
      // already present; never infer it from a closed answer.
      if (kind === "sampleModel" && method === "sumClosedStepsInWindow") {
        const openArgs = args.slice(0, 3);
        const openKey = digestCanonical({ kind, method: "sumStepsInWindow", args: openArgs }).digest;
        if (!Object.hasOwn(scope.answers, openKey)) {
          scope.answers[openKey] = openAnswer;
          metrics.increment("global_summary_capture_prepared_method_total");
        }
      }
      return answer;
    })());
    return scope.pending.get(key);
  }
  const models = artifactModels(capture.payload);
  for (const kind of ["sampleModel", "stepsModel"]) {
    models[kind] = Object.fromEntries(Object.keys(models[kind]).map((method) =>
      [method, (...args) => invoke(kind, method, args)]));
  }
  return {
    models,
    async persist() {
      // scoreCaptureArtifact evaluates two counterfactuals concurrently. When
      // one yields, finish their outstanding bounded advances before flushing.
      await Promise.allSettled([...scopes.values()].flatMap((scope) => [...scope.pending.values()]));
      const changed = [...scopes.values()].filter((scope) => scope.dirty).map((scope) => ({
        digest: scope.digest, userId: scope.userId, rootIds: scope.rootIds, answers: scope.answers,
      }));
      if (!changed.length) return;
      await client.$executeRawUnsafe(`INSERT INTO durable_capture_prepared_inputs
        (scope_digest,user_id,root_ids,answers,answers_digest)
        SELECT value->>'digest',value->>'userId',
          ARRAY(SELECT jsonb_array_elements_text(value->'rootIds'))::uuid[],value->'answers',
          encode(sha256(convert_to((value->'answers')::text,'UTF8')),'hex')
        FROM jsonb_array_elements($1::jsonb)
        ON CONFLICT (scope_digest) DO UPDATE SET
          answers=durable_capture_prepared_inputs.answers || EXCLUDED.answers,
          answers_digest=encode(sha256(convert_to(
            (durable_capture_prepared_inputs.answers || EXCLUDED.answers)::text,'UTF8')),'hex'),
          updated_at=clock_timestamp()`, JSON.stringify(changed));
    },
  };
}

module.exports = { preparedScoringModels };
