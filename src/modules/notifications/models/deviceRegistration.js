const { prisma: defaultPrisma } = require("../../../db");
const {
  deviceRegistrationReadBatch: defaultDeviceRegistrationReadBatch,
} = require("../services/deviceRegistrationReadBatch");
const {
  deviceRegistrationCreateBatch: defaultDeviceRegistrationCreateBatch,
} = require("../services/deviceRegistrationCreateBatch");

const ACTIVE = "ACTIVE";
const MAX_ACTIVE_INSTALLATIONS = 10;
// Registration is an idempotent acknowledgement, while lastRegisteredAt is a
// coarse liveness signal used by cleanup. Refreshing an identical row more
// than once per window adds no correctness and turns every app launch into a
// lock-heavy write transaction.
const UNCHANGED_REGISTRATION_REFRESH_MS = 6 * 60 * 60_000;

function buildDeviceRegistrationModel(prisma = defaultPrisma) {
  const registrationReadBatch = prisma === defaultPrisma
    ? defaultDeviceRegistrationReadBatch
    : null;
  const registrationCreateBatch = prisma === defaultPrisma
    ? defaultDeviceRegistrationCreateBatch
    : null;
  async function lockIdentities(tx, identities) {
    for (const identity of [...new Set(identities)].sort()) {
      await tx.$executeRawUnsafe(
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        "device-registration",
        identity,
      );
    }
  }

  async function lockUsers(tx, userIds) {
    for (const userId of [...new Set(userIds.filter(Boolean))].sort()) {
      await tx.$executeRawUnsafe(
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        "device-registration-user",
        userId,
      );
    }
  }

  async function enforceCap(tx, userId, current) {
    const active = await tx.deviceToken.findMany({
      where: { userId, OR: [{ status: ACTIVE }, { status: null }] },
      orderBy: [{ lastRegisteredAt: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
      select: { id: true },
    });
    const quarantineIds = active.slice(MAX_ACTIVE_INSTALLATIONS).map((row) => row.id);
    if (quarantineIds.length) {
      await tx.deviceToken.updateMany({
        where: { id: { in: quarantineIds } },
        data: {
          status: "QUARANTINED",
          statusReason: "QUARANTINED_CAP",
          statusChangedAt: current,
        },
      });
    }
    return quarantineIds.length;
  }

  async function register({
    userId,
    token,
    platform,
    installationId = null,
    providerEnvironment = null,
    adminMetricsOpenCapable = false,
    adminMetricsOpenEpochId = null,
    now = new Date(),
    lifecycleEnabled = false,
  }) {
    const current = new Date(now);
    const unchangedWhere = {
        userId,
        token,
        platform,
        installationId,
        providerEnvironment,
        lastRegisteredAt: {
          gte: new Date(current.getTime() - UNCHANGED_REGISTRATION_REFRESH_MS),
        },
        ...(lifecycleEnabled
          ? { status: ACTIVE }
          : { OR: [{ status: ACTIVE }, { status: null }] }),
        ...(adminMetricsOpenCapable
          ? {
              adminMetricsOpenCapable: true,
              adminMetricsOpenEpochId,
            }
          : {}),
      };
    if (lifecycleEnabled && registrationCreateBatch) {
      const resolved = await registrationCreateBatch.tryCreate({
        prisma,
        registration: {
          userId,
          token,
          platform,
          installationId,
          providerEnvironment,
          now: current,
          unchangedAfter: new Date(
            current.getTime() - UNCHANGED_REGISTRATION_REFRESH_MS,
          ),
          adminMetricsOpenCapable,
          adminMetricsOpenEpochId: adminMetricsOpenCapable
            ? adminMetricsOpenEpochId
            : null,
        },
      });
      if (resolved) return resolved;
    } else {
      const unchanged = registrationReadBatch
        ? await registrationReadBatch.find({ prisma, where: unchangedWhere })
        : await prisma.deviceToken.findFirst({ where: unchangedWhere });
      if (unchanged) return unchanged;
    }
    if (!lifecycleEnabled) {
      return prisma.deviceToken.upsert({
        where: { userId_token: { userId, token } },
        update: {
          platform,
          installationId,
          providerEnvironment,
          lastRegisteredAt: current,
          ...(adminMetricsOpenCapable
            ? { adminMetricsOpenCapable: true, adminMetricsOpenEpochId }
            : {}),
        },
        create: {
          userId,
          token,
          platform,
          installationId,
          providerEnvironment,
          lastRegisteredAt: current,
          status: null,
          adminMetricsOpenCapable,
          adminMetricsOpenEpochId: adminMetricsOpenCapable ? adminMetricsOpenEpochId : null,
        },
      });
    }
    return prisma.$transaction(async (tx) => {
      const identities = [`token:any:${token}`, `token:${platform}:${token}`];
      if (installationId) identities.push(
        `installation:any:${installationId}`,
        `installation:${platform}:${installationId}`,
      );
      await lockIdentities(tx, identities);

      const tokenRows = await tx.deviceToken.findMany({
        where: { platform, token },
        orderBy: [{ lastRegisteredAt: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
      });
      const installationRows = installationId
        ? await tx.deviceToken.findMany({
            where: { platform, installationId },
            orderBy: [{ lastRegisteredAt: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
          })
        : [];
      await lockUsers(tx, [userId, ...tokenRows.map((row) => row.userId), ...installationRows.map((row) => row.userId)]);

      // Every ownership mutation takes the same token/installation advisory
      // locks, so these rows cannot change while we wait for the user locks.
      // Re-reading both fields here doubled the hottest launch query count
      // without strengthening the ownership fence.
      const tokens = tokenRows;
      const installs = installationRows;
      // Preserve the retained global (userId,token) compatibility key: if the
      // destination already owns a legacy row for this raw token, that row must
      // remain canonical even when another user's duplicate is newer. Moving a
      // different row onto the destination first would collide before the
      // duplicate can be marked inactive (status is not part of the old key).
      let canonical = tokens.find((row) => row.userId === userId) ||
        installs.find((row) => row.userId === userId) ||
        tokens[0] || installs[0] || null;
      const duplicates = [...new Map([...tokens, ...installs]
        .filter((row) => row.id !== canonical?.id)
        .map((row) => [row.id, row])).values()];
      if (duplicates.length) {
        await tx.deviceToken.updateMany({
          where: { id: { in: duplicates.map((row) => row.id) } },
          data: {
            installationId: null,
            status: "SUPERSEDED",
            statusReason: "OWNERSHIP_CHANGED",
            statusChangedAt: current,
          },
        });
      }

      const generation = canonical
        ? canonical.ownershipGeneration + (
            canonical.userId !== userId || canonical.token !== token ||
            canonical.installationId !== installationId ? 1 : 0
          )
        : 1;
      const data = {
        userId,
        token,
        platform,
        installationId,
        providerEnvironment,
        lastRegisteredAt: current,
        status: ACTIVE,
        statusReason: null,
        statusChangedAt: current,
        ownershipGeneration: generation,
        ...(adminMetricsOpenCapable
          ? { adminMetricsOpenCapable: true, adminMetricsOpenEpochId }
          : {}),
      };
      canonical = canonical
        ? await tx.deviceToken.update({ where: { id: canonical.id }, data })
        : await tx.deviceToken.create({
            data: {
              ...data,
              adminMetricsOpenCapable,
              adminMetricsOpenEpochId: adminMetricsOpenCapable ? adminMetricsOpenEpochId : null,
            },
          });
      await enforceCap(tx, userId, current);
      return canonical;
    }, { timeout: 10_000, maxWait: 5_000 });
  }

  async function remove({ userId, token = null, installationId = null }) {
    return prisma.$transaction(async (tx) => {
      const identities = [];
      if (token) identities.push(`token:any:${token}`);
      if (installationId) identities.push(`installation:any:${installationId}`);
      await lockIdentities(tx, identities);
      await lockUsers(tx, [userId]);
      const byToken = token
        ? await tx.deviceToken.findFirst({ where: { userId, token, OR: [{ status: ACTIVE }, { status: null }] } })
        : null;
      const byInstallation = installationId
        ? await tx.deviceToken.findFirst({ where: { userId, installationId, OR: [{ status: ACTIVE }, { status: null }] } })
        : null;
      if (token && installationId && (!byToken || !byInstallation || byToken.id !== byInstallation.id)) {
        return { mismatch: true, removed: 0 };
      }
      const where = installationId
        ? { userId, installationId }
        : { userId, token };
      const result = await tx.deviceToken.deleteMany({ where });
      return { mismatch: false, removed: result.count };
    });
  }

  return { register, remove, enforceCap };
}

const DeviceRegistration = buildDeviceRegistrationModel();

module.exports = {
  ACTIVE,
  MAX_ACTIVE_INSTALLATIONS,
  UNCHANGED_REGISTRATION_REFRESH_MS,
  buildDeviceRegistrationModel,
  DeviceRegistration,
};
