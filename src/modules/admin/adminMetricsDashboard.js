const { appSettings: defaultAppSettings } = require("../../shared/config/appSettings");

const LEGACY_SECTIONS = new Set(["economy", "ads", "extra-spin-funnel"]);
const DASHBOARD_SECTIONS = new Set([
  "dashboard-summary",
  "dashboard-growth",
  "dashboard-funnels",
  "dashboard-activation",
  "dashboard-retention",
  "dashboard-engagement",
  "dashboard-dau-engagement",
  "dashboard-virality",
  "dashboard-revenue",
  "dashboard-release-adoption",
]);
const WINDOWS = new Map([
  ["7d", 7],
  ["30d", 30],
  ["90d", 90],
]);
const TIME_ZONE = "America/New_York";

class AdminStatsRequestError extends Error {
  constructor(message, code) {
    super(message);
    this.statusCode = 400;
    this.code = code;
  }
}

function normalizedSections(raw) {
  const input = Array.isArray(raw)
    ? raw.flatMap((value) => String(value).split(","))
    : typeof raw === "string"
      ? raw.split(",")
      : [];
  return input.map((value) => value.trim().toLowerCase()).filter(Boolean);
}

function classifyAdminStatsRequest({ sections, window } = {}) {
  const names = normalizedSections(sections);
  const legacy = [...new Set(names.filter((name) => LEGACY_SECTIONS.has(name)))];
  const dashboard = [
    ...new Set(names.filter((name) => DASHBOARD_SECTIONS.has(name))),
  ];

  if (legacy.length > 0 && dashboard.length > 0) {
    throw new AdminStatsRequestError(
      "Legacy and dashboard sections cannot be mixed",
      "MIXED_STATS_SECTIONS"
    );
  }
  if (dashboard.length > 1) {
    throw new AdminStatsRequestError(
      "Request one dashboard section at a time",
      "MULTIPLE_DASHBOARD_SECTIONS"
    );
  }
  if (dashboard.length === 0) {
    return { mode: "legacy", legacySections: legacy };
  }

  const windowToken = window === undefined ? "30d" : String(window).toLowerCase();
  const days = WINDOWS.get(windowToken);
  if (!days) {
    throw new AdminStatsRequestError(
      "Window must be 7d, 30d, or 90d",
      "INVALID_WINDOW"
    );
  }
  return { mode: "dashboard", section: dashboard[0], days };
}

const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function etDateString(instant) {
  const parts = Object.fromEntries(
    dateFormatter.formatToParts(instant).map(({ type, value }) => [type, value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addUtcDays(dateString, delta) {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + delta));
  return date.toISOString().slice(0, 10);
}

function buildWindow(days, now) {
  const end = etDateString(now);
  return {
    days,
    start: addUtcDays(end, -(days - 1)),
    end,
    timeZone: TIME_ZONE,
  };
}

function buildSources({ generatedAt, telemetryEnabled }) {
  return {
    productDb: { status: "available", asOf: generatedAt },
    foregroundActivity: {
      status: telemetryEnabled ? "collecting" : "disabled",
      asOf: telemetryEnabled ? generatedAt : null,
    },
    appStoreConnect: { status: "not_configured", asOf: null },
    admob: { status: "not_configured", asOf: null },
  };
}

function buildGetAdminMetricsDashboard(dependencies = {}) {
  const settings = dependencies.appSettings || defaultAppSettings;
  const now = dependencies.now || (() => new Date());

  return async function getAdminMetricsDashboard({ section, days }) {
    const generatedAt = now().toISOString();
    const enabled = await settings.getFlag("adminMetricsV2DashboardEnabled");
    const telemetryEnabled = enabled
      ? await settings.getFlag("adminMetricsV2TelemetryEnabled")
      : false;
    const metricsDashboard = {
      schemaVersion: 2,
      status: enabled ? "available" : "disabled",
      window: buildWindow(days, new Date(generatedAt)),
      sources: buildSources({ generatedAt, telemetryEnabled }),
    };

    // Metric blocks are attached by the block loader only when the dashboard
    // flag is enabled. The default-off envelope deliberately performs no
    // metric query and contains no coverage or block placeholder.
    if (enabled && dependencies.loadBlock) {
      Object.assign(
        metricsDashboard,
        await dependencies.loadBlock({ section, days, generatedAt })
      );
    }
    return { generatedAt, metricsDashboard };
  };
}

module.exports = {
  AdminStatsRequestError,
  DASHBOARD_SECTIONS,
  LEGACY_SECTIONS,
  TIME_ZONE,
  buildGetAdminMetricsDashboard,
  buildWindow,
  classifyAdminStatsRequest,
};
