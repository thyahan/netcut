// Mac :53/udp -> AdGuard in Docker on 127.0.0.1:1053 (over TCP). Needed because colima's own dnsmasq
// holds port 53 inside the VM, and a phone's DNS setting has no port field. The upstream leg is TCP
// because colima's UDP port forward is unreliable (it disappears after the container is recreated).
import dgram from 'node:dgram';
import net from 'node:net';

const UP_HOST = '127.0.0.1';
const UP_PORT = 1053;

// DNS over TCP = 2-byte length prefix + the same message
function askOverTcp(msg) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(UP_PORT, UP_HOST);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(msg.length);
    let buf = Buffer.alloc(0);
    sock.setTimeout(5000, () => sock.destroy(new Error('timeout')));
    sock.on('connect', () => sock.write(Buffer.concat([len, msg])));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
        resolve(buf.subarray(2, 2 + buf.readUInt16BE(0)));
        sock.end();
      }
    });
    sock.on('error', reject);
  });
}

// resolves true when listening, false if :53 is taken (e.g. another netcut instance already relays)
export function startDnsRelay(log = console.log) {
  return new Promise((resolve) => {
    const srv = dgram.createSocket('udp4');
    srv.on('message', (msg, rinfo) => {
      askOverTcp(msg).then((res) => srv.send(res, rinfo.port, rinfo.address), () => {});
    });
    srv.once('error', (e) => {
      log(`DNS relay: port 53 ถูกใช้อยู่ (${e.code}) — ปกติคือ npm start เปิด relay ไว้แล้ว`);
      resolve(false);
    });
    srv.bind(53, '0.0.0.0', () => {
      log(`DNS relay :53/udp -> ${UP_HOST}:${UP_PORT}/tcp`);
      resolve(true);
    });
  });
}
