const http = require("node:http");
const { createApp } = require("../../src/app");
const { prisma } = require("../../src/db");

module.exports = async function globalSetup() {
  const app = createApp({
    verifyAppleIdentityToken: async (token) => ({
      sub: token,
      email: `${token}@example.com`,
    }),
  });

  const server = http.createServer(app);

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  process.env.TEST_BASE_URL = `http://127.0.0.1:${address.port}`;

  return async function globalTeardown() {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await prisma.$disconnect();
  };
};
