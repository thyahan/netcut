// NetCut panel: node server.mjs → http://127.0.0.1:8790
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { run, state, IDS, getMacIp } from './presets.mjs';
import { startDnsRelay } from './dns-relay.mjs';
import { log as writeLog, tailLog } from './log.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const PORT = 8790;
const running = new Set();
const timers = new Map(); // cut id -> { timer, restoreId, at }
const RESTORE_OF = { 'phone-cut': 'phone-restore', 'mac-cut': 'mac-restore' };

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

const json = (res, code, body) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(body)));

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(readFileSync(join(DIR, 'index.html')));
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    const s = await state();
    const t = Object.fromEntries([...timers].map(([cut, v]) => [cut, Math.max(0, Math.round((v.at - Date.now()) / 1000))]));
    return json(res, 200, { ...s, timers: t, running: [...running], log: tailLog(20) });
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
    if (r.ok && RESTORE_OF[id] && autoRestoreSec > 0) {
      cancelTimer(RESTORE_OF[id]);
      const restoreId = RESTORE_OF[id];
      timers.set(id, {
        restoreId,
        at: Date.now() + autoRestoreSec * 1000,
        timer: setTimeout(() => (timers.delete(id), exec(restoreId, ` (auto ${autoRestoreSec}s)`)), autoRestoreSec * 1000),
      });
    }
    return json(res, r.code === 409 ? 409 : 200, r);
  }
  json(res, 404, { err: 'not found' });
}).listen(PORT, '127.0.0.1', async () => {
  console.log(`NetCut → http://127.0.0.1:${PORT}`);
  if (!process.env.NETCUT_NO_OPEN) execFile('open', [`http://127.0.0.1:${PORT}`]);
  await startDnsRelay();
  const ip = await getMacIp();
  console.log(`IP ของ Mac เครื่องนี้: ${ip ?? '(ไม่เจอ — ต่อ Wi-Fi อยู่มั้ย?)'} · เคสบล็อก Vroom ให้ตั้ง DNS ของเครื่องที่จะบล็อกเป็น IP นี้`);
});

let quitting = false;
process.on('SIGINT', async () => {
  if (quitting) process.exit(1);
  quitting = true;
  console.log('\nSIGINT → restore-all ก่อนออก (กด Ctrl-C อีกครั้งเพื่อออกทันที)');
  cancelTimer('*');
  await exec('restore-all', ' (on exit)');
  process.exit(0);
});
