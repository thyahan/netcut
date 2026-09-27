#!/bin/bash
# npm start: colima -> AdGuard (docker compose) -> first-run AdGuard setup -> netcut web + DNS relay
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p adguard/conf adguard/work

need() { command -v "$1" >/dev/null || { echo "✘ ไม่มี $1 — ติดตั้ง: $2"; exit 1; }; }
need node   "brew install node"
need adb    "brew install --cask android-platform-tools"
need docker "ติดตั้ง Docker Desktop: brew install --cask docker (หรือโหลดจาก docker.com)"

# Docker Desktop first; colima as a fallback
if ! docker info >/dev/null 2>&1; then
  if [ -d /Applications/Docker.app ]; then
    echo "starting Docker Desktop…"
    open -a Docker
    for i in $(seq 1 90); do docker info >/dev/null 2>&1 && break; sleep 2; done
  elif command -v colima >/dev/null; then
    echo "starting colima…"
    colima start --port-forwarder grpc --network-host-addresses --cpus 2 --memory 2
  fi
  docker info >/dev/null 2>&1 || { echo "✘ Docker ยังไม่ทำงาน — เปิด Docker Desktop แล้วรัน npm start อีกครั้ง"; exit 1; }
fi
docker compose version >/dev/null 2>&1 || { echo "✘ ไม่มี docker compose — อัปเดต Docker Desktop"; exit 1; }
docker compose up -d

if [ ! -f adguard/conf/AdGuardHome.yaml ]; then
  echo "first run: configuring AdGuard…"
  for i in $(seq 1 30); do curl -s -o /dev/null -m 2 http://127.0.0.1:3300/ && break; sleep 1; done
  PASS=$(openssl rand -hex 16)
  (umask 077; printf 'ADGUARD_USER=netcut\nADGUARD_PASS=%s\n' "$PASS" > adguard/.env)
  curl -sf -m 10 -H 'Content-Type: application/json' http://127.0.0.1:3300/control/install/configure \
    -d "{\"web\":{\"ip\":\"0.0.0.0\",\"port\":80},\"dns\":{\"ip\":\"0.0.0.0\",\"port\":53},\"username\":\"netcut\",\"password\":\"$PASS\"}" >/dev/null
fi
for i in $(seq 1 30); do curl -s -o /dev/null -m 2 http://127.0.0.1:8792/ && break; sleep 1; done
if ! dig @127.0.0.1 -p 1053 +tcp +short +time=2 +tries=3 example.com | grep -q .; then
  echo "✘ AdGuard ไม่ตอบ DNS ที่ port 1053 — ดู log: docker logs netcut-adguard"
  exit 1
fi

exec node server.mjs
