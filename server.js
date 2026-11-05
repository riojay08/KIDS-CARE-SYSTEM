// ============================================================
// KidsCare server.js (Clean Version)
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
const nodemailer = require('nodemailer');
const { OAuth2Client } = require('google-auth-library');
const db = require('./db');

fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ---------- Helpers ----------
const signToken = u =>
  jwt.sign({ id: u.id, role: u.role, name: u.name }, process.env.JWT_SECRET, { expiresIn: '7d' });

function auth(roles) {
  return (req, res, next) => {
    try {
      const token = (req.headers.authorization || '').replace('Bearer ', '');
      req.user = jwt.verify(token, process.env.JWT_SECRET);
      if (roles && !roles.includes(req.user.role)) return res.status(403).json({ error: 'Hindi allowed' });
      next();
    } catch {
      res.status(401).json({ error: 'Mag-login muna' });
    }
  };
}

const toChild = c => ({ ...c, allergies: JSON.parse(c.allergies || '[]') });

const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
});

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const mailHtml = (title, bodyHtml) => `
<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
  <div style="background:#0891b2;color:#fff;padding:14px 18px;font-weight:bold">KidsCare</div>
  <div style="padding:18px"><h2 style="margin:0 0 10px;font-size:18px">${title}</h2>${bodyHtml}</div>
  <div style="padding:10px 18px;font-size:12px;color:#64748b">Automated message from KidsCare. Please do not reply to this email.</div>
</div>`;

async function sendEmail(to, subject, text, kind = 'general', html) {
  let status = 'sent', error = null;
  try {
    await mailer.sendMail({ from: `KidsCare <${process.env.GMAIL_USER}>`, to, subject, text, html });
  } catch (e) {
    status = 'failed';
    error = e.message;
    console.error('Email failed:', e.message);
  }
  db.prepare('INSERT INTO email_log (to_email, subject, kind, status, error) VALUES (?, ?, ?, ?, ?)').run(to, subject, kind, status, error);
  return status;
}

// ---------- Routes ----------
app.post('/api/signup', (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !email.includes('@') || !password || password.length < 6)
    return res.status(400).json({ error: 'Kumpletuhin ang name, email at password (min 6)' });
  const em = email.trim().toLowerCase();
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(em))
    return res.status(409).json({ error: 'Registered na ang email na iyan' });
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
    return res.status(401).json({ error: 'Mali ang email, password o role' });
  res.json({ token: signToken(u), user: { id: u.id, role: u.role, name: u.name } });
});

app.get('/api/config', (req, res) => res.json({ googleClientId: process.env.GOOGLE_CLIENT_ID || '' }));

app.post('/api/google', async (req, res) => {
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: req.body.credential,
      audience: process.env.GOOGLE_CLIENT_ID
    });
    const p = ticket.getPayload();
    if (!p.email_verified) return res.status(401).json({ error: 'Hindi verified ang Google email' });
    const em = p.email.toLowerCase();
    let u = db.prepare('SELECT * FROM users WHERE email = ?').get(em);
    if (!u) {
      const info = db.prepare('INSERT INTO users (role, name, email) VALUES (?, ?, ?)').run('parent', p.name || em, em);
      u = { id: info.lastInsertRowid, role: 'parent', name: p.name || em };
    }
    if (u.role !== 'parent') return res.status(403).json({ error: 'Para sa parents lang ang Google login' });
    res.json({ token: signToken(u), user: { id: u.id, role: u.role, name: u.name } });
  } catch {
    res.status(401).json({ error: 'Hindi ma-verify ang Google login' });
  }
});

app.get('/api/children', auth(), (req, res) => {
  const rows = req.user.role === 'admin'
    ? db.prepare('SELECT c.*, u.name AS parent_name, u.email AS parent_email FROM children c JOIN users u ON u.id = c.parent_id ORDER BY c.name').all()
    : db.prepare('SELECT * FROM children WHERE parent_id = ?').all(req.user.id);
  res.json(rows.map(toChild));
});

app.post('/api/children', auth(['parent']), (req, res) => {
  const { name, address, age, dob, phone, allergies, classroom, medical_notes, emergency_name, emergency_phone } = req.body;
  if (!name || !address || !dob || !phone || !classroom || !emergency_name || !emergency_phone)
    return res.status(400).json({ error: 'Kumpletuhin ang form' });
  const token = crypto.randomBytes(16).toString('hex');
  const info = db.prepare(`INSERT INTO children
      (parent_id, name, address, age, dob, phone, allergies, qr_token, classroom, medical_notes, emergency_name, emergency_phone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.user.id, name.trim(), address.trim(), Number(age) || 0, dob, phone.trim(), JSON.stringify(allergies || []), token,
      String(classroom).trim(), String(medical_notes || '').trim(), String(emergency_name).trim(), String(emergency_phone).trim());
  db.prepare('UPDATE children SET student_code = ? WHERE id = ?')
    .run(`KC-${new Date().getFullYear()}-${String(info.lastInsertRowid).padStart(4, '0')}`, info.lastInsertRowid);
  res.json(toChild(db.prepare('SELECT * FROM children WHERE id = ?').get(info.lastInsertRowid)));
});

app.post('/api/scan', auth(['admin']), async (req, res) => {
  const token = String(req.body.token || '').replace('KIDSCARE:', '');
  const child = db.prepare('SELECT c.*, u.name AS parent_name, u.email AS parent_email FROM children c JOIN users u ON u.id = c.parent_id WHERE c.qr_token = ?').get(token);
  if (!child) return res.status(404).json({ error: 'Hindi kilalang QR code' });

  const arriving = child.status !== 'at_school';
  const status = arriving ? 'at_school' : 'home';
  db.prepare('UPDATE children SET status = ? WHERE id = ?').run(status, child.id);
  const scan = db.prepare('INSERT INTO scans (child_id, type, email_status) VALUES (?, ?, ?)').run(child.id, arriving ? 'arrival' : 'departure', 'pending');

  const time = new Date().toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Manila' });
  const subject = arriving ? `${child.name} arrived safely at school` : `${child.name} is safely headed home`;
  const body = `Hi ${child.parent_name}, ${child.name} ${arriving ? 'has safely arrived at school' : 'has left school and is safely headed home'} at ${time}.`;
  const html = mailHtml(esc(subject), `<p>${esc(body)}</p><p style="color:#64748b;font-size:13px">Student ID: ${esc(child.student_code)}</p>`);

  const emailStatus = await sendEmail(child.parent_email, subject, body, 'scan', html);
  db.prepare('UPDATE scans SET email_status = ? WHERE id = ?').run(emailStatus, scan.lastInsertRowid);

  io.to(`parent:${child.parent_id}`).to('staff').emit('status', { childId: child.id, status });
  res.json({ child: child.name, status, emailedTo: child.parent_email, emailStatus, subject, body });
});

app.get('/api/scans', auth(['admin']), (req, res) => {
  res.json(db.prepare(`SELECT s.id, s.type, s.email_status, s.created_at, c.name, u.email AS parent_email
    FROM scans s JOIN children c ON c.id = s.child_id JOIN users u ON u.id = c.parent_id
    ORDER BY s.id DESC LIMIT 8`).all());
});

app.get('/api/parents', auth(['admin']), (req, res) => {
  res.json(db.prepare("SELECT id, name, email FROM users WHERE role = 'parent' ORDER BY name").all());
});

const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, 'uploads'),
    filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + path.extname(file.originalname).toLowerCase())
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype))
});

function targetChildren(type, value) {
  if (type === 'child') return db.prepare('SELECT * FROM children WHERE id = ?').all(value);
  if (type === 'classroom') return db.prepare('SELECT * FROM children WHERE classroom = ?').all(value);
  return db.prepare('SELECT * FROM children').all();
}

async function emailParents(activityId, a, parentIds) {
  const parents = db.prepare(`SELECT name, email FROM users WHERE id IN (${parentIds.map(() => '?').join(',')})`).all(...parentIds);
  const link = process.env.PUBLIC_URL ? `<p><a href="${esc(process.env.PUBLIC_URL)}">Open KidsCare</a></p>` : '';
  for (const p of parents) {
    const subject = `${a.kind === 'announcement' ? '📢' : '🎨'} ${a.title}`;
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
  const type = ['all', 'classroom', 'child'].includes(req.body.targetType) ? req.body.targetType : 'all';
  const value = type === 'all' ? null : String(req.body.targetValue || '');
  if (!title) return res.status(400).json({ error: 'Lagyan ng title' });

  const children = targetChildren(type, value);
  if (!children.length) return res.status(400).json({ error: 'Walang estudyante sa napiling audience' });
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

app.get('/api/feed', auth(['parent']), (req, res) => {
  const me = req.user.id;
  const rows = db.prepare(`SELECT a.* FROM activities a
    WHERE (a.target_type = 'all' AND EXISTS (SELECT 1 FROM children WHERE parent_id = ?))
       OR (a.target_type = 'classroom' AND a.target_value IN (SELECT classroom FROM children WHERE parent_id = ?))
       OR (a.target_type = 'child' AND a.target_value IN (SELECT CAST(id AS TEXT) FROM children WHERE parent_id = ?))
    ORDER BY a.id DESC LIMIT 50`).all(me, me, me);
  const ph = db.prepare('SELECT file FROM activity_photos WHERE activity_id = ?');
  res.json(rows.map(a => ({ id: a.id, kind: a.kind, title: a.title, body: a.body, created_at: a.created_at, photos: ph.all(a.id).map(p => '/uploads/' + p.file) })));
});

const CHAT_SQL = `SELECT m.id, m.parent_id, m.text, m.created_at, u.name AS sender_name, u.role AS sender_role
  FROM chat_messages m JOIN users u ON u.id = m.sender_id`;
const getThread = pid => db.prepare(CHAT_SQL + ' WHERE m.parent_id = ? ORDER BY m.id').all(pid);

function postChat(req, res, pid) {
  const text = String(req.body.text || '').trim().slice(0, 1000);
  if (!text) return res.status(400).json({ error: 'Walang laman ang mensahe' });
  if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'parent'").get(pid)) return res.status(404).json({ error: 'Parent not found' });
  const info = db.prepare('INSERT INTO chat_messages (parent_id, sender_id, text) VALUES (?, ?, ?)').run(pid, req.user.id, text);
  const msg = db.prepare(CHAT_SQL + ' WHERE m.id = ?').get(info.lastInsertRowid);
  io.to(`parent:${pid}`).to('staff').emit('message', msg);
  res.json(msg);
}

app.get('/api/chat', auth(['parent']), (req, res) => res.json(getThread(req.user.id)));
app.post('/api/chat', auth(['parent']), (req, res) => postChat(req, res, req.user.id));
app.get('/api/chat/:pid', auth(['admin']), (req, res) => res.json(getThread(Number(req.params.pid))));
app.post('/api/chat/:pid', auth(['admin']), (req, res) => postChat(req, res, Number(req.params.pid)));

io.use((socket, next) => {
  try {
    socket.user = jwt.verify(socket.handshake.auth.token, process.env.JWT_SECRET);
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});
io.on('connection', socket => {
  socket.join(socket.user.role === 'admin' ? 'staff' : `parent:${socket.user.id}`);
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`KidsCare running at port ${PORT}`));