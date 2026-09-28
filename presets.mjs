// Network-cut presets for manual vdoc connection-loss testing.
// Phone = USB adb (-d, never wireless). Mac = Wi-Fi power. AdGuard = local container (docker-compose.yml), not homelab.
import { execFile } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { Resolver } from 'node:dns/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const HOSTS = JSON.parse(readFileSync(join(DIR, 'hosts.json'), 'utf8'));
const MARKER = '! netcut temp';
const FLUSH = 'dscacheutil -flushcache; killall -HUP mDNSResponder';
// apps that the "Wi-Fi stays up" cut can block (Android per-app firewall, FIREWALL_CHAIN_OEM_DENY_3)
export const APPS = { chrome: { pkg: 'com.android.chrome', label: 'Chrome (online-self)' }, vdoc: { pkg: 'th.co.truecorp.truevideocallcenter', label: 'vdoc app' } };

let DRY = false;
// '-d' = the one USB device (default, never wireless). '-e' only for testing against an emulator.
const ADB_SEL = process.env.NETCUT_ADB_SELECT || '-d';

function sh(cmd, args, { input, timeout = 20000 } = {}) {
  if (DRY) {
    console.log('$', cmd, ...args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)), input ? `<<< ${input}` : '');
    return Promise.resolve({ code: 0, out: '', err: '' });
  }
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout }, (e, out, err) =>
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out: out.trim(), err: (err || (e && e.message) || '').trim() }),
    );
    if (input !== undefined) child.stdin.end(input);
  });
}
const sleep = (ms) => (DRY ? Promise.resolve(console.log(`# sleep ${ms}ms`)) : new Promise((r) => setTimeout(r, ms)));
const adb = (cmd) => sh('adb', [ADB_SEL, 'shell', cmd]);

let wifiDev;
async function macWifiDev() {
  if (wifiDev) return wifiDev;
  const { out } = await sh('networksetup', ['-listallhardwareports']);
  wifiDev = out.match(/Hardware Port: Wi-Fi\nDevice: (\S+)/)?.[1] || 'en0';
  return wifiDev;
}

// --- AdGuard in colima (docker-compose.yml). Only netcut's rules live there, so disarm = empty list.
const AG_URL = 'http://127.0.0.1:8792';
const AG_DNS = '127.0.0.1:1053';
function agAuth() {
  const f = join(DIR, 'adguard', '.env');
  if (!existsSync(f)) throw new Error('ไม่เจอ adguard/.env — รัน npm start ก่อน');
  const env = Object.fromEntries(readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
  return 'Basic ' + Buffer.from(`${env.ADGUARD_USER}:${env.ADGUARD_PASS}`).toString('base64');
}
async function agGetRules() {
  if (DRY) return (console.log(`$ GET ${AG_URL}/control/filtering/status`), []);
  const r = await fetch(`${AG_URL}/control/filtering/status`, { headers: { authorization: agAuth() }, signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`AdGuard read failed: HTTP ${r.status}`);
  return (await r.json()).user_rules || [];
}
async function agSetRules(rules) {
  if (DRY) return console.log(`$ POST ${AG_URL}/control/filtering/set_rules ${JSON.stringify({ rules })}`);
  const r = await fetch(`${AG_URL}/control/filtering/set_rules`, {
    method: 'POST', headers: { authorization: agAuth(), 'content-type': 'application/json' },
    body: JSON.stringify({ rules }), signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error(`AdGuard set_rules failed: HTTP ${r.status}`);
}
// what AdGuard itself answers (not what a device has cached)
// asked through the Mac's :53 relay (UDP there, TCP to AdGuard) — colima's own UDP forward to 1053 is unreliable
async function agResolve(host) {
  const ip = await getMacIp();
  const res = new Resolver({ timeout: 2000, tries: 1 });
  res.setServers([ip ? `${ip}:53` : AG_DNS]);
  return res.resolve4(host).then((a) => a[0]).catch((e) => e.code);
}
let macIp;
export async function getMacIp() {
  return (macIp ??= (await sh('ipconfig', ['getifaddr', await macWifiDev()])).out || null);
}

const P = {
  // airplane mode kills cellular even where `svc data` is a no-op; Wi-Fi is switched off too because
  // Android may keep Wi-Fi on in airplane mode if the user once enabled it there
  // method 'app': Wi-Fi stays connected, only that app's traffic is dropped (connected-but-no-internet)
  'phone-cut': ({ method = 'airplane', app = 'chrome' } = {}) => {
    if (method === 'app') {
      if (!APPS[app]) throw new Error(`unknown app ${app}`);
      return adb(`cmd connectivity set-chain3-enabled true; cmd connectivity set-package-networking-enabled false ${APPS[app].pkg}`);
    }
    return adb('cmd connectivity airplane-mode enable; svc wifi disable; svc data disable');
  },
  // undoes both methods
  'phone-restore': () =>
    adb(`cmd connectivity airplane-mode disable; svc wifi enable; svc data enable; ${Object.values(APPS).map((a) => `cmd connectivity set-package-networking-enabled true ${a.pkg}`).join('; ')}; cmd connectivity set-chain3-enabled false`),
  'mac-cut': async () => sh('networksetup', ['-setairportpower', await macWifiDev(), 'off']),
  'mac-restore': async () => sh('networksetup', ['-setairportpower', await macWifiDev(), 'on']),

  'vroom-arm': async () => {
    await agSetRules([MARKER, ...HOSTS.vroom.map((h) => `||${h}^`)]);
    let lines = [];
    for (let i = 0; i < 10; i++) {
      await sleep(DRY ? 0 : 500);
      lines = await Promise.all(HOSTS.vroom.map(async (h) => [h, DRY ? '0.0.0.0' : await agResolve(h)]));
      if (lines.every(([, ip]) => ip === '0.0.0.0')) break;
    }
    const ok = lines.every(([, ip]) => ip === '0.0.0.0');
    return {
      code: ok ? 0 : 1,
      out: lines.map(([h, ip]) => `${ip === '0.0.0.0' ? 'BLOCKED' : 'NOT BLOCKED'} ${h}: ${ip}`).join('\n') + (ok ? '\nเครื่องที่ชี้ DNS มาที่ Mac จะเห็นผลภายใน ≤60 วิ (cache)' : ''),
      err: ok ? '' : 'AdGuard ยังไม่ตอบ 0.0.0.0',
    };
  },
  'vroom-disarm': async () => {
    await agSetRules([]);
    return { code: 0, out: 'AdGuard rules cleared', err: '' };
  },

  // agent-side Vroom block: the Mac itself resolves through its own AdGuard. macOS shows its admin dialog.
  // A VPN (True Corp) installs its own default resolver that wins over the Wi-Fi DNS, so the Vroom hosts
  // also get per-domain /etc/resolver files — those beat the default resolver even with the VPN up.
  'mac-dns-block': async () => {
    const ip = await getMacIp();
    if (!ip) throw new Error('หา IP ของ Mac ไม่เจอ — ต่อ Wi-Fi อยู่มั้ย');
    const files = HOSTS.vroom.map((h) => `echo nameserver ${ip} > /etc/resolver/${h}`).join('; ');
    return sh('osascript', ['-e', `do shell script "networksetup -setdnsservers Wi-Fi ${ip}; mkdir -p /etc/resolver; ${files}; ${FLUSH}" with administrator privileges`], { timeout: 120000 });
  },
  'mac-dns-reset': () => {
    const files = HOSTS.vroom.map((h) => `/etc/resolver/${h}`).join(' ');
    return sh('osascript', ['-e', `do shell script "networksetup -setdnsservers Wi-Fi Empty; rm -f ${files}; ${FLUSH}" with administrator privileges`], { timeout: 120000 });
  },

  'restore-all': async () => {
    const res = [];
    for (const id of ['phone-restore', 'mac-restore', 'vroom-disarm']) {
      res.push(await run(id, { dry: DRY }));
    }
    const bad = res.filter((r) => !r.ok);
    return { code: bad.length ? 1 : 0, out: res.map((r) => `${r.id}: ${r.ok ? 'ok' : 'FAIL ' + r.err}`).join('\n'), err: bad.map((r) => r.err).join('; ') };
  },


};

export const IDS = Object.keys(P);

export async function run(id, { dry = false, ...opts } = {}) {
  if (!P[id]) return { id, ok: false, code: 404, out: '', err: `unknown preset ${id}`, ms: 0 };
  DRY = dry;
  const t = Date.now();
  let r;
  try {
    r = await P[id](opts);
  } catch (e) {
    r = { code: 1, out: '', err: e.message };
  }
  return { id, ok: r.code === 0, code: r.code, out: r.out, err: r.err, ms: Date.now() - t };
}

let phoneInfo = null; // cached per serial: { serial, model, android }
async function getPhoneInfo() {
  const serial = (await sh('adb', [ADB_SEL, 'get-serialno'], { timeout: 3000 })).out;
  if (phoneInfo?.serial === serial) return phoneInfo;
  const p = (await adb('echo "$(getprop ro.product.manufacturer)|$(getprop ro.product.model)|$(getprop ro.build.version.release)"')).out.split('|');
  return (phoneInfo = { serial, model: `${p[0] || ''} ${p[1] || ''}`.trim(), android: p[2] || '?' });
}

export async function state() {
  DRY = false; // status is read-only — always query for real
  const dev = await sh('adb', [ADB_SEL, 'get-state'], { timeout: 3000 });
  const adbOk = dev.out === 'device';
  const phone = adbOk
    ? Promise.all([
        getPhoneInfo(),
        adb('settings get global wifi_on'),
        adb('settings get global mobile_data'),
        adb('settings get global airplane_mode_on'),
        adb(`cmd connectivity get-chain3-enabled; ${Object.values(APPS).map((a) => `cmd connectivity get-package-networking-enabled ${a.pkg}`).join('; ')}`),
        adb('cmd wifi status 2>/dev/null | head -2'),
        adb('ping -c1 -W1 1.1.1.1 >/dev/null 2>&1 && echo up || echo down'),
        adb('dumpsys connectivity | grep -o "DnsAddresses: \\[[^]]*\\]" | head -1'),
      ])
    : Promise.resolve([]);
  const [[info, wifi, data, air, fw, wstat, pnet, pdns], mac, mnet, rules, mdns, ip, scutil] = await Promise.all([
    phone,
    macWifiDev().then((d) => sh('networksetup', ['-getairportpower', d])),
    sh('ping', ['-c1', '-t1', '1.1.1.1'], { timeout: 2500 }),
    agGetRules().catch(() => null),
    sh('networksetup', ['-getdnsservers', 'Wi-Fi']),
    getMacIp(),
    sh('scutil', ['--dns']),
  ]);
  const relayUp = ip ? await (async () => { const r = new Resolver({ timeout: 1500, tries: 1 }); r.setServers([`${ip}:53`]); return r.resolve4('example.com').then(() => true, () => false); })() : false;
  const phoneDns = adbOk ? (pdns.out.match(/\[\s*(.*?)\s*\]/)?.[1] || '').replace(/\//g, '').replace(/\s*,\s*/g, ', ') : null;
  const macDns = /There aren't any/.test(mdns.out) ? 'DHCP' : mdns.out.replace(/\n/g, ', ');
  // what the Mac actually uses for the Vroom hosts: the /etc/resolver entry, not the Wi-Fi setting (a VPN overrides that)
  const macResolvers = scutil.out.split(/\n(?=resolver #)/);
  const macViaMac = !!ip && HOSTS.vroom.every((h) => macResolvers.some((r) => r.includes(`domain   : ${h}\n`) && r.includes(`: ${ip}\n`)));
  return {
    adb: adbOk,
    phoneSerial: info?.serial ?? null,
    phoneModel: info?.model ?? null,
    phoneAndroid: info?.android ?? null,
    phoneWifi: adbOk ? wifi.out !== '0' : null,
    phoneSsid: adbOk ? (wstat.out.match(/connected to "([^"]+)"/)?.[1] ?? null) : null,
    phoneData: adbOk ? data.out === '1' : null,
    phoneAirplane: adbOk ? air.out === '1' : null,
    // apps currently cut (chain enabled + deny bit set)
    phoneAppsBlocked: adbOk && /chain:enabled/.test(fw.out) ? Object.entries(APPS).filter(([, a]) => fw.out.includes(`${a.pkg}:deny`)).map(([k]) => k) : [],
    phoneOnline: adbOk ? pnet.out === 'up' : null,
    macWifi: /: On$/.test(mac.out),
    macOnline: mnet.code === 0,
    adguardUp: rules !== null,
    adguardArmed: rules === null ? null : rules.includes(MARKER),
    macIp: ip,
    relayUp,
    phoneDns,
    macDns,
    phoneViaMac: !!(ip && phoneDns?.split(', ').includes(ip)),
    macViaMac,
    // Wi-Fi DNS points at the Mac but the Vroom hosts don't resolve through it (VPN, or set by hand without the button)
    macDnsIgnored: !!(ip && macDns.split(', ').includes(ip)) && !macViaMac,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [flag, id] = process.argv.slice(2);
  const r = await run(flag === '--dry' ? id : flag, { dry: flag === '--dry' });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}
