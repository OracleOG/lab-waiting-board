// Tiny JSON-file store. Volumes are small (a few dozen waiting patients a day),
// so a single file with atomic writes is simpler and more portable than a database.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'data.json');

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
  publicUrl: '', // e.g. https://lab-wait.example.com — used in QR codes. Empty = use the host the TV loaded from.
  tickerMessage: 'Times shown are estimates. When your test shows READY, please come to the reception counter.',
  scrollSpeed: 40, // pixels per second on the TV
  qrSeconds: 15, // how long the QR screen shows after each full scroll
  readyDisplayMinutes: 30, // ready tests stay on the TV this long
  purgeHours: 12, // every entry is deleted this long after registration
};

const id = (n = 8) => crypto.randomBytes(n).toString('hex').slice(0, n);

let db;
let saveTimer = null;

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(FILE)) {
    db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } else {
    db = {
      catalog: DEFAULT_CATALOG.map(([code, name, tatMinutes]) => ({ id: id(), code, name, tatMinutes, active: true })),
      visits: [],
    };
  }
  db.settings = { ...DEFAULT_SETTINGS, ...(db.settings || {}) };
  saveNow();
}

function saveNow() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, FILE);
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 200);
}

// Ticket IDs: 4 characters, no look-alikes (no 0/O, 1/I/L, 2/Z, 5/S, 8/B).
const ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679';
function newTicket() {
  const taken = new Set(db.visits.map((v) => v.ticket));
  for (;;) {
    const bytes = crypto.randomBytes(4);
    let t = '';
    for (const b of bytes) t += ALPHABET[b % ALPHABET.length];
    if (!taken.has(t)) return t;
  }
}

function testStatus(t, now) {
  if (t.readyAt) return 'ready';
  return now >= t.dueAt ? 'due' : 'waiting';
}

// Remove expired data. Returns true if anything changed.
function purge(now = Date.now()) {
  const s = db.settings;
  const before = db.visits.length;
  db.visits = db.visits.filter((v) => {
    if (now - v.createdAt > s.purgeHours * 3600e3) return false;
    const allReadyLongAgo = v.tests.length > 0 && v.tests.every((t) => t.readyAt && now - t.readyAt > s.readyDisplayMinutes * 60e3);
    return !allReadyLongAgo;
  });
  if (db.visits.length !== before) {
    save();
    return true;
  }
  return false;
}

function makeTest(cat, now) {
  return { id: id(), catalogId: cat.id, code: cat.code, name: cat.name, tatMinutes: cat.tatMinutes, startedAt: now, dueAt: now + cat.tatMinutes * 60e3, readyAt: null };
}

module.exports = {
  load,
  get db() { return db; },
  save,
  purge,
  testStatus,
  getVisit: (ticket) => db.visits.find((v) => v.ticket === String(ticket || '').toUpperCase().trim()),

  createVisit(catalogIds) {
    const now = Date.now();
    const cats = catalogIds.map((cid) => db.catalog.find((c) => c.id === cid && c.active)).filter(Boolean);
    if (!cats.length) throw new Error('Select at least one test');
    const visit = { ticket: newTicket(), createdAt: now, tests: cats.map((c) => makeTest(c, now)) };
    db.visits.push(visit);
    save();
    return visit;
  },

  addTests(visit, catalogIds) {
    const now = Date.now();
    for (const cid of catalogIds) {
      const c = db.catalog.find((x) => x.id === cid && x.active);
      if (c) visit.tests.push(makeTest(c, now));
    }
    save();
  },

  newId: id,
};
