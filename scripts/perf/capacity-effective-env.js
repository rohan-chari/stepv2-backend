const fs = require("node:fs");
const path = require("node:path");

function loadCapacityEffectiveEnvironment(env = process.env) {
  const filePath = env.CAPACITY_EFFECTIVE_ENV_PATH;
  if (!filePath || !path.isAbsolute(filePath)) {
    throw new Error("CAPACITY_EFFECTIVE_ENV_PATH must be an absolute path");
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error("CAPACITY_EFFECTIVE_ENV_PATH must name a regular file");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("capacity effective environment must not be group/world accessible");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("capacity effective environment must be owned by the current user");
  }
  const loaded = require("dotenv").config({
    path: filePath,
    override: true,
    quiet: true,
  });
  if (loaded.error) throw loaded.error;
  return { path: filePath, mode: stat.mode & 0o777 };
}

module.exports = { loadCapacityEffectiveEnvironment };
