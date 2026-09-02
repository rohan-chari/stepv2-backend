const fs = require("node:fs");
const path = require("node:path");
const {
  BOOT_FILENAME_RE,
  INCIDENT_FILENAME_RE,
  createOperationalAlertSpool,
  validateIncidentMarker,
} = require("./operationalAlertSpool");
const { buildOperationalEmailAlertModel } = require("./operationalEmailAlertModel");

const IMPORT_BATCH_SIZE = 25;
const IMPORT_INTERVAL_MS = 30_000;
const BOOT_RETENTION_MS = 90 * 24 * 60 * 60_000;

function buildOperationalAlertSpoolImporter(dependencies = {}) {
  const processRole = dependencies.processRole || process.env.STEPS_PROCESS_ROLE || "all";
  const nodeEnv = dependencies.nodeEnv || process.env.NODE_ENV || "development";
  const spool = dependencies.spool || createOperationalAlertSpool();
  const model = dependencies.model || buildOperationalEmailAlertModel({ prisma: dependencies.prisma });
  const logger = dependencies.logger || console;
  const now = dependencies.now || (() => new Date());
  let running = false;
  const bootMarkerCache = new Map();

  function quarantine(name) {
    const fullPath = path.join(spool.directory, name);
    const quarantineName = `.quarantine-${Date.now()}-${path.basename(name)}`.slice(0, 240);
    fs.renameSync(fullPath, path.join(spool.directory, quarantineName));
    spool.syncDirectory();
  }

  return async function importOperationalAlertMarkers() {
    if (nodeEnv !== "production" || processRole !== "cron" || running) return 0;
    running = true;
    try {
      spool.ensureDirectory();
      const names = fs.readdirSync(spool.directory).sort();
      const bootNames = names.filter((name) => BOOT_FILENAME_RE.test(name));
      const visibleBootNames = new Set(bootNames);
      for (const cachedName of bootMarkerCache.keys()) {
        if (!visibleBootNames.has(cachedName)) bootMarkerCache.delete(cachedName);
      }
      let workUsed = 0;
      for (const name of bootNames) {
        if (bootMarkerCache.has(name) || workUsed >= IMPORT_BATCH_SIZE) continue;
        workUsed += 1;
        try {
          const marker = spool.readMarkerFile(name);
          // Keep the trusted directory-entry identity separate from untrusted
          // JSON fields. readMarkerFile has already enforced the exact schema
          // and filename/content binding.
          bootMarkerCache.set(name, { ...marker, name });
        } catch (error) {
          try { quarantine(name); } catch (_) {}
          logger.error(JSON.stringify({ event: "operational_alert_spool_invalid", kind: "boot", errorCode: error?.code || "INVALID_MARKER" }));
        }
      }
      const bootScanComplete = bootNames.every((name) => bootMarkerCache.has(name));
      const bootMarkers = [...bootMarkerCache.values()];
      bootMarkers.sort((left, right) =>
        new Date(left.bootedAt).getTime() - new Date(right.bootedAt).getTime()
      );

      let imported = 0;
      let bootMarkersDeleted = 0;
      for (const name of names) {
        if (workUsed >= IMPORT_BATCH_SIZE || !INCIDENT_FILENAME_RE.test(name)) continue;
        workUsed += 1;
        const fullPath = path.join(spool.directory, name);
        let markerValidated = false;
        try {
          const marker = spool.readMarkerFile(name);
          validateIncidentMarker(marker);
          markerValidated = true;
          const payload = { ...marker };
          delete payload.schemaVersion;
          delete payload.alertType;
          delete payload.bootId;
          delete payload.attemptUuid;
          if (marker.alertType === "watchdog") {
            // An unread boot marker could be the first restart after this
            // incident. Defer correlation until the bounded boot scan has
            // completed rather than choosing a later cached process.
            if (!bootScanComplete) continue;
            const incidentAt = new Date(marker.observedAt).getTime();
            const nextBoot = bootMarkers.find((boot) =>
              new Date(boot.bootedAt).getTime() > incidentAt
            );
            if (!nextBoot) continue;
            payload.previousPid = marker.workerPid;
            payload.newPid = nextBoot.pid;
            payload.newBootId = nextBoot.bootId;
            payload.newBootedAt = nextBoot.bootedAt;
          }
          const admission = await model.admit({
            alertType: marker.alertType,
            attemptId: marker.attemptId,
            payload,
            now: new Date(marker.observedAt),
          });
          fs.unlinkSync(fullPath);
          spool.syncDirectory();
          imported += 1;
          if (!admission?.admitted) {
            logger.log(JSON.stringify({
              event: "operational_email_alert_admission",
              outcome: "suppressed",
              alertType: marker.alertType,
              reason: admission?.reason || "unknown",
            }));
          }
        } catch (error) {
          // Once validation succeeds, database and filesystem failures retain
          // the source marker for the next cron tick. Only malformed or unsafe
          // source files are quarantined.
          if (markerValidated) throw error;
          try { quarantine(name); } catch (_) {}
          logger.error(JSON.stringify({ event: "operational_alert_spool_invalid", kind: "incident", errorCode: error?.code || "INVALID_MARKER" }));
        }
      }

      // Visible files that are neither a supported marker nor an existing
      // bounded quarantine entry are malformed input, not permanent clutter.
      // Same-directory rename preserves the directory count and never follows
      // a path supplied by file content.
      for (const name of names) {
        if (workUsed >= IMPORT_BATCH_SIZE) break;
        if (
          INCIDENT_FILENAME_RE.test(name) ||
          BOOT_FILENAME_RE.test(name) ||
          name.startsWith(".tmp-") ||
          name.startsWith(".quarantine-")
        ) continue;
        workUsed += 1;
        try { quarantine(name); } catch (_) {}
        logger.error(JSON.stringify({
          event: "operational_alert_spool_invalid",
          kind: "filename",
          errorCode: "INVALID_MARKER_NAME",
        }));
      }

      const cutoff = now().getTime() - BOOT_RETENTION_MS;
      const remainingIncidents = fs.readdirSync(spool.directory)
        .filter((name) => INCIDENT_FILENAME_RE.test(name));
      // Retaining an old boot marker is always safe. Delete only when every
      // boot has been validated and no incident remains that could still need
      // correlation; this avoids an O(boots × incidents) body-read scan.
      for (const boot of bootMarkers) {
        if (workUsed >= IMPORT_BATCH_SIZE) break;
        if (new Date(boot.bootedAt).getTime() > cutoff) continue;
        if (bootScanComplete && remainingIncidents.length === 0) {
          workUsed += 1;
          try {
            fs.unlinkSync(path.join(spool.directory, boot.name));
            bootMarkerCache.delete(boot.name);
            bootMarkersDeleted += 1;
          } catch (_) {}
        }
      }
      if (imported > 0 || bootMarkersDeleted > 0) spool.syncDirectory();
      return imported;
    } finally {
      running = false;
    }
  };
}

function scheduleOperationalAlertSpoolImporter(dependencies = {}) {
  const run = buildOperationalAlertSpoolImporter(dependencies);
  const interval = setInterval(() => run().catch(() => {}), IMPORT_INTERVAL_MS);
  interval.unref?.();
  run().catch(() => {});
  return { interval, stop() { clearInterval(interval); } };
}

module.exports = {
  BOOT_RETENTION_MS,
  IMPORT_BATCH_SIZE,
  IMPORT_INTERVAL_MS,
  buildOperationalAlertSpoolImporter,
  scheduleOperationalAlertSpoolImporter,
};
