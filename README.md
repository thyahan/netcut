# NetCut

ปุ่มตัดเน็ตสำหรับ manual test เคสเน็ตหลุดของ vdoc (มือถือ Android ผ่าน USB + MacBook)

```
git clone https://github.com/thyahan/netcut.git ~/netcut && cd ~/netcut
npm start                 # Docker Desktop + AdGuard (docker compose) + DNS relay + หน้าเว็บ http://127.0.0.1:8790
npm run cli -- -w         # (ไม่บังคับ) โหมดคีย์บอร์ดใน terminal
npm run stop              # ปิด AdGuard
```

คู่มือทีละขั้นสำหรับ QA (รวมการเตรียมเครื่องตั้งแต่ติดตั้งโปรแกรม): เปิดไฟล์ `manual.html` ใน browser (ดับเบิลคลิกใน Finder หรือ `open manual.html`)

ไม่ต้องตั้ง port forwarding ใน Docker Desktop · clone ไว้ใต้โฟลเดอร์ home

- ต้องมี: Docker Desktop, `node`, `adb` และมือถือ Android เสียบ USB (เปิด USB debugging) — `npm start` เช็คให้และบอกวิธีติดตั้งถ้าขาด · colima ใช้แทนได้ (ต้องเปิดแบบ `--port-forwarder grpc`)
- AdGuard รับ DNS ที่ port 1053 · `dns-relay.mjs` ส่งต่อจาก port 53 ของ Mac (ใช้ได้ทั้ง Docker Desktop และ colima ซึ่งจอง 53 ใน VM)
- ไฟล์ลับ/ข้อมูล (`adguard/.env`, `adguard/conf`, `adguard/work`, `netcut.log`) ถูกสร้างตอนรันครั้งแรก ไม่ต้องคัดลอกไปเครื่องอื่น

## ตัดเน็ตตอนลูกค้ากด consent (เคสเน็ตหลุดช่วง handshake)

หน้า panel เรียง 3 ขั้น: **ตัดเน็ตใคร** (ลูกค้า · vdoc app / ลูกค้า · Chrome / ลูกค้า · ทั้งเครื่อง / agent · Mac) → **คืนเน็ตเองหลังตัด** → **ตัดเมื่อไหร่** (ตัดตอนนี้ `1` / คืน `2` หรือ ตัดตอนลูกค้ากด consent)

ตาราง session อ่าน `/sessions` บน staging RTDB (read-only, service account ลอกจาก video-call-devtools: `credentials/uat/service-account.json` + `.env.firebase` — ทั้งคู่ gitignore)

1. เลือกตัดใคร และคืนเน็ตเองให้ **เกิน 30 วิ** (default 130) ให้ liveness ตัดสินได้
2. พาลูกค้าไปถึงหน้า consent → session โผล่ในตาราง → กด **ตัดตอน consent**
3. ลูกค้ากด consent → panel ตัดเน็ตทันทีที่ `consent_at` ถูกเขียน (บอกกี่ ms หลัง consent)
4. ผลที่ควรได้: ฝั่งที่ถูกตัดไม่เคยส่ง heartbeat → อีกฝั่งจบด้วย handshake error (`never_received`) ไม่ใช่ `heartbeat_timeout`
   - ตัด agent (Mac): listener ของ panel หลุดไปพร้อม Wi-Fi แต่ยกเลิกการรอก่อนตัดแล้ว และ timer คืนเน็ตยังทำงาน

รอได้ทีละ session · session ที่กด consent แล้วไม่มีปุ่ม · session ถูกลบก่อน consent = ยกเลิกเอง ไม่ตัด

## บล็อก Firebase Realtime Database (เคส online-self ขึ้น "พบปัญหาในการเชื่อมต่อ" ตอนเปิดหน้า)

กล่อง **บล็อก Realtime Database ผ่าน DNS** (ปุ่ม `7` / `8`, CLI `rtdb-arm` / `rtdb-disarm`) ใส่ rule `||firebaseio.com^` ใน AdGuard แยกจาก rule ของ Vroom — บล็อก/ปลดอันหนึ่งไม่กระทบอีกอัน

1. ตั้ง DNS มือถือเป็น IP ของ Mac → กด `7` รอ 60 วิ
2. ปิด Chrome บนมือถือ แล้วเปิด online-self ใหม่ → หน้าเว็บโหลดได้ แต่ `.info/serverTimeOffset` ไม่มา → ขึ้น "พบปัญหาในการเชื่อมต่อ"
3. กด `8` รอ 60 วิ แล้วกดปุ่มลองใหม่ → เข้าหน้าได้

มีผลเฉพาะการเชื่อมต่อใหม่ (ต้องบล็อกก่อนเปิดหน้า) และห้ามบล็อกค้างไว้ตอนเทสต์เคสอื่น เพราะคิว/รับสาย/heartbeat ใช้ Realtime Database ทั้งหมด
