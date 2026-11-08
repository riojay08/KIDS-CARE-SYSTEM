// utils/mailer.js
// Email transport that works on hosts that block SMTP ports (e.g. Render Free).
// - If BREVO_API_KEY is set, email is sent through Brevo's HTTPS API (port 443).
// - Otherwise it falls back to Gmail SMTP (fine for local development).
require('dotenv').config();
const nodemailer = require('nodemailer');

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const MAIL_FROM = process.env.MAIL_FROM || process.env.GMAIL_USER;
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || 'KidsCare';

const smtp = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
  // fail fast instead of hanging if the host blocks SMTP
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 15000,
});

function assertConfigured() {
  if (BREVO_API_KEY) {
    if (!MAIL_FROM) throw new Error('Set MAIL_FROM (or GMAIL_USER) to a sender email verified in Brevo.');
    return;
  }
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD)
    throw new Error('Email is not configured: set BREVO_API_KEY, or GMAIL_USER + GMAIL_APP_PASSWORD.');
}

async function sendViaBrevo({ to, subject, text, html, fromName, fromEmail }) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': BREVO_API_KEY,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { name: fromName || MAIL_FROM_NAME, email: fromEmail || MAIL_FROM },
      to: [{ email: to }],
      subject,
      textContent: text,
      ...(html ? { htmlContent: html } : {}),
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`Brevo API ${res.status}: ${detail}`);
  }
  return res.json().catch(() => ({}));
}

/**
 * Sends one email using Brevo (HTTPS) when configured, otherwise Gmail SMTP.
 * @param {{to: string, subject: string, text?: string, html?: string, fromName?: string, fromEmail?: string}} mail
 */
async function sendMail({ to, subject, text, html, fromName, fromEmail }) {
  assertConfigured();
  if (BREVO_API_KEY) return sendViaBrevo({ to, subject, text, html, fromName, fromEmail });
  return smtp.sendMail({
    from: `${fromName || MAIL_FROM_NAME} <${fromEmail || MAIL_FROM}>`,
    to,
    subject,
    text,
    html,
  });
}

/**
 * Nagpapadala ng email notification pagkatapos ng QR scan.
 * @param {string} toEmail - Email ng magulang/guardian
 * @param {string} childName - Pangalan ng bata
 * @param {string} status - 'IN' o 'OUT'
 * @param {string} timeString - Oras ng scan
 */
async function sendQRScanNotification(toEmail, childName, status, timeString) {
  const actionText = status === 'IN' ? 'dumating na sa skwelahan/center' : 'nakauwi/umalis na';

  return sendMail({
    to: toEmail,
    subject: `[KidsCare Notification] ${childName} Scan ${status}`,
    html: `
      <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #4CAF50; border-radius: 8px;">
        <h2 style="color: #2E7D32;">KidsCare Attendance Alert</h2>
        <p>Magandang araw,</p>
        <p>Nais naming ipagbigay-alam na si <strong>${childName}</strong> ay <strong>${actionText}</strong>.</p>
        <p><strong>Oras:</strong> ${timeString}</p>
        <br/>
        <p>Salamat sa paggamit ng KidsCare App!</p>
      </div>
    `,
  });
}

module.exports = { sendMail, sendQRScanNotification, emailProvider: BREVO_API_KEY ? 'brevo' : 'gmail-smtp' };
