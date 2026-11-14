// Shared helpers for all pages.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Server/client clock offset so countdowns are right even if the TV's clock is off.
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

// Live status for a test, recomputed every second on the client.
function liveStatus(t) {
  if (t.readyAt) return 'ready';
  return nowMs() >= t.dueAt ? 'due' : 'waiting';
}

// Re-fetch whenever the server says something changed, plus a slow poll as a safety net.
function onLiveChange(fn, pollMs = 30000) {
  let es;
  const connect = () => {
    try {
      es = new EventSource('/api/stream');
      es.addEventListener('change', fn);
      es.onopen = fn;
    } catch (e) { /* polling still covers us */ }
  };
  connect();
  setInterval(fn, pollMs);
}

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
  return data;
}
