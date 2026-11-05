// test-email.js
require('dotenv').config();
const nodemailer = require('nodemailer');

// Siguraduhing may laman ang mga kinakailangang env variables
if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
  console.error('❌ ERROR: Nawawala ang GMAIL_USER o GMAIL_APP_PASSWORD sa iyong .env file!');
  process.exit(1);
}

const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

(async () => {
  try {
    console.log('🔄 Sinusuri ang Gmail login credentials...');
    await mailer.verify();
    console.log('✅ OK: Tama ang Gmail login!');

    // Kunin ang email address mula sa command line argument o gamitin ang sender email bilang default
    const to = process.argv[2] || process.env.GMAIL_USER;

    console.log(`✉️  Nagsusumite ng test email sa: ${to}...`);
    const info = await mailer.sendMail({
      from: `"KidsCare Notification" <${process.env.GMAIL_USER}>`,
      to: to,
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

    console.log(`✅ EMAIL SENT SUCCESSFUL! Message ID: ${info.messageId}`);
    console.log(`📬 I-check ang Inbox at Spam folder ni: ${to}`);
  } catch (error) {
    console.error('❌ FAILED:', error.message);
    console.error('\n🔍 Troubleshooting Checklist:');
    console.error(' 1. Siguraduhing NAKA-ON ang 2-Step Verification sa Google Account.');
    console.error(' 2. Siguraduhing tama ang 16-character App Password (walang spaces).');
    console.error(' 3. I-check kung may internet connection.');
  }
})();
