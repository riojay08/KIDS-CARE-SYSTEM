// test-email.js
// Usage: node test-email.js [recipient@email.com]
// Uses Brevo HTTPS API when BREVO_API_KEY is set, otherwise Gmail SMTP.
require('dotenv').config();
const { sendMail, emailProvider } = require('./utils/mailer');

if (!process.env.BREVO_API_KEY && (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD)) {
  console.error('ERROR: Set BREVO_API_KEY, or GMAIL_USER + GMAIL_APP_PASSWORD in your .env file.');
  process.exit(1);
}

(async () => {
  const to = process.argv[2] || process.env.MAIL_FROM || process.env.GMAIL_USER;
  try {
    console.log(`Provider: ${emailProvider}`);
    console.log(`Sending test email to: ${to} ...`);
    const info = await sendMail({
      to,
      subject: 'KidsCare Test Notification',
      text: 'Magandang araw! Kung nababasa mo ito, gumagana nang maayos ang notification system ng KidsCare.',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
          <h2 style="color: #4CAF50;">KidsCare Notification Test</h2>
          <p>Magandang araw!</p>
          <p>Kung nababasa mo ito, <strong>gumagana nang maayos</strong> ang notification system ng KidsCare.</p>
          <hr/>
          <small style="color: #777;">System generated test email.</small>
        </div>
      `,
    });

    console.log(`EMAIL SENT SUCCESSFULLY! Message ID: ${info.messageId || '(none returned)'}`);
    console.log(`Check the Inbox and Spam folder of: ${to}`);
  } catch (error) {
    console.error('FAILED:', error.message);
    if (emailProvider === 'brevo') {
      console.error('\nTroubleshooting checklist (Brevo):');
      console.error(' 1. Tama ba ang BREVO_API_KEY?');
      console.error(' 2. Verified ba ang MAIL_FROM (sender email) sa Brevo dashboard?');
      console.error(' 3. Naubos na ba ang daily sending limit ng free plan (300/day)?');
    } else {
      console.error('\nTroubleshooting checklist (Gmail SMTP):');
      console.error(' 1. Siguraduhing NAKA-ON ang 2-Step Verification sa Google Account.');
      console.error(' 2. Siguraduhing tama ang 16-character App Password (walang spaces).');
      console.error(' 3. I-check kung may internet connection at kung hindi blocked ang SMTP port.');
    }
  }
})();
