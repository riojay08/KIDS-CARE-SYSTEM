// ============================================================
// KidsCare db.js  (complete file, save to the project root)
// ============================================================
require('dotenv').config();
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || __dirname;   // set DATA_DIR to a persistent disk when deploying
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'kidscare.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL CHECK (role IN ('parent','admin')),
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT
  );
  CREATE TABLE IF NOT EXISTS children (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    address TEXT,
    age INTEGER,
    dob TEXT,
    phone TEXT,
    allergies TEXT DEFAULT '[]',
    status TEXT DEFAULT 'home',
    qr_token TEXT UNIQUE NOT NULL
  );
  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    child_id INTEGER REFERENCES children(id),
    file TEXT NOT NULL,
    caption TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    child_id INTEGER NOT NULL REFERENCES children(id),
    sender_id INTEGER NOT NULL REFERENCES users(id),
    text TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    child_id INTEGER NOT NULL REFERENCES children(id),
    type TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// Create the first admin if it does not exist yet
const adminEmail = (process.env.ADMIN_EMAIL || 'admin@school.com').toLowerCase();
if (!db.prepare('SELECT 1 FROM users WHERE email = ?').get(adminEmail)) {
  db.prepare('INSERT INTO users (role, name, email, password_hash) VALUES (?, ?, ?, ?)')
    .run('admin', 'Teacher Admin', adminEmail, bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'change-me-now', 10));
}

// ---------- Migrations (safe to run many times) ----------
function addCol(table, col, def) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col))
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addCol('children', 'classroom', "TEXT DEFAULT ''");
addCol('children', 'medical_notes', "TEXT DEFAULT ''");
addCol('children', 'emergency_name', "TEXT DEFAULT ''");
addCol('children', 'emergency_phone', "TEXT DEFAULT ''");
addCol('children', 'student_code', 'TEXT');
addCol('scans', 'email_status', "TEXT DEFAULT 'pending'");
addCol('scans', 'sms_status', "TEXT DEFAULT 'pending'");

db.exec(`
  CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL DEFAULT 'activity',          -- 'activity' | 'announcement'
    title TEXT NOT NULL,
    body TEXT DEFAULT '',
    target_type TEXT NOT NULL DEFAULT 'all',        -- 'all' | 'classroom' | 'child'
    target_value TEXT,                              -- classroom name or child id
    notify INTEGER DEFAULT 0,                       -- 1 = email parents
    recipients INTEGER DEFAULT 0,
    emails_sent INTEGER DEFAULT 0,
    emails_failed INTEGER DEFAULT 0,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS activity_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
    file TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat_messages (        -- one thread per parent, staff reply
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER NOT NULL REFERENCES users(id),
    sender_id INTEGER NOT NULL REFERENCES users(id),
    text TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS email_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    to_email TEXT, subject TEXT, kind TEXT,         -- 'scan' | 'activity'
    status TEXT, error TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS activity_hidden (       -- a parent removed an update from their own feed
    activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
    parent_id INTEGER NOT NULL REFERENCES users(id),
    PRIMARY KEY (activity_id, parent_id)
  );
  CREATE INDEX IF NOT EXISTS idx_chat_parent ON chat_messages(parent_id);
  CREATE INDEX IF NOT EXISTS idx_children_class ON children(classroom);
`);

addCol('email_log', 'channel', "TEXT DEFAULT 'email'");   // email_log also records SMS
db.exec(`
  CREATE TABLE IF NOT EXISTS monthly_reports (       -- one automatic report per month
    month TEXT PRIMARY KEY,                         -- e.g. 2026-10
    json TEXT NOT NULL,
    notified INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS outbox (               -- email notifications that failed and will be retried
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,                          -- 'email' (SMS is no longer used)
    to_addr TEXT NOT NULL, subject TEXT, body TEXT, html TEXT,
    attempts INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending',                  -- 'pending' | 'sent' | 'failed' | 'skipped'
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// SMS notifications were removed. Retire any queued SMS rows so they never retry.
db.prepare("UPDATE outbox SET status = 'skipped' WHERE channel = 'sms' AND status = 'pending'").run();

// Student ID for old and new rows, e.g. KC-2026-0007
db.prepare(`UPDATE children SET student_code = 'KC-' || strftime('%Y','now') || '-' || printf('%04d', id)
            WHERE student_code IS NULL OR student_code = ''`).run();

module.exports = db;
