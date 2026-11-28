"use strict";
// Outgoing email (password reset links) over SMTP. Same settings as the billing app: SMTP_HOST, SMTP_PORT,
// SMTP_USER, SMTP_PASS and MAIL_FROM. Works with Microsoft 365, Google Workspace (app password), Zoho, etc.

function createMailer({ host, port, user, pass, from, log = console } = {}) {
  if (!host || !from) return { configured: false, async send() { throw new Error("Email isn't set up."); } };
  const nodemailer = require("nodemailer");
  const p = Number(port) || 587;
  const transport = nodemailer.createTransport({
    host, port: p, secure: p === 465, requireTLS: p !== 465 && p !== 25,
    auth: user ? { user, pass } : undefined,
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000
  });
  return {
    configured: true,
    async send({ to, subject, text }) {
      try {
        await transport.sendMail({ from, to, subject, text });
      } catch (e) {
        log.error("Email to " + to + " failed:", e.message);
        throw e;
      }
    }
  };
}

module.exports = { createMailer };
