// NetCut panel: node server.mjs → http://127.0.0.1:8790
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { run, state, IDS, getMacIp } from './presets.mjs';
import { startDnsRelay } from './dns-relay.mjs';
import { log as writeLog, tailLog } from './log.mjs';
import { startConsentTrigger, arm, disarm, consentState } from './consent-trigger.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const PORT = 8790;
const running = new Set();
const timers = new Map(); // cut id -> { timer, restoreId, at }
const RESTORE_OF = { 'phone-cut': 'phone-restore', 'mac-cut': 'mac-restore' };
// consent-card targets -> existing presets
const CONSENT_TARGETS = {
  'phone-app-vdoc': { id: 'phone-cut', opts: { method: 'app', app: 'vdoc' } },
  'phone-app-chrome': { id: 'phone-cut', opts: { method: 'app', app: 'chrome' } },
  'phone-airplane': { id: 'phone-cut', opts: { method: 'airplane' } },
  mac: { id: 'mac-cut', opts: {} },
};

const log = (r, note) => console.log(writeLog(r, note));

async function exec(id, note = '', opts = {}) {
  if (running.has(id)) return { id, ok: false, code: 409, err: 'กำลังรันอยู่', out: '', ms: 0 };
  running.add(id);
  try {
    const r = await run(id, opts);
    log(r, note);
    return r;
  } finally {
    running.delete(id);
  }
}

function cancelTimer(restoreId) {
  for (const [cut, t] of timers) if (t.restoreId === restoreId || restoreId === '*') clearTimeout(t.timer), timers.delete(cut);
}

function scheduleRestore(id, autoRestoreSec) {
  if (!RESTORE_OF[id] || autoRestoreSec <= 0) return;
  cancelTimer(RESTORE_OF[id]);
  const restoreId = RESTORE_OF[id];
  timers.set(id, {
    restoreId,
    at: Date.now() + autoRestoreSec * 1000,
    timer: setTimeout(() => (timers.delete(id), exec(restoreId, ` (auto ${autoRestoreSec}s)`)), autoRestoreSec * 1000),
  });
}

const json = (res, code, body) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(body)));

// Every POST changes network state. Only the panel itself may send one: a page on another site can
// reach 127.0.0.1 too (CSRF), and a rebound hostname would pass as same-origin without the Host check.
const SELF = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
const fromPanel = ({ host, origin }) => SELF.includes(host) && (origin === undefined || SELF.some((h) => origin === `http://${h}`));

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && !fromPanel(req.headers)) return json(res, 403, { ok: false, err: 'forbidden origin' });
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(readFileSync(join(DIR, 'index.html')));
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    const s = await state();
    const t = Object.fromEntries([...timers].map(([cut, v]) => [cut, Math.max(0, Math.round((v.at - Date.now()) / 1000))]));
    return json(res, 200, { ...s, timers: t, running: [...running], log: tailLog(20), consent: consentState() });
  }
  if (req.method === 'POST' && (url.pathname === '/api/consent-arm' || url.pathname === '/api/consent-disarm')) {
    let body = '';
    for await (const c of req) body += c;
    const p = JSON.parse(body || '{}');
    if (url.pathname === '/api/consent-disarm') return disarm(), json(res, 200, { ok: true });
    if (!CONSENT_TARGETS[p.target]) return json(res, 400, { ok: false, err: `unknown target ${p.target}` });
    if (p.target === 'mac' && (await state()).phoneViaMac)
      return json(res, 409, { ok: false, err: 'มือถือใช้ DNS ของ Mac อยู่ — คืนมือถือเป็น DHCP ก่อนตัด Mac' });
    const r = arm(String(p.sessionId || ''), { target: p.target, autoRestoreSec: Number(p.autoRestoreSec) || 0 });
    return json(res, r.ok ? 200 : 409, r);
  }
  const m = url.pathname.match(/^\/api\/run\/([\w-]+)$/);
  if (req.method === 'POST' && m) {
    const id = m[1];
    if (!IDS.includes(id)) {
      const r = { id, code: 404, err: `unknown preset ${id}` };
      log(r);
      return json(res, 404, r);
    }
    let body = '';
    for await (const c of req) body += c;
    const params = JSON.parse(body || '{}');
    const autoRestoreSec = Number(params.autoRestoreSec) || 0;
    const opts = id === 'phone-cut' ? { method: params.method === 'app' ? 'app' : 'airplane', app: params.app } : {};
    if (id === 'restore-all') cancelTimer('*');
    else if (Object.values(RESTORE_OF).includes(id)) cancelTimer(id);
    if (id === 'mac-cut' && (await state()).phoneViaMac) {
      const r = { id, ok: false, code: 409, out: '', err: 'มือถือใช้ DNS ของ Mac อยู่ — คืนมือถือเป็น DHCP ก่อนตัด Mac', ms: 0 };
      log(r);
      return json(res, 409, r);
    }
    const r = await exec(id, opts.method === 'app' ? ` [app ${opts.app}]` : '', opts);
    if (r.ok) scheduleRestore(id, autoRestoreSec);
    return json(res, r.code === 409 ? 409 : 200, r);
  }
  json(res, 404, { err: 'not found' });
}).listen(PORT, '127.0.0.1', async () => {
  console.log(`NetCut → http://127.0.0.1:${PORT}`);
  if (!process.env.NETCUT_NO_OPEN) execFile('open', [`http://127.0.0.1:${PORT}`]);
  startConsentTrigger(async ({ target, autoRestoreSec }) => {
    const { id, opts } = CONSENT_TARGETS[target];
    const r = await exec(id, (opts.method === 'app' ? ` [app ${opts.app}]` : '') + ' (consent)', opts);
    if (r.ok) scheduleRestore(id, autoRestoreSec);
    return r;
  });
  await startDnsRelay();
  const ip = await getMacIp();
  console.log(`IP ของ Mac เครื่องนี้: ${ip ?? '(ไม่เจอ — ต่อ Wi-Fi อยู่มั้ย?)'} · เคสบล็อก Vroom ให้ตั้ง DNS ของเครื่องที่จะบล็อกเป็น IP นี้`);
});

let quitting = false;
process.on('SIGINT', async () => {
  if (quitting) process.exit(1);
  quitting = true;
  console.log('\nSIGINT → restore-all ก่อนออก (กด Ctrl-C อีกครั้งเพื่อออกทันที)');
  disarm();
  cancelTimer('*');
  await exec('restore-all', ' (on exit)');
  process.exit(0);
});
