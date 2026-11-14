// Express app. Runs locally via server.js and on Vercel via api/index.js.
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const QRCode = require('qrcode');
const store = require('./lib/store');

const STAFF_PIN = process.env.STAFF_PIN || '1234';
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('lab-wait:' + STAFF_PIN).digest('hex');
const STAFF_TOKEN = crypto.createHmac('sha256', SECRET).update('staff-session').digest('hex');
if (!process.env.STAFF_PIN) console.warn('WARNING: STAFF_PIN not set, using default "1234". Set it before going live.');

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '50kb' }));

// async route wrapper with consistent error responses
const h = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  if (!e.status) console.error(e);
  res.status(e.status || 500).json({ error: e.message || 'Server error' });
});
const httpError = (status, message) => Object.assign(new Error(message), { status });

const publicTest = (t, n) => ({ id: t.id, code: t.code, name: t.name, dueAt: t.dueAt, readyAt: t.readyAt, status: store.testStatus(t, n) });
const baseUrl = (req, db) => (db.settings.publicUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
const noStore = (res) => res.set('Cache-Control', 'no-store');

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]));
}
function requireStaff(req, res, next) {
  const tok = parseCookies(req).staff || '';
  if (tok.length === STAFF_TOKEN.length && crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(STAFF_TOKEN))) return next();
  res.status(401).json({ error: 'Not signed in' });
}

// ---------- public API (the system holds no personal data) ----------
app.get('/api/board', h(async (req, res) => {
  const db = await store.read();
  const n = Date.now();
  const hideAfter = db.settings.readyDisplayMinutes * 60e3;
  const rows = [];
  for (const v of db.visits) {
    for (const t of v.tests) {
      if (n - store.readyTime(t) > hideAfter) continue;
      rows.push({ ticket: v.ticket, createdAt: v.createdAt, ...publicTest(t, n) });
    }
  }
  rows.sort((a, b) => a.createdAt - b.createdAt || a.dueAt - b.dueAt); // keep each patient's lines together
  const s = db.settings;
  noStore(res).json({
    now: n,
    settings: { labName: s.labName, tickerMessage: s.tickerMessage, scrollSpeed: s.scrollSpeed, qrSeconds: s.qrSeconds, sound: s.sound },
    trackUrl: baseUrl(req, db) + '/t',
    rows,
  });
}));

app.get('/api/track/:ticket', h(async (req, res) => {
  const db = await store.read();
  const v = store.findVisit(db, req.params.ticket);
  if (!v) throw httpError(404, 'ID not found. It may have expired. Check the characters and try again.');
  const n = Date.now();
  noStore(res).json({ now: n, ticket: v.ticket, createdAt: v.createdAt, labName: db.settings.labName, tests: v.tests.map((t) => publicTest(t, n)) });
}));

app.get('/qr.svg', h(async (req, res) => {
  const db = await store.read();
  const ticket = String(req.query.ticket || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const url = baseUrl(req, db) + '/t' + (ticket ? '/' + ticket : '');
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.type('image/svg+xml').set('Cache-Control', 'no-cache').send(svg);
}));

// ---------- staff auth ----------
const attempts = new Map();
async function tooManyAttempts(ip, failed) {
  const r = store.redis();
  const key = 'lab-waiting-board:login:' + ip;
  if (r) {
    if (failed) { const n = await r.incr(key); if (n === 1) await r.expire(key, 60); return n > 5; }
    return Number(await r.get(key)) >= 5;
  }
  const a = attempts.get(ip) || { n: 0, until: Date.now() + 60e3 };
  if (a.until < Date.now()) { a.n = 0; a.until = Date.now() + 60e3; }
  if (failed) a.n += 1;
  attempts.set(ip, a);
  return a.n >= 5;
}
app.post('/api/login', h(async (req, res) => {
  if (await tooManyAttempts(req.ip, false)) throw httpError(429, 'Too many attempts. Wait a minute.');
  const pin = String(req.body.pin || '');
  const ok = pin.length === STAFF_PIN.length && crypto.timingSafeEqual(Buffer.from(pin), Buffer.from(STAFF_PIN));
  if (!ok) { await tooManyAttempts(req.ip, true); throw httpError(401, 'Wrong PIN'); }
  const secure = req.secure ? '; Secure' : '';
  res.set('Set-Cookie', `staff=${STAFF_TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 30}${secure}`).json({ ok: true });
}));
app.post('/api/logout', (req, res) => {
  res.set('Set-Cookie', 'staff=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0').json({ ok: true });
});

// ---------- staff API ----------
const staff = express.Router();
staff.use(requireStaff);
staff.use((req, res, next) => { noStore(res); next(); });

staff.get('/state', h(async (req, res) => {
  const db = await store.read();
  const n = Date.now();
  res.json({
    now: n,
    catalog: db.catalog,
    settings: db.settings,
    visits: db.visits.map((v) => ({ ticket: v.ticket, createdAt: v.createdAt, tests: v.tests.map((t) => ({ ...publicTest(t, n), tatMinutes: t.tatMinutes, startedAt: t.startedAt })) })),
  });
}));

staff.post('/visits', h(async (req, res) => {
  const ids = Array.isArray(req.body.catalogIds) ? req.body.catalogIds : [];
  const r = await store.mutate((db) => {
    const v = store.createVisit(db, ids);
    return { ticket: v.ticket, trackUrl: baseUrl(req, db) + '/t/' + v.ticket, tests: v.tests };
  });
  res.json(r);
}));

// Run fn(db, visit, test) inside a mutation; 404 if missing.
const withTest = (fn) => h(async (req, res) => {
  await store.mutate((db) => {
    const v = store.findVisit(db, req.params.ticket);
    const t = v && v.tests.find((x) => x.id === req.params.testId);
    if (!t) throw httpError(404, 'Not found');
    fn(db, v, t, req);
  });
  res.json({ ok: true });
});

staff.post('/visits/:ticket/tests', h(async (req, res) => {
  await store.mutate((db) => {
    const v = store.findVisit(db, req.params.ticket);
    if (!v) throw httpError(404, 'Not found');
    store.addTests(db, v, Array.isArray(req.body.catalogIds) ? req.body.catalogIds : []);
  });
  res.json({ ok: true });
}));

// Mark ready early, or undo an early "ready".
staff.post('/visits/:ticket/tests/:testId/ready', withTest((db, v, t, req) => {
  t.readyAt = req.body.ready === false ? null : Date.now();
}));

// Delay: push the ready time back. If it's already past due, count from now.
staff.post('/visits/:ticket/tests/:testId/extend', withTest((db, v, t, req) => {
  const minutes = Math.max(1, Math.min(480, Number(req.body.minutes) || 15));
  t.dueAt = Math.max(t.dueAt, Date.now()) + minutes * 60e3;
  t.readyAt = null;
}));

staff.delete('/visits/:ticket/tests/:testId', withTest((db, v, t) => {
  v.tests = v.tests.filter((x) => x !== t);
  if (!v.tests.length) db.visits = db.visits.filter((x) => x !== v);
}));

staff.delete('/visits/:ticket', h(async (req, res) => {
  await store.mutate((db) => { if (!store.removeVisit(db, req.params.ticket)) throw httpError(404, 'Not found'); });
  res.json({ ok: true });
}));

function cleanCatalogInput(b) {
  const code = String(b.code || '').trim().slice(0, 20);
  const name = String(b.name || '').trim().slice(0, 80);
  const tatMinutes = Math.round(Number(b.tatMinutes));
  if (!code || !(tatMinutes > 0 && tatMinutes <= 7 * 24 * 60)) throw httpError(400, 'A short name and a turnaround time in minutes are required');
  return { code, name: name || code, tatMinutes };
}
staff.post('/catalog', h(async (req, res) => {
  const input = cleanCatalogInput(req.body);
  await store.mutate((db) => { db.catalog.push({ id: store.newId(), ...input, active: true }); });
  res.json({ ok: true });
}));
staff.put('/catalog/:id', h(async (req, res) => {
  const input = cleanCatalogInput(req.body);
  await store.mutate((db) => {
    const c = db.catalog.find((x) => x.id === req.params.id);
    if (!c) throw httpError(404, 'Not found');
    Object.assign(c, input, { active: req.body.active !== false });
  });
  res.json({ ok: true });
}));

staff.put('/settings', h(async (req, res) => {
  const b = req.body;
  await store.mutate((db) => {
    const s = db.settings;
    const num = (v, lo, hi, d) => { const x = Number(v); return v !== '' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
    if (b.labName !== undefined) s.labName = String(b.labName).slice(0, 80);
    if (b.publicUrl !== undefined) s.publicUrl = String(b.publicUrl).trim().slice(0, 200);
    if (b.tickerMessage !== undefined) s.tickerMessage = String(b.tickerMessage).slice(0, 300);
    if (b.timezone) { try { new Intl.DateTimeFormat('en', { timeZone: b.timezone }); s.timezone = b.timezone; } catch (e) { throw httpError(400, 'Unknown timezone'); } }
    if (b.sound !== undefined) s.sound = b.sound === true || b.sound === 'on' || b.sound === 'true';
    s.scrollSpeed = num(b.scrollSpeed, 10, 200, s.scrollSpeed);
    s.qrSeconds = num(b.qrSeconds, 5, 120, s.qrSeconds);
    s.readyDisplayMinutes = num(b.readyDisplayMinutes, 1, 240, s.readyDisplayMinutes);
    s.purgeHours = num(b.purgeHours, 1, 72, s.purgeHours);
  });
  res.json({ ok: true });
}));

// Daily statistics: counts and times only. Today's still-waiting patients are included live.
staff.get('/stats', h(async (req, res) => {
  const db = await store.read();
  const stats = structuredClone(db.stats);
  const today = store.dayKey(Date.now(), db.settings.timezone);
  const pending = db.visits.filter((v) => store.dayKey(v.createdAt, db.settings.timezone) === today);
  res.json({ today, timezone: db.settings.timezone, days: stats, waitingNow: db.visits.length, registeredTodayStillActive: pending.length });
}));

app.use('/api/staff', staff);

// ---------- pages (Vercel serves public/ itself; this is for local runs) ----------
const pub = path.join(__dirname, 'public');
app.use(express.static(pub, { extensions: ['html'] }));
app.get('/', (req, res) => res.redirect('/display'));
app.get(['/t', '/t/:ticket'], (req, res) => res.sendFile(path.join(pub, 'track.html')));

module.exports = app;
