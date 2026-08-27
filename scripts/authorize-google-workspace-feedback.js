#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { OAuth2Client } = require("google-auth-library");

const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const SUPPORT_ADDRESS = "support@barastep.com";
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

function argument(name) {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : null;
}

function oauthClientConfig(document) {
  const config = document?.installed || document?.web;
  if (!config || typeof config !== "object") return null;
  const redirectUri = Array.isArray(config.redirect_uris)
    ? config.redirect_uris.find((value) => {
      try {
        const url = new URL(value);
        return url.protocol === "http:" &&
          (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
          Boolean(url.port);
      } catch {
        return false;
      }
    })
    : null;
  if (
    typeof config.client_id !== "string" || !config.client_id ||
    typeof config.client_secret !== "string" || !config.client_secret ||
    !redirectUri
  ) return null;
  return {
    clientId: config.client_id,
    clientSecret: config.client_secret,
    redirectUri,
  };
}

async function waitForAuthorizationCode(authorizationUrl, redirectUri, expectedState) {
  const callback = new URL(redirectUri);
  let resolveCode;
  let rejectCode;
  const codePromise = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = http.createServer((req, res) => {
    const received = new URL(req.url || "/", redirectUri);
    if (received.pathname !== callback.pathname) {
      res.writeHead(404).end("Not found");
      return;
    }
    if (
      received.searchParams.get("state") !== expectedState ||
      !received.searchParams.get("code") ||
      received.searchParams.has("error")
    ) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Authorization failed. Return to the terminal.");
      rejectCode(new Error("OAuth authorization was not completed"));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bara feedback authorization received. You may close this tab.");
    resolveCode(received.searchParams.get("code"));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(callback.port), callback.hostname, resolve);
  });
  process.stdout.write("Open this Google authorization URL while signed in as support@barastep.com:\n\n");
  process.stdout.write(`${authorizationUrl}\n\n`);

  let timeout;
  try {
    return await Promise.race([
      codePromise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("OAuth authorization timed out")), AUTH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    await new Promise((resolve) => server.close(resolve));
  }
}

async function authorizeFeedbackOAuth(options) {
  const {
    clientPath,
    outputPath,
    readFile = fs.readFile,
    writeFile = fs.writeFile,
    chmod = fs.chmod,
    oauthClientFactory = (clientOptions) => new OAuth2Client(clientOptions),
    waitForAuthorizationCode: waitForCode = waitForAuthorizationCode,
    randomState = () => crypto.randomBytes(32).toString("base64url"),
    stdout = process.stdout,
  } = options;
  const resolvedClientPath = path.resolve(clientPath);
  const resolvedOutputPath = path.resolve(outputPath);
  const source = JSON.parse(await readFile(resolvedClientPath, "utf8"));
  const config = oauthClientConfig(source);
  if (!config) {
    throw new Error("OAuth client JSON must include a fixed localhost redirect URI with an explicit port");
  }

  const client = oauthClientFactory({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
    transporterOptions: { timeout: 10_000, retry: false },
  });
  const verifier = await client.generateCodeVerifierAsync();
  const state = randomState();
  const authorizationUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: false,
    scope: [GMAIL_SEND_SCOPE],
    login_hint: SUPPORT_ADDRESS,
    hd: "barastep.com",
    state,
    code_challenge_method: "S256",
    code_challenge: verifier.codeChallenge,
  });
  const code = await waitForCode(authorizationUrl, config.redirectUri, state);
  const { tokens } = await client.getToken({
    code,
    codeVerifier: verifier.codeVerifier,
    redirect_uri: config.redirectUri,
  });
  if (typeof tokens?.refresh_token !== "string" || !tokens.refresh_token) {
    throw new Error("Google did not return an offline refresh token; revoke the old grant and authorize again");
  }
  if (typeof tokens.access_token !== "string" || !tokens.access_token) {
    throw new Error("Google did not return an access token for verification");
  }
  const info = await client.getTokenInfo(tokens.access_token);
  const scopes = Array.isArray(info.scopes) ? [...info.scopes].sort() : [];
  if (
    info.aud !== config.clientId ||
    scopes.length !== 1 ||
    scopes[0] !== GMAIL_SEND_SCOPE
  ) {
    throw new Error("The OAuth grant does not match the configured client and gmail.send scope");
  }

  await writeFile(resolvedOutputPath, `${JSON.stringify({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    refreshToken: tokens.refresh_token,
  }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(resolvedOutputPath, 0o600);
  stdout.write(`OAuth secret written with mode 0600 to ${resolvedOutputPath}\n`);
}

async function main() {
  const clientPath = argument("client");
  const outputPath = argument("output");
  if (!clientPath || !outputPath) {
    throw new Error("Usage: node scripts/authorize-google-workspace-feedback.js --client=/absolute/oauth-client.json --output=/absolute/feedback-oauth.json");
  }
  await authorizeFeedbackOAuth({ clientPath, outputPath });
}

if (require.main === module) {
  main().catch(() => {
    process.stderr.write("Feedback OAuth authorization failed; no token values were printed.\n");
    process.exitCode = 1;
  });
}

module.exports = { authorizeFeedbackOAuth, oauthClientConfig };
