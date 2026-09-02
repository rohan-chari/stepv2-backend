const net = require("node:net");

const BLOCKED_API_HOSTS = new Set([
  "steptracker-api.org",
  "www.steptracker-api.org",
  "staging.steptracker-api.org",
  "167.172.225.16",
]);

function isLoopback(address) {
  if (address === "localhost" || address === "::1" || address === "0:0:0:0:0:0:0:1") return true;
  if (net.isIP(address) === 4) return address.startsWith("127.");
  return false;
}

function parseUrl(value, label) {
  try { return new URL(value); } catch { throw new Error(`${label} must be a valid URL`); }
}

function assertSafeTrafficTarget({ baseUrl, resolvedAddresses = [], target } = {}) {
  const parsed = parseUrl(baseUrl, "performance base URL");
  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_API_HOSTS.has(hostname) || /(^|[.-])(prod|production|staging)([.-]|$)/.test(hostname)) {
    throw new Error("production and staging traffic targets are prohibited");
  }
  if (target !== "lima") throw new Error("traffic target is not an approved performance provider");
  if (!isLoopback(hostname) || !resolvedAddresses.length || resolvedAddresses.some((address) => !isLoopback(address))) {
    throw new Error("Lima performance traffic must resolve exclusively to a loopback address");
  }
  return true;
}

function assertPerformanceDatabase({ databaseUrl, marker } = {}) {
  const parsed = parseUrl(databaseUrl, "performance database URL");
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, "")).toLowerCase();
  const host = parsed.hostname.toLowerCase();
  if (!isLoopback(host) || BLOCKED_API_HOSTS.has(host) || /prod|production|staging/.test(host)) {
    throw new Error("performance database host is not disposable/local");
  }
  if (name !== "steps_tracker_capacity" && !/(^|[_-])(perf|performance|capacity|test)([_-]|$)/.test(name) ||
      /(^|[_-])(prod|production)([_-]|$)/.test(name)) {
    throw new Error("performance database name is not approved");
  }
  if (marker?.owner !== "bara-perf" || marker?.disposable !== true) {
    throw new Error("performance database durable ownership marker is missing");
  }
  return true;
}

function assertTargetIdentity({ expectedRunId, expectedAddress, response } = {}) {
  if (Number(response?.status) >= 300 && Number(response?.status) < 400) {
    throw new Error("performance target redirected; redirects are prohibited");
  }
  if (response?.status !== 200) throw new Error("performance target health request failed");
  if (response.address !== expectedAddress) throw new Error("performance target address drifted");
  const actualRunId = response.body?.capacityRunId ?? response.body?.capacity?.runId ??
    response.body?.capacity?.identity?.runId;
  if (!expectedRunId || actualRunId !== expectedRunId) {
    throw new Error("performance target capacity identity mismatch");
  }
  return true;
}

function assertRefreshConnectionsSeparated({ source, target } = {}) {
  if (source?.transactionReadOnly !== true) throw new Error("refresh source must prove transaction read-only mode");
  if (!source?.url || source.url === target?.url) throw new Error("refresh source and writable target must be separate connections");
  assertPerformanceDatabase({ databaseUrl: target?.url, marker: target?.marker });
  return true;
}

module.exports = { assertPerformanceDatabase, assertRefreshConnectionsSeparated,
  assertSafeTrafficTarget, assertTargetIdentity, isLoopback };
