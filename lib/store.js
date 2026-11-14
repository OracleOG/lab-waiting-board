// Storage. On Vercel (or anywhere with Upstash Redis env vars) the whole state is one JSON
// document in Redis. Locally, with no Redis configured, it falls back to ./data/data.json.
// Volumes are tiny (a few dozen waiting patients a day), so one document is simplest and
// costs one Redis command per read.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = process.env.REDIS_KEY || 'lab-waiting-board:db';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'data.json');

let redis = null;
if (REDIS_URL && REDIS_TOKEN) {
  const { Redis } = require('@upstash/redis');
  redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
}

// Placeholder turnaround times (minutes). The lab should edit these in Staff > Tests.
const DEFAULT_CATALOG = [
  ['FBC', 'Full Blood Count', 60],
  ['E/U/Cr', 'Electrolytes, Urea & Creatinine', 120],
  ['LFT', 'Liver Function Test', 120],
  ['Lipid', 'Lipid Profile', 120],
  ['FBS', 'Fasting Blood Sugar', 20],
  ['RBS', 'Random Blood Sugar', 20],
  ['HbA1c', 'Glycated Haemoglobin', 90],
  ['MP', 'Malaria Parasite', 45],
  ['Widal', 'Widal Test', 45],
  ['PCV', 'Packed Cell Volume', 30],
  ['Urinalysis', 'Urinalysis', 30],
  ['Blood Group', 'Blood Group', 30],
  ['Genotype', 'Haemoglobin Genotype', 60],
  ['HIV', 'HIV Screening', 30],
  ['HBsAg', 'Hepatitis B Surface Antigen', 30],
  ['HCV', 'Hepatitis C Antibody', 30],
  ['PT', 'Pregnancy Test', 20],
  ['ESR', 'Erythrocyte Sedimentation Rate', 75],
];

const DEFAULT_SETTINGS = {
  labName: 'Laboratory',
  publicUrl: '', // used in QR codes; empty = the address the page was opened from
  tickerMessage: 'Times shown are estimates. When your test shows READY, please come to the reception counter.',
  timezone: process.env.LAB_TIMEZONE || 'Africa/Lagos', // for daily statistics
  scrollSpeed: 40,
  qrSeconds: 15,
  readyDisplayMinutes: 30,
  purgeHours: 12,
  sound: true,
};

const newId = (n = 8) => crypto.randomBytes(n).toString('hex').slice(0, n);

function fresh() {
  return {
    catalog: DEFAULT_CATALOG.map(([code, name, tatMinutes]) => ({ id: newId(), code, name, tatMinutes, active: true })),
    visits: [],
    stats: {},
    settings: { ...DEFAULT_SETTINGS },
  };
}

// Short in-process cache: warm serverless instances skip Redis for back-to-back reads.
let cache = null;
let cacheAt = 0;
const CACHE_MS = 2000;

async function rawRead() {
  if (redis) return (await redis.get(KEY)) || null;
  if (process.env.VERCEL) throw new Error('Database not configured: add Upstash Redis to this Vercel project (Storage tab) and redeploy.');
  return fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : null;
}
async function rawWrite(db) {
  if (redis) return redis.set(KEY, db);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(db, null, 2));
  fs.renameSync(FILE + '.tmp', FILE);
}

async function read() {
  if (cache && Date.now() - cacheAt < CACHE_MS) return structuredClone(cache);
  let db = await rawRead();
  const isNew = !db;
  if (isNew) db = fresh();
  db.settings = { ...DEFAULT_SETTINGS, ...(db.settings || {}) };
  db.stats = db.stats || {};
  if (purge(db) || isNew) await write(db);
  else { cache = structuredClone(db); cacheAt = Date.now(); }
  return db;
}
async function write(db) {
  await rawWrite(db);
  cache = structuredClone(db);
  cacheAt = Date.now();
}
// Read-modify-write. Last write wins; fine for one reception desk.
async function mutate(fn) {
  cache = null;
  const db = await read();
  const result = await fn(db);
  await write(db);
  return result;
}

// ---------- status ----------
// The system works off the turnaround time: a test is ready when its time is up.
// Staff can mark it ready early, or push it back if it's delayed.
const readyTime = (t) => t.readyAt || t.dueAt;
const testStatus = (t, now) => (t.readyAt || now >= t.dueAt ? 'ready' : 'waiting');

// ---------- statistics (no patient data: counts and times only) ----------
function dayKey(ms, tz) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms); }
  catch (e) { return new Date(ms).toISOString().slice(0, 10); }
}
// Called once per visit when it leaves the system.
function recordStats(db, v) {
  const day = dayKey(v.createdAt, db.settings.timezone);
  const d = (db.stats[day] = db.stats[day] || { patients: 0, tests: {} });
  d.patients += 1;
  const now = Date.now();
  for (const t of v.tests) {
    if (readyTime(t) > now) { d.leftBeforeReady = (d.leftBeforeReady || 0) + 1; continue; } // removed before result was ready
    const s = (d.tests[t.code] = d.tests[t.code] || { n: 0, targetMin: 0, actualMin: 0, delayed: 0, early: 0 });
    s.n += 1;
    s.targetMin += t.tatMinutes;
    s.actualMin += (readyTime(t) - t.startedAt) / 60e3;
    if (t.dueAt > t.startedAt + t.tatMinutes * 60e3 + 1000) s.delayed += 1;
    if (t.readyAt && t.readyAt < t.startedAt + t.tatMinutes * 60e3 - 1000) s.early += 1;
  }
  // keep about a year
  const keys = Object.keys(db.stats).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - 400))) delete db.stats[k];
}

function removeVisit(db, ticket) {
  const v = db.visits.find((x) => x.ticket === ticket);
  if (!v) return false;
  recordStats(db, v);
  db.visits = db.visits.filter((x) => x !== v);
  return true;
}

// Remove expired entries. Returns true if anything changed.
function purge(db, now = Date.now()) {
  const s = db.settings;
  const expired = db.visits.filter((v) => {
    if (now - v.createdAt > s.purgeHours * 3600e3) return true;
    return v.tests.length > 0 && v.tests.every((t) => now - readyTime(t) > s.readyDisplayMinutes * 60e3);
  });
  for (const v of expired) removeVisit(db, v.ticket);
  return expired.length > 0;
}

// Ticket IDs: 4 characters, no look-alikes (no 0/O, 1/I/L, 2/Z, 5/S, 8/B).
const ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679';
function newTicket(db) {
  const taken = new Set(db.visits.map((v) => v.ticket));
  for (;;) {
    let t = '';
    for (const b of crypto.randomBytes(4)) t += ALPHABET[b % ALPHABET.length];
    if (!taken.has(t)) return t;
  }
}

function makeTest(cat, now) {
  return { id: newId(), catalogId: cat.id, code: cat.code, name: cat.name, tatMinutes: cat.tatMinutes, startedAt: now, dueAt: now + cat.tatMinutes * 60e3, readyAt: null };
}

function createVisit(db, catalogIds) {
  const now = Date.now();
  const cats = catalogIds.map((cid) => db.catalog.find((c) => c.id === cid && c.active)).filter(Boolean);
  if (!cats.length) throw Object.assign(new Error('Select at least one test'), { status: 400 });
  const visit = { ticket: newTicket(db), createdAt: now, tests: cats.map((c) => makeTest(c, now)) };
  db.visits.push(visit);
  return visit;
}

function addTests(db, visit, catalogIds) {
  const now = Date.now();
  for (const cid of catalogIds) {
    const c = db.catalog.find((x) => x.id === cid && x.active);
    if (c) visit.tests.push(makeTest(c, now));
  }
}

const findVisit = (db, ticket) => db.visits.find((v) => v.ticket === String(ticket || '').toUpperCase().trim());

module.exports = { read, mutate, redis: () => redis, testStatus, readyTime, createVisit, addTests, findVisit, removeVisit, newId, dayKey };
