const path = require("node:path");
const { parseCli } = require("./cli");

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const cli = parseCli(argv);
  if (cli.command === "global-event-sync") {
    const script = path.resolve(dependencies.repository || path.join(__dirname, "../.."), "scripts/global-event-sync-capacity.js");
    const run = dependencies.runGlobalEventSync || ((args) => require("node:child_process").execFileSync(process.execPath, [script, cli.subcommand, ...args], { stdio: "inherit" }));
    await run(cli.globalEventSyncArgs || []);
    return { exitCode: 0, globalEventSync: true };
  }
  if (cli.workload === "races-tab-open" && cli.cache !== "warm") {
    throw new Error("the first Races-tab workload is a warm-cache profile");
  }
  if (cli.workload === "races-tab-open" && cli.scoreShape && cli.scoreShape !== "production") {
    throw new Error("the first Races-tab workload requires the production-shaped score profile");
  }
  if (["certify", "compare", "refresh-data"].includes(cli.command)) {
    throw new Error(`${cli.command} is not enabled in the first-run implementation`);
  }
  if (cli.keepRunning) {
    throw new Error("--keep-running is not enabled in the first-run implementation");
  }
  const repository = path.resolve(dependencies.repository || path.join(__dirname, "../.."));
  const loadConfig = dependencies.loadConfig || require("./config").loadConfig;
  const createRuntime = dependencies.createRuntime ||
    ((input) => require("../providers/lima-runtime").createLegacyLimaRuntime(input));
  const createProvider = dependencies.createProvider ||
    ((input) => require("../providers/lima").createLimaProvider(input));
  const createWorkload = dependencies.createWorkload || ((name) => name === "races-tab-open"
    ? require("../workloads/races-tab-open").createRacesTabOpenWorkload()
    : require("../workloads/home-open").createHomeOpenWorkload());
  const runWorkflow = dependencies.runWorkflow || require("./workflow").runPerformanceWorkflow;
  const output = dependencies.output || process.stdout;
  const signalSource = dependencies.signalSource || process;
  const overrides = {
    ...(cli.rates ? { scan: { rates: cli.rates } } : {}),
    ...(cli.scoreShape ? { workload: { scoreShape: cli.scoreShape } } : {}),
  };
  const mode = cli.command === "reset" ? "scan" : cli.command;
  const config = loadConfig({ repository, mode, workload: cli.workload, overrides });
  const adapter = createRuntime({ repository,
    configPath: path.join(repository, config.provider?.legacyConfigPath ||
      "docs/capacity-load.config.json") });
  const provider = createProvider({ adapter });
  if (cli.command === "reset") {
    if (typeof provider.resetEnvironment !== "function") {
      throw new Error("Lima provider does not implement reset");
    }
    await provider.runExclusive({ cli, config }, () => provider.resetEnvironment({ cli, config }));
    output.write("Reusable Lima performance environment reset.\n");
    return { exitCode: 0, reset: true };
  }
  let interruptedSignal = null;
  const onSigint = () => { interruptedSignal ||= "SIGINT"; };
  const onSigterm = () => { interruptedSignal ||= "SIGTERM"; };
  signalSource.once("SIGINT", onSigint);
  signalSource.once("SIGTERM", onSigterm);
  let result;
  try {
    result = await runWorkflow({ repository, cli, config, provider,
      workload: createWorkload(cli.workload), output, getInterruption: () => interruptedSignal });
  } finally {
    signalSource.removeListener("SIGINT", onSigint);
    signalSource.removeListener("SIGTERM", onSigterm);
  }
  output.write(`Report: ${result.reportPath}\n`);
  return { ...result, exitCode: result.failed ? 2 : cli.command === "smoke" &&
    result.summary?.highestPassingRate == null ? 1 : 0 };
}

if (require.main === module) main().then((result) => { process.exitCode = result.exitCode; })
  .catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 2; });

module.exports = { main };
