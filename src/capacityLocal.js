const {
  installProductionShutdownHandlers,
  startServer,
} = require("./index");

function startCapacityServer() {
  const server = startServer({ capacityHttpResolutionOnly: true });
  if (process.env.NODE_ENV === "production") {
    installProductionShutdownHandlers({ server });
  }
  return server;
}

if (require.main === module) startCapacityServer();

module.exports = { startCapacityServer };
