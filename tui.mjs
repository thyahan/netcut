// Full-screen watch mode for `netcut -w`. No dependencies — plain ANSI.
import { run, state } from './presets.mjs';
import { log } from './log.mjs';
import { startDnsRelay } from './dns-relay.mjs';

const RESTORE_OF = { 'phone-cut': 'phone-restore', 'mac-cut': 'mac-restore' };
const KEYMAP = { 1: 'phone-cut', 2: 'phone-restore', 3: 'mac-cut', 4: 'mac-restore', 5: 'vroom-arm', 6: 'vroom-disarm', 7: 'rtdb-arm', 8: 'rtdb-disarm', a: 'restore-all', '\x1b': 'restore-all' };

const c = (code) => (s) => `\x1b[${code}m${s}\x1b[0m`;
const bold = c(1), dim = c(2), red = c(31), green = c(32), yellow = c(33), blue = c(34), cyan = c(36), inv = c(7);
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// ● on / ● off / ● ? — `good` says which value is the healthy one
const dot = (v, good = true, labels = ['on', 'off']) =>
  v === null || v === undefined ? dim('● ?') : v === good ? green(`● ${v ? labels[0] : labels[1]}`) : red(`● ${v ? labels[0] : labels[1]}`);

export async function watch({ after = 0, dry = false } = {}) {
  if (!process.stdin.isTTY) {
    console.error('watch mode ต้องรันใน terminal');
    process.exit(2);
  }
  let st = null;
  let polling = false;
  let lastPoll = 0;
  let quitting = false;
  const events = []; // newest last
  const running = new Set();
  const timers = new Map(); // restoreId -> { t, at }
  const push = (line) => {
    events.push(`${dim(new Date().toLocaleTimeString('en-GB'))} ${line}`);
    if (events.length > 200) events.shift();
    render();
  };

  // run() prints "$ cmd" in dry mode — route it into the event pane
  console.log = (...a) => push(dim(a.join(' ')));

  function cancel(restoreId) {
    const t = timers.get(restoreId);
    if (!t) return;
    clearTimeout(t.t);
    timers.delete(restoreId);
    push(dim(`ยกเลิก auto ${restoreId}`));
  }

  async function fire(id, note = '') {
    if (running.has(id)) return push(yellow(`${id} กำลังรันอยู่`));
    running.add(id);
    render();
    try {
      if (id === 'restore-all') [...timers.keys()].forEach(cancel);
      else if (Object.values(RESTORE_OF).includes(id)) cancel(id);
      // phone resolves through this Mac: cutting the Mac would also kill the phone's DNS
      if (id === 'mac-cut' && st?.phoneViaMac) {
        push(red(`✘ mac-cut ถูกกันไว้: มือถือใช้ DNS ของ Mac (${st.macIp}) อยู่ — คืนมือถือเป็น DHCP ก่อน`));
        return;
      }
      const r = await run(id, { dry });
      if (!dry) log(r, note);
      push(`${r.ok ? green('✔') : red('✘')} ${bold(id)}${note} ${dim(`${r.ms} ms`)}${r.err ? ' ' + red(r.err) : ''}`);
      if (r.out && !r.ok) r.out.split('\n').forEach((l) => push('  ' + dim(l)));
      else if (r.out && (id === 'vroom-arm' || id === 'rtdb-arm')) r.out.split('\n').forEach((l) => push('  ' + (l.startsWith('BLOCKED') ? green(l) : red(l))));
      const restoreId = RESTORE_OF[id];
      if (r.ok && restoreId && after) {
        cancel(restoreId);
        timers.set(restoreId, { at: Date.now() + after * 1000, t: setTimeout(() => (timers.delete(restoreId), fire(restoreId, ` (auto ${after}s)`)), after * 1000) });
      }
    } finally {
      running.delete(id);
      poll(true);
    }
  }

  async function poll(force = false) {
    if (polling || quitting) return;
    if (!force && Date.now() - lastPoll < 2000) return;
    polling = true;
    try {
      st = await state();
    } catch (e) {
      push(red(`status error: ${e.message}`));
    } finally {
      lastPoll = Date.now();
      polling = false;
      render();
    }
  }

  function render() {
    if (quitting) return;
    const W = Math.max(60, Math.min(process.stdout.columns || 80, 100));
    const H = process.stdout.rows || 30;
    const rule = (title = '') => dim('─'.repeat(2)) + (title ? ` ${bold(title)} ` : '') + dim('─'.repeat(Math.max(0, W - 4 - strip(title).length)));
    const L = [];
    const now = new Date().toLocaleTimeString('en-GB');
    const mode = [dry && inv(yellow(' DRY ')), after && cyan(`auto-restore ${after}s`), polling && dim('refreshing…')].filter(Boolean).join('  ');
    const head = `${inv(bold(' NETCUT '))} ${dim('vdoc connection-loss panel')}  ${mode}`;
    L.push(head + ' '.repeat(Math.max(1, W - strip(head).length - now.length)) + dim(now));
    L.push('');

    // PHONE
    L.push(rule('PHONE'));
    if (!st) L.push('  ' + dim('loading…'));
    else if (!st.adb) L.push(`  ${red('● not connected')}  ${dim('เสียบ USB + เปิด USB debugging (adb -d)')}`);
    else {
      L.push(`  ${green('● connected')}  ${bold(st.phoneModel)}  ${dim(`Android ${st.phoneAndroid} · ${st.phoneSerial}`)}`);
      L.push(`  Wi-Fi ${dot(st.phoneWifi)}${st.phoneSsid ? dim(` (${st.phoneSsid})`) : ''}   Data ${dot(st.phoneData)}   Internet ${dot(st.phoneOnline, true, ['online', 'offline'])}`);
    }
    L.push('');

    // MAC
    L.push(rule('MAC (agent)'));
    if (st) L.push(`  Wi-Fi ${dot(st.macWifi)}   Internet ${dot(st.macOnline, true, ['online', 'offline'])}`);
    L.push('');

    // ADGUARD
    L.push(rule('DNS / ADGUARD'));
    if (st) {
      const profile = st.phoneViaMac && st.macViaMac ? yellow('ทั้งสองเครื่องชี้มาที่ Mac — ตรวจ')
        : st.phoneViaMac ? cyan('บล็อกลูกค้า (มือถือ → Mac)')
        : st.macViaMac ? cyan('บล็อก agent (Mac → Mac)')
        : dim('ปกติ (ไม่มีเครื่องไหนชี้มาที่ Mac)');
      L.push(`  โปรไฟล์ ${profile}   IP ของ Mac ${bold(st.macIp ?? '?')}   relay :53 ${dot(st.relayUp, true, ['up', 'down'])}`);
      L.push(`  มือถือ DNS ${dim(st.phoneDns ?? '?')}   Mac DNS ${dim(st.macDns)}`);
      L.push(`  AdGuard ${st.adguardUp ? green('● up') : red('● down — รัน npm start')}   Vroom ${st.adguardArmed ? red('● BLOCKED') : st.adguardArmed === false ? green('● not blocked') : dim('● ?')}${st.adguardArmed && !st.phoneViaMac && !st.macViaMac ? yellow('  (ไม่มีเครื่องไหนโดน — ยังไม่ได้ตั้ง DNS)') : ''}`);
      if ((st.phoneViaMac || st.macViaMac) && !st.relayUp) L.push('  ' + red('⚠ relay down: เครื่องที่ชี้ DNS มาที่ Mac จะเปิดเว็บไม่ได้ — รัน npm start หรือคืน DNS'));
    }
    L.push('');

    // TIMERS / RUNNING
    const pend = [...timers].map(([id, t]) => yellow(`⏱ ${id} ใน ${Math.max(0, Math.ceil((t.at - Date.now()) / 1000))}s`));
    const busy = [...running].map((id) => cyan(`⟳ ${id}`));
    if (pend.length || busy.length) L.push('  ' + [...busy, ...pend].join('   ')), L.push('');

    // KEYS
    L.push(rule('KEYS'));
    const k = (key, label, color) => `${inv(color(` ${key} `))} ${label}`;
    L.push(`  ${k('1', 'cut phone   ', red)}  ${k('2', 'restore phone', green)}   ${k('a', 'restore ALL', blue)}`);
    L.push(`  ${k('3', 'cut Mac     ', red)}  ${k('4', 'restore Mac  ', green)}   ${k('s', 'refresh', dim)}`);
    L.push(`  ${k('5', 'block Vroom ', yellow)}  ${k('6', 'unblock Vroom', green)}   ${k('q', 'quit', dim)}  ${dim('^C = restore ALL + quit')}`);
    L.push(`  ${k('7', 'block RTDB  ', yellow)}  ${k('8', 'unblock RTDB ', green)}   ${st?.rtdbArmed ? red('● Realtime DB BLOCKED') : ''}`);
    L.push(`  ${dim('5 = บล็อกเฉพาะเครื่องที่ชี้ DNS มาที่ Mac · กดก่อนเข้าคิว/ก่อน agent รับสาย ≥60 วิ')}`);
    L.push('');

    // EVENTS fill the rest
    L.push(rule('LOG'));
    const room = Math.max(3, H - L.length - 1);
    const shown = events.slice(-room);
    L.push(...shown.map((e) => '  ' + e));
    while (L.length < H - 1) L.push('');

    process.stdout.write('\x1b[H' + L.slice(0, H - 1).map((l) => l + '\x1b[K').join('\n') + '\x1b[J');
  }

  function cleanupScreen() {
    process.stdout.write('\x1b[?25h\x1b[?1049l');
  }

  async function quit(restore) {
    if (quitting) return process.exit(1);
    [...timers.keys()].forEach(cancel);
    if (restore) {
      push(yellow('คืนทุกอย่างก่อนออก…'));
      const r = await run('restore-all', { dry });
      if (!dry) log(r, ' (on exit)');
    }
    quitting = true;
    const s = await state().catch(() => null);
    cleanupScreen();
    process.stdout.write(`netcut watch ออกแล้ว\n`);
    if (s && (s.adguardArmed || s.rtdbArmed || s.phoneWifi === false || s.phoneData === false || s.macWifi === false))
      process.stdout.write(yellow('⚠ ยังมีของที่ตัด/บล็อกค้างอยู่ — รัน: netcut all\n'));
    process.exit(0);
  }

  process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J');
  process.on('exit', cleanupScreen);
  process.stdout.on('resize', () => (process.stdout.write('\x1b[2J'), render()));
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (key) => {
    if (key === '\u0003') return quit(true);
    if (key === 'q') return quit(false);
    if (key === 's') return poll(true);
    const id = KEYMAP[key];
    if (id) fire(id);
  });

  push(dim(`พร้อม — กดปุ่มได้เลย${after ? ` · 1/3 คืนเองหลัง ${after}s` : ''}`));
  startDnsRelay((m) => push(dim(m)));
  poll(true);
  setInterval(() => (poll(), render()), 1000);
}
