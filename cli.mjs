#!/usr/bin/env node
// NetCut CLI — same presets as the web panel, same netcut.log.
import { run, state, IDS } from './presets.mjs';
import { log, tailLog } from './log.mjs';
import { watch } from './tui.mjs';

const ALIAS = { 1: 'phone-cut', 2: 'phone-restore', 3: 'mac-cut', 4: 'mac-restore', 5: 'vroom-arm', 6: 'vroom-disarm', all: 'restore-all', esc: 'restore-all' };
const RESTORE_OF = { 'phone-cut': 'phone-restore', 'mac-cut': 'mac-restore' };

const HELP = `usage: netcut <command> [--restore-after <sec>] [--dry]
       netcut -w [--restore-after <sec>] [--dry]     watch mode: กดปุ่มเดียวไม่ต้อง Enter

  1  phone-cut       ตัดมือถือทั้งเครื่อง (wifi + data)
  2  phone-restore   คืนเน็ตมือถือ
  3  mac-cut         ตัด Wi-Fi ของ Mac
  4  mac-restore     คืน Wi-Fi ของ Mac
  5  vroom-arm       บล็อก Vroom ที่ AdGuard บน Mac (เฉพาะเครื่องที่ตั้ง DNS เป็น IP ของ Mac)
  6  vroom-disarm    ปลดบล็อก Vroom
  all restore-all    คืนทุกอย่าง
     status          ดูสถานะ
     log [n]         ดู netcut.log n บรรทัดล่าสุด (default 20)

  --restore-after <sec>   ใช้กับ 1 / 3: รอแล้วคืนเอง (Ctrl-C = คืนทันที)
  --dry                   พิมพ์คำสั่งแทนการรัน

ตัวอย่าง: netcut 1 --restore-after 130`;

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const [, v] = args.splice(i, 2);
  return v;
};
const dry = args.includes('--dry') && (args.splice(args.indexOf('--dry'), 1), true);
const after = Number(flag('--restore-after') || 0);
const cmd = args[0];

async function exec(id, note = '') {
  const r = await run(id, { dry });
  if (!dry) log(r, note);
  const mark = r.ok ? '\x1b[32mOK\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`${new Date().toLocaleTimeString()} ${id}${note} → ${mark} (${r.ms} ms)`);
  if (r.out) console.log(r.out);
  if (r.err) console.error(r.err);
  return r;
}

function countdown(sec, restoreId) {
  return new Promise((resolve) => {
    let left = sec;
    const done = async (note) => {
      clearInterval(tick);
      process.removeListener('SIGINT', onInt);
      process.stdout.write('\n');
      resolve(await exec(restoreId, note));
    };
    const onInt = () => done(' (Ctrl-C)');
    process.on('SIGINT', onInt);
    const tick = setInterval(() => {
      process.stdout.write(`\r${restoreId} ใน ${--left} วิ (Ctrl-C = คืนเลย)  `);
      if (left <= 0) done(` (auto ${sec}s)`);
    }, 1000);
  });
}

async function runStatus() {
  const s = await state();
  const f = (v) => (v === null || v === undefined ? '?' : v === true ? 'on' : v === false ? 'off' : v);
  console.log(`adb USB      ${f(s.adb)}
มือถือ        ${s.phoneModel ?? '-'}   wifi ${f(s.phoneWifi)}   data ${f(s.phoneData)}   internet ${f(s.phoneOnline)}
Mac Wi-Fi    ${f(s.macWifi)}   internet ${f(s.macOnline)}
DNS          มือถือ ${s.phoneDns ?? '-'} · Mac ${s.macDns} · IP ของ Mac ${s.macIp ?? '?'} · relay :53 ${f(s.relayUp)}
AdGuard      ${f(s.adguardUp)}   Vroom บล็อก ${f(s.adguardArmed)}`);
  if (s.adguardArmed) console.log('\x1b[33m⚠ Vroom ยังถูกบล็อกอยู่ — รัน: netcut 6\x1b[0m');
}

if (cmd === '-w' || cmd === '--watch' || cmd === 'watch') {
  await watch({ after, dry });
} else if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
  console.log(HELP);
} else if (cmd === 'status') {
  await runStatus();
} else if (cmd === 'log') {
  console.log(tailLog(Number(args[1]) || 20).reverse().join('\n'));
} else {
  const id = ALIAS[cmd] || cmd;
  if (!IDS.includes(id)) {
    console.error(`ไม่รู้จักคำสั่ง: ${cmd}\n\n${HELP}`);
    process.exit(2);
  }
  if (after && !RESTORE_OF[id]) {
    console.error('--restore-after ใช้ได้กับ phone-cut (1) / mac-cut (3) เท่านั้น');
    process.exit(2);
  }
  let r = await exec(id);
  if (r.ok && after) r = await countdown(after, RESTORE_OF[id]);
  process.exit(r.ok ? 0 : 1);
}
