const express = require('express');
const crypto = require('crypto');
const path = require('path');
const QRCode = require('qrcode');
const store = require('./lib/store');

const PORT = process.env.PORT || 3000;
const STAFF_PIN = process.env.STAFF_PIN || '1234';
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('lab-wait:' + STAFF_PIN).digest('hex');
const STAFF_TOKEN = crypto.createHmac('sha256', SECRET).update('staff-session').digest('hex');

if (!process.env.STAFF_PIN) console.warn('WARNING: STAFF_PIN not set, using default "1234". Set it before going live.');

store.load();
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '50kb' }));

// ---------- live updates (Server-Sent Events) ----------
const clients = new Set();
function broadcast() {
  for (const res of clients) res.write('event: change\ndata: {}\n\n');
}
app.get('/api/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 5000\n\n');
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
});

setInterval(() => { if (store.purge()) broadcast(); }, 60e3);

// ---------- helpers ----------
const now = () => Date.now();
const publicTest = (t, n) => ({ id: t.id, code: t.code, name: t.name, dueAt: t.dueAt, readyAt: t.readyAt, status: store.testStatus(t, n) });
function baseUrl(req) {
  const s = store.db.settings.publicUrl;
  return (s || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}
function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]));
}
function requireStaff(req, res, next) {
  const tok = parseCookies(req).staff || '';
  if (tok.length === STAFF_TOKEN.length && crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(STAFF_TOKEN))) return next();
  res.status(401).json({ error: 'Not signed in' });
}
const changed = (res, body = { ok: true }) => { store.save(); broadcast(); res.json(body); };

// ---------- public API (no personal data exists in the system) ----------
app.get('/api/board', (req, res) => {
  store.purge();
  const n = now();
  const { settings } = store.db;
  const hideReadyAfter = settings.readyDisplayMinutes * 60e3;
  const rows = [];
  for (const v of store.db.visits) {
    for (const t of v.tests) {
      if (t.readyAt && n - t.readyAt > hideReadyAfter) continue;
      rows.push({ ticket: v.ticket, createdAt: v.createdAt, ...publicTest(t, n) });
    }
  }
  // Keep each patient's lines together, oldest registration first.
  rows.sort((a, b) => a.createdAt - b.createdAt || a.dueAt - b.dueAt);
  res.json({
    now: n,
    settings: { labName: settings.labName, tickerMessage: settings.tickerMessage, scrollSpeed: settings.scrollSpeed, qrSeconds: settings.qrSeconds },
    trackUrl: baseUrl(req) + '/t',
    rows,
  });
});

app.get('/api/track/:ticket', (req, res) => {
  const v = store.getVisit(req.params.ticket);
  if (!v) return res.status(404).json({ error: 'ID not found. It may have expired, or check the characters and try again.' });
  const n = now();
  res.json({ now: n, ticket: v.ticket, createdAt: v.createdAt, labName: store.db.settings.labName, tests: v.tests.map((t) => publicTest(t, n)) });
});

app.get('/qr.svg', async (req, res) => {
  const ticket = String(req.query.ticket || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const url = baseUrl(req) + '/t' + (ticket ? '/' + ticket : '');
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.type('image/svg+xml').set('Cache-Control', 'no-cache').send(svg);
});

// ---------- staff auth ----------
const attempts = new Map();
app.post('/api/login', (req, res) => {
  const key = req.ip;
  const a = attempts.get(key) || { n: 0, until: 0 };
  if (a.until > now()) return res.status(429).json({ error: 'Too many attempts. Wait a minute.' });
  const pin = String(req.body.pin || '');
  const ok = pin.length === STAFF_PIN.length && crypto.timingSafeEqual(Buffer.from(pin), Buffer.from(STAFF_PIN));
  if (!ok) {
    a.n += 1;
    if (a.n >= 5) { a.n = 0; a.until = now() + 60e3; }
    attempts.set(key, a);
    return res.status(401).json({ error: 'Wrong PIN' });
  }
  attempts.delete(key);
  const secure = req.secure ? '; Secure' : '';
  res.set('Set-Cookie', `staff=${STAFF_TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 30}${secure}`);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  res.set('Set-Cookie', 'staff=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0').json({ ok: true });
});

// ---------- staff API ----------
const staff = express.Router();
staff.use(requireStaff);

staff.get('/state', (req, res) => {
  store.purge();
  const n = now();
  const { catalog, visits, settings } = store.db;
  res.json({
    now: n,
    catalog,
    settings,
    visits: visits.map((v) => ({ ticket: v.ticket, createdAt: v.createdAt, tests: v.tests.map((t) => ({ ...publicTest(t, n), tatMinutes: t.tatMinutes, startedAt: t.startedAt })) })),
  });
});

staff.post('/visits', (req, res) => {
  try {
    const v = store.createVisit(Array.isArray(req.body.catalogIds) ? req.body.catalogIds : []);
    broadcast();
    res.json({ ticket: v.ticket, trackUrl: baseUrl(req) + '/t/' + v.ticket, tests: v.tests });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

function findTest(req, res) {
  const v = store.getVisit(req.params.ticket);
  const t = v && v.tests.find((x) => x.id === req.params.testId);
  if (!t) res.status(404).json({ error: 'Not found' });
  return { v, t };
}

staff.post('/visits/:ticket/tests', (req, res) => {
  const v = store.getVisit(req.params.ticket);
  if (!v) return res.status(404).json({ error: 'Not found' });
  store.addTests(v, Array.isArray(req.body.catalogIds) ? req.body.catalogIds : []);
  changed(res);
});

staff.post('/visits/:ticket/tests/:testId/ready', (req, res) => {
  const { t } = findTest(req, res); if (!t) return;
  t.readyAt = req.body.ready === false ? null : now();
  changed(res);
});

staff.post('/visits/:ticket/tests/:testId/extend', (req, res) => {
  const { t } = findTest(req, res); if (!t) return;
  const minutes = Math.max(-240, Math.min(480, Number(req.body.minutes) || 0));
  // Extending an overdue test counts from now, not from the old due time.
  const base = minutes > 0 ? Math.max(t.dueAt, now()) : t.dueAt;
  t.dueAt = base + minutes * 60e3;
  t.readyAt = null;
  changed(res);
});

staff.delete('/visits/:ticket/tests/:testId', (req, res) => {
  const { v, t } = findTest(req, res); if (!t) return;
  v.tests = v.tests.filter((x) => x !== t);
  if (!v.tests.length) store.db.visits = store.db.visits.filter((x) => x !== v);
  changed(res);
});

staff.delete('/visits/:ticket', (req, res) => {
  const before = store.db.visits.length;
  store.db.visits = store.db.visits.filter((v) => v.ticket !== req.params.ticket);
  if (store.db.visits.length === before) return res.status(404).json({ error: 'Not found' });
  changed(res);
});

function cleanCatalogInput(b) {
  const code = String(b.code || '').trim().slice(0, 20);
  const name = String(b.name || '').trim().slice(0, 80);
  const tatMinutes = Math.round(Number(b.tatMinutes));
  if (!code || !(tatMinutes > 0 && tatMinutes <= 7 * 24 * 60)) throw new Error('Short name and a turnaround time in minutes are required');
  return { code, name: name || code, tatMinutes };
}
staff.post('/catalog', (req, res) => {
  try { store.db.catalog.push({ id: store.newId(), ...cleanCatalogInput(req.body), active: true }); changed(res); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
staff.put('/catalog/:id', (req, res) => {
  const c = store.db.catalog.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  try { Object.assign(c, cleanCatalogInput(req.body), { active: req.body.active !== false }); changed(res); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

staff.put('/settings', (req, res) => {
  const s = store.db.settings;
  const b = req.body;
  const num = (v, lo, hi, d) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
  if (b.labName !== undefined) s.labName = String(b.labName).slice(0, 80);
  if (b.publicUrl !== undefined) s.publicUrl = String(b.publicUrl).trim().slice(0, 200);
  if (b.tickerMessage !== undefined) s.tickerMessage = String(b.tickerMessage).slice(0, 300);
  s.scrollSpeed = num(b.scrollSpeed, 10, 200, s.scrollSpeed);
  s.qrSeconds = num(b.qrSeconds, 5, 120, s.qrSeconds);
  s.readyDisplayMinutes = num(b.readyDisplayMinutes, 1, 240, s.readyDisplayMinutes);
  s.purgeHours = num(b.purgeHours, 1, 72, s.purgeHours);
  changed(res);
});

app.use('/api/staff', staff);

// ---------- pages ----------
const pub = path.join(__dirname, 'public');
app.use(express.static(pub, { extensions: ['html'] }));
app.get('/', (req, res) => res.redirect('/display'));
app.get(['/t', '/t/:ticket'], (req, res) => res.sendFile(path.join(pub, 'track.html')));

app.listen(PORT, () => console.log(`Lab waiting board on http://localhost:${PORT}  (TV: /display, staff: /staff, patients: /t)`));
