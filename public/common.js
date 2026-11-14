// Shared helpers for all pages.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Server/client clock offset so countdowns are right even if the device clock is off.
let clockOffset = 0;
const syncClock = (serverNow) => { clockOffset = serverNow - Date.now(); };
const nowMs = () => Date.now() + clockOffset;

function fmtRemaining(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
const fmtClock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// The system works off turnaround time: a test is ready when its time is up,
// or earlier if staff marked it ready.
const readyTime = (t) => t.readyAt || t.dueAt;
const liveStatus = (t) => (t.readyAt || nowMs() >= t.dueAt ? 'ready' : 'waiting');

// Polling (serverless hosting can't hold live connections). Countdowns tick locally,
// so polling only needs to pick up staff changes.
function onLiveChange(fn, pollMs = 15000) {
  setInterval(() => { if (!document.hidden) fn(); }, pollMs);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) fn(); });
  window.addEventListener('online', fn);
}

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
  return data;
}

// A soft three-note chime made with Web Audio (no sound file needed).
let audioCtx = null;
function audio() {
  if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; } }
  return audioCtx;
}
function chime() {
  const ctx = audio(); if (!ctx || ctx.state !== 'running') return false;
  const t0 = ctx.currentTime + 0.05;
  [[659.25, 0], [830.61, 0.28], [987.77, 0.56]].forEach(([f, dt]) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0 + dt);
    g.gain.exponentialRampToValueAtTime(0.5, t0 + dt + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 1.2);
    o.connect(g).connect(ctx.destination);
    o.start(t0 + dt); o.stop(t0 + dt + 1.3);
  });
  return true;
}
