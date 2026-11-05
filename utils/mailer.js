// utils/mailer.js
require('dotenv').config();
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

/**
 * Nagpapadala ng email notification pagkatapos ng QR scan.
 * @param {string} toEmail - Email ng mzmagulang/guardian
 * @param {string} childName - Pangalan ng bata
 * @param {string} status - 'IN' o 'OUT'
 * @param {string} timeString - Oras ng scan
 */
async function sendQRScanNotification(toEmail, childName, status, timeString) {
  const actionText = status === 'IN' ? 'dumating na sa skwelahan/center' : 'nakauwi/umalis na';
  
  const mailOptions = {
    from: `"KidsCare Alert" <${process.env.GMAIL_USER}>`,
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
  };

  return transporter.sendMail(mailOptions);
}

module.exports = { sendQRScanNotification };
