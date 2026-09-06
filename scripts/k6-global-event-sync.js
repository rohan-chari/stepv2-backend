import http from 'k6/http';
import exec from 'k6/execution';
import crypto from 'k6/crypto';
import { check } from 'k6';
import { sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const baseUrl = __ENV.BASE_URL || '';
const runId = __ENV.CAPACITY_RUN_ID || '';
const profile = __ENV.GLOBAL_EVENT_SYNC_PROFILE || 'eligible-overlap';
const rate = Number(__ENV.ARRIVAL_RATE || 1);
const duration = __ENV.DURATION || '30s';
const users = Number(__ENV.USERS || 1);
const sampleCount = Number(__ENV.SAMPLES_PER_SYNC || 12);
const date = __ENV.SYNC_DATE || new Date().toISOString().slice(0, 10);
const repeat = Number(__ENV.CAPACITY_REPEAT || 1);
const tokens = String(__ENV.CAPACITY_TOKENS || '').split(',').filter(Boolean);
const cohort = __ENV.CAPACITY_COHORT || (profile === 'ordinary-sync' || profile === 'idle-baseline' ? 'control' : 'treatment');
const requestIntent = __ENV.CAPACITY_REQUEST_INTENT || (['home-pull', 'home-open', 'app-resume'].includes(profile) ? 'home-pull' : 'background-sync');
const reuseIntervalSeconds = Number(__ENV.USER_REUSE_INTERVAL_SECONDS || 0);
const durationSeconds = (() => { const match = String(duration).match(/^(\d+(?:\.\d+)?)(s|m|h)$/i); return match ? Number(match[1]) * ({ s: 1, m: 60, h: 3600 }[match[2].toLowerCase()]) : 0; })();
const oneShot = String(__ENV.ONE_SHOT || '').toLowerCase() === 'true';
const jitterMs = Math.max(0, Number(__ENV.JITTER_MS || 0));

if (!/^https?:\/\/(127\.0\.0\.1|localhost|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(baseUrl)) {
  throw new Error('global-event k6 requires a loopback/private capacity BASE_URL');
}
if (!/^[a-z0-9][a-z0-9._-]{5,63}$/.test(runId)) throw new Error('CAPACITY_RUN_ID is required');
if (!Number.isInteger(users) || users < 1 || tokens.length < users) throw new Error('CAPACITY_TOKENS must contain one token per configured user');
if (oneShot && Math.ceil(rate * durationSeconds) > users) throw new Error('one-shot wave would reuse fixture users; increase users or shorten duration');
if (!oneShot && reuseIntervalSeconds <= 0) throw new Error('periodic profiles require USER_REUSE_INTERVAL_SECONDS');

export const options = {
  scenarios: { sync: { executor: 'constant-arrival-rate', rate, timeUnit: '1s', duration, preAllocatedVUs: Math.max(users, rate * 2), maxVUs: Math.max(users, rate * 20) } },
  tags: { run_id: runId, profile },
};

const requestLatency = new Trend('global_event_sync_latency', true);
const failures = new Counter('global_event_sync_failures');
const statusCounter = new Counter('global_event_sync_http_status');
const errorCodeCounter = new Counter('global_event_sync_backend_error');
const networkFailures = new Counter('global_event_sync_network_failures');
const timeouts = new Counter('global_event_sync_timeouts');
const malformed = new Counter('global_event_sync_malformed_responses');
const status202 = new Counter('global_event_sync_status_202');
const status409 = new Counter('global_event_sync_status_409');
const status429 = new Counter('global_event_sync_status_429');
const status5xx = new Counter('global_event_sync_status_5xx');
const boundedErrors = new Map();

function uuid(index, globalIteration) {
  // Do not include __VU: open-model scheduling can move an iteration between
  // VUs. The same run/repeat/user/iteration must always produce the same key.
  const hex = crypto.sha256(`${runId}:${profile}:${repeat}:${globalIteration}:${index}`, 'hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function body(index, globalIteration) {
  const noon = new Date(`${date}T12:00:00.000Z`).getTime();
  const samples = Array.from({ length: Math.max(0, Math.min(sampleCount, 96)) }, (_, sampleIndex) => ({
    periodStart: new Date(noon - (sampleCount - sampleIndex) * 900000).toISOString(),
    periodEnd: new Date(noon - (sampleCount - sampleIndex - 1) * 900000).toISOString(),
    steps: 100 + ((index + globalIteration) % 17),
    sourceName: 'capacity-global-event',
    sourceId: `${runId}:${profile}:${repeat}:${index}:${sampleIndex}`,
    recordingMethod: 'automatic',
  }));
  return JSON.stringify({ date, steps: sampleCount * 100 + (index % 17), samples });
}

export default function () {
  const globalIteration = Number(exec.scenario.iterationInTest);
  const intervalIterations = Math.max(1, Math.floor(rate * reuseIntervalSeconds));
  const index = oneShot ? globalIteration : Math.floor(globalIteration / intervalIterations) % Math.max(1, users);
  const userAttempt = oneShot ? 0 : Math.floor(globalIteration / Math.max(1, intervalIterations));
  const tags = { cohort, intent: requestIntent };
  // Keep the jitter deterministic and tied to the logical iteration so paired
  // synchronized/jittered runs remain reproducible while spreading arrivals.
  if (jitterMs > 0) {
    const offset = ((globalIteration * 1103515245 + 12345) % 100000) / 100000;
    sleep((offset * jitterMs) / 1000);
  }
  const response = http.post(`${baseUrl}/steps/sync-v2`, body(index, globalIteration), {
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokens[index % Math.max(1, tokens.length)] || ''}`, 'Idempotency-Key': uuid(index, userAttempt), ...(requestIntent === 'home-pull' ? { 'X-Step-Sync-Intent': 'home-pull' } : {}), 'X-App-Version': '2.3.11', 'X-Client-Features': 'impact_summaries,impact_summary_expiry_v1', 'X-Capacity-Run-Id': runId },
    tags,
  });
  requestLatency.add(response.timings.duration);
  const status = Number(response.status || 0);
  statusCounter.add(1, { status: String(status), cohort, intent: requestIntent });
  if (status === 202) status202.add(1, tags);
  else if (status === 409) status409.add(1, tags);
  else if (status === 429) status429.add(1, tags);
  else if (status >= 500) status5xx.add(1, tags);
  if (status === 0) {
    networkFailures.add(1, tags);
    if (String(response.error || '').toLowerCase().includes('timeout')) timeouts.add(1, tags);
  }
  let parsed = null;
  try { parsed = response.body ? JSON.parse(response.body) : null; } catch { malformed.add(1, tags); }
  const code = parsed?.code || parsed?.errorCode || parsed?.error?.code;
  if (code) {
    errorCodeCounter.add(1, { code: String(code).slice(0, 64), status: String(status), cohort, intent: requestIntent });
    const key = String(code).slice(0, 64);
    if (boundedErrors.size < 20 || boundedErrors.has(key)) {
      const first = !boundedErrors.has(key);
      boundedErrors.set(key, { status, code: key, error: String(parsed?.error || '').slice(0, 160) });
      if (first) console.log(`CAPACITY_HTTP_ERROR ${JSON.stringify(boundedErrors.get(key))}`);
    }
  }
  const ok = check(response, { 'sync response is accepted': (item) => [202, 409].includes(item.status) });
  if (!ok) failures.add(1);
}
