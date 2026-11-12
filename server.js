// ============================================================
// KidsCare server.js  (complete file, save to the project root)
// ============================================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { sendMail, emailProvider } = require('./utils/mailer');
const db = require('./db');

const UPLOAD_DIR = path.join(process.env.DATA_DIR || __dirname, 'uploads');   // same disk as the database

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.get('/healthz', (req, res) => res.send('ok'));   // used by hosting health checks
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

// ---------- Helpers ----------
const signToken = u =>
  jwt.sign({ id: u.id, role: u.role, name: u.name }, process.env.JWT_SECRET, { expiresIn: '7d' });

// Middleware: checks that the user is logged in (and has the right role)
function auth(roles) {
  return (req, res, next) => {
    try {
      const token = (req.headers.authorization || '').replace('Bearer ', '');
      req.user = jwt.verify(token, process.env.JWT_SECRET);
      // Deleted accounts can no longer use an old token
      if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(req.user.id)) return res.status(401).json({ error: 'Account not found' });
      if (roles && !roles.includes(req.user.role)) return res.status(403).json({ error: 'Not allowed' });
      next();
    } catch {
      res.status(401).json({ error: 'Please log in first' });
    }
  };
}

// Admin: all children. Parent: own children only.
function canAccessChild(user, childId) {
  if (user.role === 'admin') return true;
  return !!db.prepare('SELECT 1 FROM children WHERE id = ? AND parent_id = ?').get(childId, user.id);
}

const toChild = c => ({ ...c, allergies: JSON.parse(c.allergies || '[]') });

// Email goes through utils/mailer.js: Brevo HTTPS API when BREVO_API_KEY is set,
// otherwise Gmail SMTP (local dev). This avoids Render's blocked SMTP ports.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Simple branded HTML wrapper for all emails
const mailHtml = (title, bodyHtml) => `
<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
  <div style="background:#0891b2;color:#fff;padding:14px 18px;font-weight:bold">KidsCare</div>
  <div style="padding:18px"><h2 style="margin:0 0 10px;font-size:18px">${title}</h2>${bodyHtml}</div>
  <div style="padding:10px 18px;font-size:12px;color:#64748b">Automated message from KidsCare. Please do not reply to this email.</div>
</div>`;

// Email: on failure the message goes to the outbox and is retried automatically
async function sendEmail(to, subject, text, kind = 'general', html) {
  let status = 'sent', error = null;
  try {
    await sendMail({ to, subject, text, html });
  } catch (e) {
    status = 'queued';
    error = e.message;
    console.error('Email queued for retry:', e.message);
    db.prepare('INSERT INTO outbox (channel, to_addr, subject, body, html) VALUES (?, ?, ?, ?, ?)').run('email', to, subject, text, html || null);
  }
  db.prepare('INSERT INTO email_log (to_email, subject, kind, status, error, channel) VALUES (?, ?, ?, ?, ?, ?)').run(to, subject, kind, status, error, 'email');
  return status;
}

// SMS notifications were removed. Parents are notified by email only.
// Any old queued SMS rows are retired by db.js on startup.

// Retry failed email notifications every 2 minutes, up to 5 attempts each
async function retryOutbox() {
  const rows = db.prepare("SELECT * FROM outbox WHERE channel = 'email' AND status = 'pending' AND attempts < 5 ORDER BY id LIMIT 20").all();
  for (const r of rows) {
    try {
      await sendMail({ to: r.to_addr, subject: r.subject, text: r.body, html: r.html || undefined });
      db.prepare("UPDATE outbox SET status = 'sent' WHERE id = ?").run(r.id);
    } catch (e) {
      db.prepare("UPDATE outbox SET attempts = attempts + 1, status = CASE WHEN attempts + 1 >= 5 THEN 'failed' ELSE 'pending' END WHERE id = ?").run(r.id);
    }
  }
}
setInterval(retryOutbox, 2 * 60 * 1000);

// ---------- Sign-up at login ----------
app.post('/api/signup', (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !email.includes('@') || !password || password.length < 6)
    return res.status(400).json({ error: 'Complete the name, email, and password (min 6)' });
  const em = email.trim().toLowerCase();
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(em))
    return res.status(409).json({ error: 'That email is already registered' });
  const info = db.prepare('INSERT INTO users (role, name, email, password_hash) VALUES (?, ?, ?, ?)')
    .run('parent', name.trim(), em, bcrypt.hashSync(password, 10));
  const user = { id: info.lastInsertRowid, role: 'parent', name: name.trim() };
  res.json({ token: signToken(user), user });
});

app.post('/api/login', (req, res) => {
  const { email, password, role } = req.body;
  const u = db.prepare('SELECT * FROM users WHERE email = ? AND role = ?')
    .get(String(email || '').trim().toLowerCase(), role);
  if (!u || !u.password_hash || !bcrypt.compareSync(String(password || ''), u.password_hash))
    return res.status(401).json({ error: 'Incorrect email, password, or role' });
  res.json({ token: signToken(u), user: { id: u.id, role: u.role, name: u.name } });
});

// ---------- Children and QR scan ----------
app.get('/api/children', auth(), (req, res) => {
  const rows = req.user.role === 'admin'
    ? db.prepare('SELECT c.*, u.name AS parent_name, u.email AS parent_email FROM children c JOIN users u ON u.id = c.parent_id ORDER BY c.name').all()
    : db.prepare('SELECT * FROM children WHERE parent_id = ?').all(req.user.id);
  res.json(rows.map(toChild));
});

app.post('/api/children', auth(['parent']), (req, res) => {
  const { name, address, age, dob, gender, phone, allergies, classroom, medical_notes, emergency_name, emergency_phone } = req.body;
  if (!name || !address || !dob || !phone)
    return res.status(400).json({ error: 'Complete the form' });
  const token = crypto.randomBytes(16).toString('hex');
  const info = db.prepare(`INSERT INTO children
      (parent_id, name, address, age, dob, gender, phone, allergies, qr_token, classroom, medical_notes, emergency_name, emergency_phone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.user.id, name.trim(), address.trim(), Number(age) || 0, dob, String(gender || '').trim(), phone.trim(), JSON.stringify(allergies || []), token,
      '', String(medical_notes || '').trim(), '', '');
  db.prepare('UPDATE children SET student_code = ? WHERE id = ?')
    .run(`KC-${new Date().getFullYear()}-${String(info.lastInsertRowid).padStart(4, '0')}`, info.lastInsertRowid);
  res.json(toChild(db.prepare('SELECT * FROM children WHERE id = ?').get(info.lastInsertRowid)));
});

app.post('/api/scan', auth(['admin']), async (req, res) => {
  const token = String(req.body.token || '').replace('KIDSCARE:', '');
  const child = db.prepare('SELECT c.*, u.name AS parent_name, u.email AS parent_email FROM children c JOIN users u ON u.id = c.parent_id WHERE c.qr_token = ?').get(token);
  if (!child) return res.status(404).json({ error: 'Unknown QR code' });

  const mode = req.body.mode === 'departure' ? 'departure' : 'arrival';   // arrival = Time In, departure = Time Out
  const timeIn = mode === 'arrival';
  // Scans made offline keep their original time (max 7 days old, never in the future)
  let when = new Date(req.body.scannedAt);
  if (isNaN(when) || when > Date.now() || Date.now() - when > 7 * 864e5) when = new Date();
  const stamp = when.toISOString().slice(0, 19).replace('T', ' ');
  const status = timeIn ? 'at_school' : 'home';

  db.prepare('UPDATE children SET status = ? WHERE id = ?').run(status, child.id);
  const scan = db.prepare('INSERT INTO scans (child_id, type, created_at, email_status) VALUES (?, ?, ?, ?)').run(child.id, mode, stamp, 'pending');

  const time = when.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Manila' });
  const what = timeIn ? 'timed in at school' : 'timed out and is heading home';
  const subject = timeIn ? `${child.name} timed in at school` : `${child.name} timed out of school`;
  const body = `Hi ${child.parent_name}, ${child.name} has ${what} at ${time}.`;
  const html = mailHtml(esc(subject), `<p>${esc(body)}</p><p style="color:#64748b;font-size:13px">Student ID: ${esc(child.student_code)}</p>`);

  // Notify the parent by email only
  const emailStatus = await sendEmail(child.parent_email, subject, body, 'scan', html);
  db.prepare('UPDATE scans SET email_status = ? WHERE id = ?').run(emailStatus, scan.lastInsertRowid);

  io.to(`parent:${child.parent_id}`).to('staff').emit('status', { childId: child.id, status });
  res.json({ child: child.name, status, mode, emailedTo: child.parent_email, emailStatus, subject, body });
});

app.get('/api/scans', auth(['admin']), (req, res) => {
  res.json(db.prepare(`SELECT s.id, s.type, s.email_status, s.created_at, c.name, u.email AS parent_email
    FROM scans s JOIN children c ON c.id = s.child_id JOIN users u ON u.id = c.parent_id
    ORDER BY s.id DESC LIMIT 8`).all());
});

app.get('/api/parents', auth(['admin']), (req, res) => {
  res.json(db.prepare("SELECT id, name, email FROM users WHERE role = 'parent' ORDER BY name").all());
});

// ---------- Activities & Announcements (photos + optional email blast) ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + path.extname(file.originalname).toLowerCase())
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype))
});

// Which students does a post target?
function targetChildren(type, value) {
  if (type === 'child') return db.prepare('SELECT * FROM children WHERE id = ?').all(value);
  if (type === 'classroom') return db.prepare('SELECT * FROM children WHERE classroom = ?').all(value);
  return db.prepare('SELECT * FROM children').all();
}

// Runs in the background so the admin does not wait; progress is stored on the activity row.
async function emailParents(activityId, a, parentIds) {
  const parents = db.prepare(`SELECT u.name, u.email
    FROM users u WHERE u.id IN (${parentIds.map(() => '?').join(',')})`).all(...parentIds);
  const link = process.env.PUBLIC_URL ? `<p><a href="${esc(process.env.PUBLIC_URL)}">Open KidsCare</a></p>` : '';
  for (const p of parents) {
    const subject = `${a.kind === 'announcement' ? 'Announcement' : 'Activity'}: ${a.title}`;
    const msg = a.message || 'There is a new update from school.';
    const text = `Hi ${p.name},\n\n${msg}\n\nOpen KidsCare to see the photos and details.`;
    const html = mailHtml(esc(a.title), `<p>Hi ${esc(p.name)},</p><p>${esc(msg).replace(/\n/g, '<br>')}</p>${link}`);
    const st = await sendEmail(p.email, subject, text, 'activity', html);
    db.prepare(`UPDATE activities SET ${st === 'sent' ? 'emails_sent = emails_sent + 1' : 'emails_failed = emails_failed + 1'} WHERE id = ?`).run(activityId);
  }
}

app.post('/api/activities', auth(['admin']), upload.array('photos', 5), (req, res) => {
  const kind = req.body.kind === 'announcement' ? 'announcement' : 'activity';
  const title = String(req.body.title || '').trim().slice(0, 120);
  const message = String(req.body.message || '').trim().slice(0, 2000);
  const type = ['all', 'child'].includes(req.body.targetType) ? req.body.targetType : 'all';
  const value = type === 'all' ? null : String(req.body.targetValue || '');
  if (!title) return res.status(400).json({ error: 'Title is required' });

  const children = targetChildren(type, value);
  if (!children.length) return res.status(400).json({ error: 'No students in the selected audience' });
  const parentIds = [...new Set(children.map(c => c.parent_id))];
  const notify = req.body.notify === '1';

  const info = db.prepare('INSERT INTO activities (kind, title, body, target_type, target_value, notify, recipients, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(kind, title, message, type, value, notify ? 1 : 0, notify ? parentIds.length : 0, req.user.id);
  for (const f of req.files || []) db.prepare('INSERT INTO activity_photos (activity_id, file) VALUES (?, ?)').run(info.lastInsertRowid, f.filename);

  parentIds.forEach(pid => io.to(`parent:${pid}`).emit('activity', { id: info.lastInsertRowid }));
  if (notify) emailParents(info.lastInsertRowid, { kind, title, message }, parentIds);
  res.json({ id: info.lastInsertRowid, recipients: parentIds.length, emailing: notify });
});

app.get('/api/activities', auth(['admin']), (req, res) => {
  res.json(db.prepare(`SELECT a.*, (SELECT COUNT(*) FROM activity_photos p WHERE p.activity_id = a.id) AS photos
    FROM activities a ORDER BY a.id DESC LIMIT 15`).all());
});

// Parent feed: only posts that target this parent's children
app.get('/api/feed', auth(['parent']), (req, res) => {
  const me = req.user.id;
  const rows = db.prepare(`SELECT a.* FROM activities a
    WHERE a.id NOT IN (SELECT activity_id FROM activity_hidden WHERE parent_id = ?)
      AND ((a.target_type = 'all' AND EXISTS (SELECT 1 FROM children WHERE parent_id = ?))
        OR (a.target_type = 'classroom' AND a.target_value IN (SELECT classroom FROM children WHERE parent_id = ?))
        OR (a.target_type = 'child' AND a.target_value IN (SELECT CAST(id AS TEXT) FROM children WHERE parent_id = ?)))
    ORDER BY a.id DESC LIMIT 50`).all(me, me, me, me);
  const ph = db.prepare('SELECT file FROM activity_photos WHERE activity_id = ?');
  res.json(rows.map(a => ({ id: a.id, kind: a.kind, title: a.title, body: a.body, created_at: a.created_at, photos: ph.all(a.id).map(p => '/uploads/' + p.file) })));
});

// ---------- Parent <-> Teacher/Admin chat (one thread per parent) ----------
const CHAT_SQL = `SELECT m.id, m.parent_id, m.text, m.created_at, u.name AS sender_name, u.role AS sender_role
  FROM chat_messages m JOIN users u ON u.id = m.sender_id`;
const getThread = pid => db.prepare(CHAT_SQL + ' WHERE m.parent_id = ? ORDER BY m.id').all(pid);

function postChat(req, res, pid) {
  const text = String(req.body.text || '').trim().slice(0, 1000);
  if (!text) return res.status(400).json({ error: 'Message cannot be empty' });
  if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'parent'").get(pid)) return res.status(404).json({ error: 'Parent not found' });
  const info = db.prepare('INSERT INTO chat_messages (parent_id, sender_id, text) VALUES (?, ?, ?)').run(pid, req.user.id, text);
  const msg = db.prepare(CHAT_SQL + ' WHERE m.id = ?').get(info.lastInsertRowid);
  io.to(`parent:${pid}`).to('staff').emit('message', msg);   // parent room + all staff
  res.json(msg);
}
// Parents can only reach their own thread; only admins can open any thread.
app.get('/api/chat', auth(['parent']), (req, res) => res.json(getThread(req.user.id)));
app.post('/api/chat', auth(['parent']), (req, res) => postChat(req, res, req.user.id));
app.get('/api/chat/:pid', auth(['admin']), (req, res) => res.json(getThread(Number(req.params.pid))));
app.post('/api/chat/:pid', auth(['admin']), (req, res) => postChat(req, res, Number(req.params.pid)));

// ---------- Monthly attendance report (daycare) ----------
const SCHOOL_START = process.env.SCHOOL_START || '08:30';   // Time In after this = late arrival
const SCHOOL_END = process.env.SCHOOL_END || '16:00';       // Time Out before this = early pickup
const CLOSING = process.env.CLOSING_TIME || '17:00';        // Time Out after this = late pickup
const FREQUENT = 3;                                         // 3 or more days = "frequent"
const manila = d => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
};
const validMonth = m => /^\d{4}-\d{2}$/.test(m || '') ? m : manila(new Date()).date.slice(0, 7);
const minutes = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const getSetting = key => (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) || {}).value || '';
const setSetting = (key, value) => {
  if (value == null || value === '') db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
};
// Class schedule: which weekdays are school days, and the time rules. Values fall back to the .env defaults.
function getSchedule() {
  let days = [1, 2, 3, 4, 5];   // Mon-Fri
  const raw = getSetting('class_days');
  if (raw) {
    try {
      const a = JSON.parse(raw);
      if (Array.isArray(a) && a.length) days = [...new Set(a.map(Number).filter(n => n >= 0 && n <= 6))];
    } catch {}
  }
  return {
    days,
    start: getSetting('school_start') || SCHOOL_START,
    end: getSetting('school_end') || SCHOOL_END,
    closing: getSetting('closing_time') || CLOSING
  };
}
const reportSettings = () => {
  const s = getSchedule();
  return { startDate: getSetting('daycare_start'), classDays: s.days, schoolStart: s.start, schoolEnd: s.end, closingTime: s.closing };
};

function buildReport(month, withPrev = true) {
  const today = manila(new Date()).date;
  const startDate = getSetting('daycare_start');
  const schedule = getSchedule();
  const [Y, M] = month.split('-').map(Number);

  // School days = selected class weekdays of that month, up to today (and on/after the daycare start date)
  const days = [];
  for (let d = 1; d <= new Date(Date.UTC(Y, M, 0)).getUTCDate(); d++) {
    const iso = `${month}-${String(d).padStart(2, '0')}`;
    const wd = new Date(Date.UTC(Y, M - 1, d)).getUTCDay();
    if (schedule.days.includes(wd) && iso <= today && (!startDate || iso >= startDate)) days.push(iso);
  }

  const kids = db.prepare('SELECT id, parent_id, name, student_code FROM children ORDER BY name').all();
  const scans = db.prepare(`SELECT child_id, type, created_at FROM scans
    WHERE created_at >= datetime(?, '-1 day') AND created_at < datetime(?, '+1 month', '+1 day') ORDER BY id`).all(`${month}-01 00:00:00`, `${month}-01 00:00:00`);
  // Each child's attendance starts on their first Time In scan, so earlier school days are not counted as absences.
  const firstScan = db.prepare(`SELECT child_id,
      MIN(CASE WHEN type = 'arrival' THEN created_at END) AS first_in,
      MIN(created_at) AS first_any
    FROM scans GROUP BY child_id`).all();
  const firstDate = Object.fromEntries(firstScan.map(s =>
    [s.child_id, manila(new Date((s.first_in || s.first_any).replace(' ', 'T') + 'Z')).date]));

  const per = {};   // child -> date -> { in: earliest Time In, out: latest Time Out }
  for (const s of scans) {
    const m = manila(new Date(s.created_at.replace(' ', 'T') + 'Z'));
    if (!days.includes(m.date)) continue;
    const e = ((per[s.child_id] ||= {})[m.date] ||= {});
    if (s.type === 'arrival') { if (!e.in || m.time < e.in) e.in = m.time; }
    else if (!e.out || m.time > e.out) e.out = m.time;
  }

  const children = kids.map(k => {
    const byDay = per[k.id] || {};
    const childDays = firstDate[k.id] ? days.filter(day => day >= firstDate[k.id]) : [];
    const d = childDays.map(day => byDay[day]).filter(Boolean);
    let run = 0, longest = 0;
    for (const day of childDays) { if (byDay[day]) run = 0; else longest = Math.max(longest, ++run); }
    const stays = d.filter(e => e.in && e.out && e.out > e.in).map(e => (minutes(e.out) - minutes(e.in)) / 60);
    return {
      id: k.id, parentId: k.parent_id, name: k.name, code: k.student_code,
      schoolDays: childDays.length,
      present: d.length,
      absent: Math.max(childDays.length - d.length, 0),
      maxAbsentStreak: longest,
      late: d.filter(e => e.in && e.in > schedule.start).length,
      early: d.filter(e => e.out && e.out < schedule.end).length,
      latePickup: d.filter(e => e.out && e.out > schedule.closing).length,
      missingOut: childDays.filter(day => byDay[day] && byDay[day].in && !byDay[day].out && day < today).length,
      avgStay: stays.length ? Math.round(stays.reduce((a, b) => a + b, 0) / stays.length * 10) / 10 : null,
      rate: childDays.length ? Math.round(d.length / childDays.length * 100) : 0
    };
  });
  const sum = f => children.reduce((a, c) => a + f(c), 0);
  const report = {
    month, startDate, schoolDays: days.length, rules: { start: schedule.start, end: schedule.end, closing: schedule.closing, frequent: FREQUENT, days: schedule.days },
    schedule: { days: schedule.days, start: schedule.start, end: schedule.end, closing: schedule.closing },
    summary: {
      students: kids.length,
      avgRate: (() => { const active = children.filter(c => c.schoolDays); return active.length ? Math.round(active.reduce((a, c) => a + c.rate, 0) / active.length) : 0; })(),
      prevAvgRate: null,
      perfect: children.filter(c => c.schoolDays && c.present === c.schoolDays).length,
      timeIns: sum(c => c.present), lates: sum(c => c.late), early: sum(c => c.early),
      latePickups: sum(c => c.latePickup), absences: sum(c => c.absent)
    },
    perfect: children.filter(c => c.schoolDays && c.present === c.schoolDays),                       // always present
    lates: children.filter(c => c.late >= FREQUENT).sort((a, b) => b.late - a.late),
    early: children.filter(c => c.early >= FREQUENT).sort((a, b) => b.early - a.early),
    absent: children.filter(c => c.absent >= FREQUENT).sort((a, b) => b.absent - a.absent),        // needs follow-up
    latePickups: children.filter(c => c.latePickup >= 2).sort((a, b) => b.latePickup - a.latePickup),
    missingOut: children.filter(c => c.missingOut > 0),
    children,
    daily: days.map(date => ({ date, present: kids.filter(k => per[k.id] && per[k.id][date]).length }))
  };
  if (withPrev) {   // compare with the month before
    const prev = buildReport(new Date(Date.UTC(Y, M - 2, 1)).toISOString().slice(0, 7), false);
    if (prev.summary.timeIns > 0) report.summary.prevAvgRate = prev.summary.avgRate;
  }
  return report;
}

app.get('/api/report', auth(['admin']), (req, res) => res.json(buildReport(validMonth(req.query.month))));
app.get('/api/reports', auth(['admin']), (req, res) =>
  res.json(db.prepare('SELECT month, notified, created_at FROM monthly_reports ORDER BY month DESC LIMIT 12').all()));
// Daycare start date, class days, and class time rules used by the reports.
app.get('/api/report/settings', auth(['admin']), (req, res) => res.json(reportSettings()));
app.post('/api/report/settings', auth(['admin']), (req, res) => {
  const b = req.body || {};
  const bad = msg => res.status(400).json({ error: msg });
  const isTime = t => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t));

  if ('startDate' in b) {
    const startDate = String(b.startDate || '').trim();
    if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return bad('Invalid start date');
    setSetting('daycare_start', startDate);
  }
  if ('classDays' in b) {
    const days = [...new Set((Array.isArray(b.classDays) ? b.classDays : []).map(Number).filter(n => n >= 0 && n <= 6))];
    if (!days.length) return bad('Choose at least one class day');
    setSetting('class_days', JSON.stringify(days.sort()));
  }
  if ('schoolStart' in b) {
    if (!isTime(b.schoolStart)) return bad('Invalid class start time');
    setSetting('school_start', b.schoolStart);
  }
  if ('schoolEnd' in b) {
    if (!isTime(b.schoolEnd)) return bad('Invalid class end time');
    setSetting('school_end', b.schoolEnd);
  }
  if ('closingTime' in b) {
    if (!isTime(b.closingTime)) return bad('Invalid closing time');
    setSetting('closing_time', b.closingTime);
  }
  res.json({ ok: true, ...reportSettings() });
});
// Parents only see their own children
app.get('/api/attendance', auth(['parent']), (req, res) => {
  const r = buildReport(validMonth(req.query.month), false);
  res.json({ month: r.month, schoolDays: r.schoolDays, rules: r.rules, children: r.children.filter(c => c.parentId === req.user.id) });
});

// ---------- Automatic monthly report ----------
const monthLabel = m => { const [Y, M] = m.split('-').map(Number); return new Date(Date.UTC(Y, M - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }); };
const prevMonth = () => { const [Y, M] = manila(new Date()).date.slice(0, 7).split('-').map(Number); return new Date(Date.UTC(Y, M - 2, 1)).toISOString().slice(0, 7); };

// Emails the report to every admin and (unless PARENT_MONTHLY_SUMMARY=off) a short summary to each parent
async function notifyMonthly(month, r) {
  const label = monthLabel(month), names = a => a.map(c => c.name).join(', ') || 'none';
  const subject = `Monthly attendance report: ${label}`;
  const text = `KidsCare monthly attendance report for ${label}\n\nSchool days: ${r.schoolDays}\nAverage attendance: ${r.summary.avgRate}%\n\nAlways present: ${names(r.perfect)}\nFrequent lates: ${names(r.lates)}\nFrequent early pickups: ${names(r.early)}\nNeeds follow-up (absences): ${names(r.absent)}\nLate pickups: ${names(r.latePickups)}\nMissing Time Out scan: ${names(r.missingOut)}\n\nOpen KidsCare > Reports for the full report and the PDF.`;
  for (const a of db.prepare("SELECT email FROM users WHERE role = 'admin'").all())
    await sendEmail(a.email, subject, text, 'report', mailHtml(esc(subject), `<p>${esc(text).replace(/\n/g, '<br>')}</p>`));

  if ((process.env.PARENT_MONTHLY_SUMMARY || 'on') === 'off') return;
  const byParent = {};
  r.children.forEach(c => (byParent[c.parentId] ||= []).push(c));
  for (const [pid, kids] of Object.entries(byParent)) {
    const p = db.prepare('SELECT name, email FROM users WHERE id = ?').get(pid);
    if (!p) continue;
    const lines = kids.map(c => {
      const parts = [`attended ${c.present} of ${c.schoolDays} school days (${c.rate}%)`];
      if (c.schoolDays && c.present === c.schoolDays) parts.push('perfect attendance, well done');
      if (c.late) parts.push(`${c.late} late arrival(s)`);
      if (c.early) parts.push(`${c.early} early pickup(s)`);
      if (c.avgStay) parts.push(`stayed about ${c.avgStay} hours a day`);
      return `${c.name}: ${parts.join('; ')}.`;
    });
    const body = `Hi ${p.name},\n\nHere is your child's attendance for ${label}:\n\n${lines.join('\n')}\n\nThank you for being part of our daycare family.`;
    await sendEmail(p.email, `Attendance summary for ${label}`, body, 'report', mailHtml(esc(`Attendance summary: ${label}`), `<p>${esc(body).replace(/\n/g, '<br>')}</p>`));
  }
}

// Saves the report once per month and notifies. force = admin pressed "Send now".
async function runMonthly(month, force = false) {
  const r = buildReport(month);
  const ins = db.prepare('INSERT OR IGNORE INTO monthly_reports (month, json) VALUES (?, ?)').run(month, JSON.stringify(r));
  if (!ins.changes && !force) return false;                       // already done for that month
  if (!ins.changes) db.prepare('UPDATE monthly_reports SET json = ?, created_at = CURRENT_TIMESTAMP WHERE month = ?').run(JSON.stringify(r), month);
  if (!force && r.summary.timeIns === 0) return false;           // nothing happened that month: no emails
  await notifyMonthly(month, r);
  db.prepare('UPDATE monthly_reports SET notified = 1 WHERE month = ?').run(month);
  return true;
}
app.post('/api/report/run', auth(['admin']), (req, res) => {
  runMonthly(validMonth(req.body.month), true).catch(e => console.error('Monthly report failed:', e.message));
  res.json({ ok: true });
});
// After 6:00 AM (Manila) on any day, make sure last month's report exists. Checked hourly and at start-up.
function checkMonthly() {
  if (process.env.MONTHLY_AUTO === 'off' || manila(new Date()).time < '06:00') return;
  runMonthly(prevMonth()).catch(e => console.error('Monthly report failed:', e.message));
}
setTimeout(checkMonthly, 15000);
setInterval(checkMonthly, 60 * 60 * 1000);

// ---------- Delete actions ----------
const rmFiles = files => files.forEach(f => fs.unlink(path.join(UPLOAD_DIR, f), () => {}));

// Removes a student and everything attached to them (the old photos/messages tables are cleaned too)
const deleteChild = db.transaction(id => {
  db.prepare('DELETE FROM scans WHERE child_id = ?').run(id);
  db.prepare('DELETE FROM messages WHERE child_id = ?').run(id);
  db.prepare('DELETE FROM photos WHERE child_id = ?').run(id);
  db.prepare('DELETE FROM children WHERE id = ?').run(id);
});

// Removes a parent, their children, chat thread and hidden-update records
const deleteParent = db.transaction(pid => {
  db.prepare('SELECT id FROM children WHERE parent_id = ?').all(pid).forEach(c => deleteChild(c.id));
  db.prepare('DELETE FROM chat_messages WHERE parent_id = ? OR sender_id = ?').run(pid, pid);
  db.prepare('DELETE FROM activity_hidden WHERE parent_id = ?').run(pid);
  db.prepare('DELETE FROM messages WHERE sender_id = ?').run(pid);
  db.prepare('DELETE FROM users WHERE id = ?').run(pid);
});

// Admin deletes a check-in. The student's status is recalculated from the remaining scans.
app.delete('/api/scans/:id', auth(['admin']), (req, res) => {
  const s = db.prepare('SELECT * FROM scans WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM scans WHERE id = ?').run(s.id);
  const last = db.prepare('SELECT type FROM scans WHERE child_id = ? ORDER BY id DESC LIMIT 1').get(s.child_id);
  db.prepare('UPDATE children SET status = ? WHERE id = ?').run(last && last.type === 'arrival' ? 'at_school' : 'home', s.child_id);
  io.emit('children-changed');
  res.json({ ok: true });
});

// Admin deletes a post for everyone (photos included)
app.delete('/api/activities/:id', auth(['admin']), (req, res) => {
  const files = db.prepare('SELECT file FROM activity_photos WHERE activity_id = ?').all(req.params.id).map(r => r.file);
  const info = db.prepare('DELETE FROM activities WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Not found' });
  rmFiles(files);
  io.emit('feed-changed');
  res.json({ ok: true });
});

// A parent hides an update from their own feed (other parents still see it)
app.delete('/api/feed/:id', auth(['parent']), (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM activities WHERE id = ?').get(id)) return res.status(404).json({ error: 'Not found' });
  db.prepare('INSERT OR IGNORE INTO activity_hidden (activity_id, parent_id) VALUES (?, ?)').run(id, req.user.id);
  res.json({ ok: true });
});

// Admin can delete any student. A parent can delete only their own child.
app.delete('/api/children/:id', auth(['admin', 'parent']), (req, res) => {
  const c = db.prepare('SELECT * FROM children WHERE id = ?').get(req.params.id);
  if (!c || (req.user.role === 'parent' && c.parent_id !== req.user.id)) return res.status(404).json({ error: 'Not found' });
  deleteChild(c.id);
  io.emit('children-changed');
  res.json({ ok: true });
});

app.delete('/api/parents/:id', auth(['admin']), (req, res) => {
  const p = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'parent'").get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  deleteParent(p.id);
  io.emit('children-changed');
  res.json({ ok: true });
});

// ---------- Sockets ----------
io.use((socket, next) => {
  try {
    socket.user = jwt.verify(socket.handshake.auth.token, process.env.JWT_SECRET);
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});
const online = new Map();       // parent id -> number of open connections (for the Inbox online dot)
const staffOnline = new Map();  // admin/teacher id -> { name, sockets } (for the parent "teacher online" dot)
const staffSummary = () => ({
  online: staffOnline.size > 0,
  count: staffOnline.size,
  names: [...staffOnline.values()].map(s => s.name)
});

io.on('connection', socket => {
  const u = socket.user;
  if (u.role === 'admin') {
    socket.join('staff');
    socket.emit('presence:list', [...online.keys()]);

    // Track staff so parents can see that a teacher/admin is online
    const entry = staffOnline.get(u.id) || { name: u.name, sockets: 0 };
    entry.sockets += 1;
    staffOnline.set(u.id, entry);
    io.to('parents').emit('staff:presence', staffSummary());

    socket.on('disconnect', () => {
      const e = staffOnline.get(u.id);
      if (!e) return;
      e.sockets -= 1;
      if (e.sockets <= 0) staffOnline.delete(u.id);
      io.to('parents').emit('staff:presence', staffSummary());
    });
  } else {
    socket.join(`parent:${u.id}`);
    socket.join('parents');
    socket.emit('staff:presence', staffSummary());   // show the current staff status right after login
    online.set(u.id, (online.get(u.id) || 0) + 1);
    io.to('staff').emit('presence', { id: u.id, online: true });
    socket.on('disconnect', () => {
      const n = (online.get(u.id) || 1) - 1;
      if (n <= 0) { online.delete(u.id); io.to('staff').emit('presence', { id: u.id, online: false }); }
      else online.set(u.id, n);
    });
  }
});

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
if (process.env.RENDER && emailProvider !== 'brevo') {
  console.warn('WARNING: Render blocks SMTP ports 465/587. Set BREVO_API_KEY and MAIL_FROM to send email on Render.');
}
if (process.env.RENDER && !process.env.DATA_DIR) {
  console.warn('WARNING: SQLite data is ephemeral on Render. Set DATA_DIR to a persistent disk mount to keep the database.');
}
server.listen(PORT, () => console.log(`KidsCare running at http://localhost:${PORT} (email: ${emailProvider})`));
