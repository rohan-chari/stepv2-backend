const COMMANDS = new Set(["smoke", "scan", "certify", "compare", "reset", "refresh-data"]);

function usage() {
  return [
    "usage: ./perf <smoke|scan|certify|compare|reset|refresh-data> [options]",
    "  ./perf smoke [--target=lima] [--background=normal|off] [--cache=warm|cold]",
    "  ./perf scan [--target=lima] [--rates=5,10,...] [--background=normal|off] [--cache=warm|cold]",
  ].join("\n");
}

function parseRates(raw) {
  const rates = String(raw).split(",").map(Number);
  if (!rates.length || rates.some((rate) => !Number.isInteger(rate) || rate < 1 || rate > 500) ||
      rates.some((rate, index) => index > 0 && rate <= rates[index - 1])) {
    throw new Error("rates must be unique ascending integers from 1 through 500");
  }
  return rates;
}

function parseCli(argv = []) {
  const [command, ...tokens] = argv;
  if (!COMMANDS.has(command)) throw new Error(usage());
  const result = { command, target: "lima", background: "normal", cache: "warm",
    rates: null, keepRunning: false };
  for (const token of tokens) {
    if (token === "--keep-running") { result.keepRunning = true; continue; }
    const match = token.match(/^--([a-z-]+)=(.*)$/);
    if (!match) throw new Error(`unknown option: ${token}`);
    const [, name, value] = match;
    if (name === "target") {
      if (value !== "lima") throw new Error("target must be lima");
      result.target = value;
    } else if (name === "background") {
      if (!["normal", "off"].includes(value)) throw new Error("background must be normal or off");
      result.background = value;
    } else if (name === "cache") {
      if (!["warm", "cold"].includes(value)) throw new Error("cache must be warm or cold");
      result.cache = value;
    } else if (name === "rates" && command === "scan") {
      result.rates = parseRates(value);
    } else {
      throw new Error(`unknown option: --${name}`);
    }
  }
  return result;
}

module.exports = { parseCli, usage };
