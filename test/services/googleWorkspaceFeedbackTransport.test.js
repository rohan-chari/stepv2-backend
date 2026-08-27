const assert = require("node:assert/strict");
const net = require("node:net");
const { describe, it } = require("node:test");
const nodemailer = require("nodemailer");

const {
  buildGoogleWorkspaceFeedbackTransport,
  classifyTransportFailure,
} = require("../../src/modules/feedback/services/googleWorkspaceFeedbackTransport");

describe("Google Workspace feedback transport", () => {
  it("uses fixed STARTTLS relay settings and reconstructs the controlled envelope", async () => {
    let options;
    let mail;
    const transport = buildGoogleWorkspaceFeedbackTransport({
      nodemailer: {
        createTransport(value) {
          options = value;
          return {
            async sendMail(value) {
              mail = value;
              return { accepted: ["support@barastep.com"], rejected: [] };
            },
          };
        },
      },
    });

    await transport.send({
      text: "Plain text only",
      replyTo: "person@example.com",
      messageId: "<12345678-1234-4234-8234-123456789abc@barastep.com>",
      from: "attacker@example.com",
      to: "attacker@example.com",
      subject: "overridden",
      envelope: { from: "attacker@example.com", to: ["attacker@example.com"] },
    });

    assert.deepEqual(options, {
      host: "smtp-relay.gmail.com",
      port: 587,
      secure: false,
      requireTLS: true,
      pool: false,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
      tls: { servername: "smtp-relay.gmail.com" },
      transactionLog: true,
      logger: options.logger,
    });
    assert.equal(typeof options.logger.debug, "function");
    assert.equal(mail.from, "Bara Support <support@barastep.com>");
    assert.equal(mail.to, "support@barastep.com");
    assert.equal(mail.subject, "USER FEEDBACK • 12345678");
    assert.deepEqual(mail.envelope, {
      from: "feedback-bounces@barastep.com",
      to: ["support@barastep.com"],
    });
    assert.equal(mail.html, undefined);
  });

  it("fails closed without throwing during construction when transport config cannot be built", async () => {
    const transport = buildGoogleWorkspaceFeedbackTransport({
      nodemailer: { createTransport() { throw new Error("missing config"); } },
    });
    await assert.rejects(
      transport.send({ text: "x", messageId: "<aaaaaaaa-1234-4234-8234-123456789abc@barastep.com>" }),
      (error) => error.feedbackDelivery === "unavailable"
    );
  });

  it("classifies provider rejection and pre-DATA loss as definitive", () => {
    assert.equal(classifyTransportFailure({ responseCode: 550, command: "DATA" }), "unavailable");
    assert.equal(classifyTransportFailure({ code: "ETIMEDOUT", command: "CONN" }), "unavailable");
    assert.equal(classifyTransportFailure({ code: "ECONNRESET", command: "RCPT TO" }), "unavailable");
  });

  it("classifies DATA or unknown post-dispatch loss as uncertain", () => {
    assert.equal(classifyTransportFailure({ code: "ETIMEDOUT", command: "DATA" }), "uncertain");
    assert.equal(classifyTransportFailure({ code: "ECONNRESET" }), "uncertain");
  });

  it("treats Nodemailer v7's CONN-labeled close after DATA as uncertain", async () => {
    let receivedData = false;
    const smtpServer = net.createServer((socket) => {
      socket.setEncoding("utf8");
      socket.write("220 test.local ESMTP\r\n");
      let buffer = "";
      let inData = false;
      socket.on("data", (chunk) => {
        buffer += chunk;
        for (;;) {
          if (inData) {
            const end = buffer.indexOf("\r\n.\r\n");
            if (end < 0) return;
            receivedData = true;
            socket.destroy();
            return;
          }
          const end = buffer.indexOf("\r\n");
          if (end < 0) return;
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (/^EHLO /i.test(line)) socket.write("250-test.local\r\n250 PIPELINING\r\n");
          else if (/^MAIL FROM:/i.test(line)) socket.write("250 2.1.0 OK\r\n");
          else if (/^RCPT TO:/i.test(line)) socket.write("250 2.1.5 OK\r\n");
          else if (/^DATA$/i.test(line)) {
            inData = true;
            socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
          } else if (/^QUIT$/i.test(line)) socket.end("221 Bye\r\n");
        }
      });
    });
    await new Promise((resolve) => smtpServer.listen(0, "127.0.0.1", resolve));
    const { port } = smtpServer.address();
    const transport = buildGoogleWorkspaceFeedbackTransport({
      nodemailer: {
        createTransport(options) {
          return nodemailer.createTransport({
            ...options,
            host: "127.0.0.1",
            port,
            requireTLS: false,
            tls: undefined,
            socketTimeout: 2_000,
          });
        },
      },
    });

    try {
      await assert.rejects(
        transport.send({
          text: "actual post-DATA close",
          messageId: "<bbbbbbbb-1234-4234-8234-123456789abc@barastep.com>",
        }),
        (error) =>
          error.feedbackDelivery === "uncertain" &&
          error.cause?.command === "CONN"
      );
      assert.equal(receivedData, true);
    } finally {
      await new Promise((resolve) => smtpServer.close(resolve));
    }
  });

  it("rejects partial or unexpected recipient acceptance", async () => {
    const transport = buildGoogleWorkspaceFeedbackTransport({
      transporter: {
        async sendMail() {
          return { accepted: ["support@barastep.com", "other@example.com"], rejected: [] };
        },
      },
    });
    await assert.rejects(
      transport.send({ text: "x", messageId: "<cccccccc-1234-4234-8234-123456789abc@barastep.com>" }),
      (error) => error.feedbackDelivery === "unavailable"
    );
  });
});
