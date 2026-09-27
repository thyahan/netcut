// Mac :53/udp -> AdGuard in colima on 127.0.0.1:1053. Needed because colima's own dnsmasq
// holds port 53 inside the VM, and a phone's DNS setting has no port field.
import dgram from 'node:dgram';

const UP_HOST = '127.0.0.1';
const UP_PORT = 1053;

// resolves true when listening, false if :53 is taken (e.g. another netcut instance already relays)
export function startDnsRelay(log = console.log) {
  return new Promise((resolve) => {
    const srv = dgram.createSocket('udp4');
    srv.on('message', (msg, rinfo) => {
      const up = dgram.createSocket('udp4');
      const t = setTimeout(() => up.close(), 5000);
      up.on('message', (res) => {
        srv.send(res, rinfo.port, rinfo.address);
        clearTimeout(t);
        up.close();
      });
      up.send(msg, UP_PORT, UP_HOST);
    });
    srv.once('error', (e) => {
      log(`DNS relay: port 53 ถูกใช้อยู่ (${e.code}) — ปกติคือ npm start เปิด relay ไว้แล้ว`);
      resolve(false);
    });
    srv.bind(53, '0.0.0.0', () => {
      log(`DNS relay :53/udp -> ${UP_HOST}:${UP_PORT}`);
      resolve(true);
    });
  });
}
