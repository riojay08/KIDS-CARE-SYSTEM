// test-email.js
require('dotenv').config();
const nodemailer = require('nodemailer');

// Make sure the required environment variables are set
if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
  console.error('❌ ERROR: GMAIL_USER or GMAIL_APP_PASSWORD is missing from your .env file!');
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
    console.log('🔄 Checking Gmail login credentials...');
    await mailer.verify();
    console.log('✅ OK: Gmail login is correct!');

    // Get the email address from the command line argument or use the sender email as default
    const to = process.argv[2] || process.env.GMAIL_USER;

    console.log(`✉️  Sending test email to: ${to}...`);
    const info = await mailer.sendMail({
      from: `"KidsCare Notification" <${process.env.GMAIL_USER}>`,
      to: to,
      subject: 'KidsCare Test Notification',
      text: 'Good day! If you can read this, the KidsCare notification system is working properly.',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
          <h2 style="color: #4CAF50;">KidsCare Notification Test</h2>
          <p>Good day!</p>
          <p>If you can read this, the KidsCare <strong>notification system is working properly</strong>.</p>
          <hr/>
          <small style="color: #777;">System generated test email.</small>
        </div>
      `,
    });

    console.log(`✅ EMAIL SENT SUCCESSFUL! Message ID: ${info.messageId}`);
    console.log(`📬 Check the Inbox and Spam folder of: ${to}`);
  } catch (error) {
    console.error('❌ FAILED:', error.message);
    console.error('\n🔍 Troubleshooting Checklist:');
    console.error(' 1. Make sure 2-Step Verification is enabled on the Google Account.');
    console.error(' 2. Make sure the 16-character App Password is correct (no spaces).');
    console.error(' 3. Check the internet connection.');
  }
})();
