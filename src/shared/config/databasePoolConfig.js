const ROLE_VARIABLES = Object.freeze({
  http: "DATABASE_POOL_MAX_HTTP",
  resolution: "DATABASE_POOL_MAX_RESOLUTION",
  cron: "DATABASE_POOL_MAX_CRON",
  all: "DATABASE_POOL_MAX_ALL",
});
const CONFIG_VARIABLES = Object.freeze([
  ...Object.values(ROLE_VARIABLES),
  "DATABASE_POOL_MAX_DEFAULT",
  "DATABASE_POOL_TOTAL_BUDGET",
]);
const CANONICAL_POOL_MAX = /^(?:[1-9]|[1-4][0-9]|50)$/;

function strictTrue(value) {
  return value === "true" || value === "1";
}

function parseDatabasePoolMax(value, variable) {
  if (typeof value !== "string" || !CANONICAL_POOL_MAX.test(value)) {
    throw new Error(`${variable} must be a canonical base-10 integer from 1 through 50`);
  }
  return Number(value);
}

function resolveDatabasePoolConfig(env = process.env, dependencies = {}) {
  const role = env.STEPS_PROCESS_ROLE || "all";

  // DB_POOL_MAX remains exclusively owned by the protected capacity path. Its
  // validator proves the target is isolated before returning a value; ordinary
  // role variables deliberately have no effect on that measurement topology.
  if (strictTrue(env.CAPACITY_MODE)) {
    if (typeof dependencies.capacityDatabasePoolMax !== "function") {
      throw new Error("Validated capacity database pool resolver is required in capacity mode");
    }
    return {
      role,
      max: dependencies.capacityDatabasePoolMax(env),
      source: env.DB_POOL_MAX == null || env.DB_POOL_MAX === ""
        ? "capacity-default"
        : "DB_POOL_MAX",
    };
  }

  const productionCliConfig = dependencies.productionCliDatabasePoolConfig?.(env);
  if (productionCliConfig) return productionCliConfig;

  if (env.NODE_ENV === "production" &&
      (typeof env.STEPS_PROCESS_ROLE !== "string" ||
        !Object.hasOwn(ROLE_VARIABLES, env.STEPS_PROCESS_ROLE))) {
    throw new Error("STEPS_PROCESS_ROLE must be one of http, resolution, cron, or all in production");
  }

  for (const variable of CONFIG_VARIABLES) {
    if (Object.hasOwn(env, variable)) parseDatabasePoolMax(env[variable], variable);
  }

  const roleVariable = Object.hasOwn(ROLE_VARIABLES, role) ? ROLE_VARIABLES[role] : null;
  if (env.NODE_ENV === "production") {
    if (!Object.hasOwn(env, roleVariable)) {
      throw new Error(`${roleVariable} must be set for STEPS_PROCESS_ROLE=${role} in production`);
    }
    return { role, max: parseDatabasePoolMax(env[roleVariable], roleVariable), source: roleVariable };
  }

  if (roleVariable && Object.hasOwn(env, roleVariable)) {
    return { role, max: parseDatabasePoolMax(env[roleVariable], roleVariable), source: roleVariable };
  }
  if (Object.hasOwn(env, "DATABASE_POOL_MAX_DEFAULT")) {
    return {
      role,
      max: parseDatabasePoolMax(env.DATABASE_POOL_MAX_DEFAULT, "DATABASE_POOL_MAX_DEFAULT"),
      source: "DATABASE_POOL_MAX_DEFAULT",
    };
  }
  return { role, max: 20, source: "compatibility-default" };
}

module.exports = {
  ROLE_VARIABLES,
  parseDatabasePoolMax,
  resolveDatabasePoolConfig,
};
