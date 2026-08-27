function capacityLoadParameter({ args = {}, config = {}, profile, name } = {}) {
  if (args[name] !== undefined) return args[name];
  if (String(profile || "").startsWith("event_")) return undefined;
  return config[name];
}

module.exports = { capacityLoadParameter };
