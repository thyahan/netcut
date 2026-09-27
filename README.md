# NetCut

ปุ่มตัดเน็ตสำหรับ manual test เคสเน็ตหลุดของ vdoc (มือถือ Android ผ่าน USB + MacBook)

```
git clone git@github.com:thyahan/netcut.git && cd netcut
npm start                 # Docker Desktop + AdGuard (docker compose) + DNS relay + หน้าเว็บ http://127.0.0.1:8790
npm run cli -- -w         # (ไม่บังคับ) โหมดคีย์บอร์ดใน terminal
npm run stop              # ปิด AdGuard
```

คู่มือทีละขั้นสำหรับ QA: เปิดไฟล์ `manual.html` ใน browser (ดับเบิลคลิกใน Finder หรือ `open manual.html`)

ไม่ต้องตั้ง port forwarding ใน Docker Desktop · clone ไว้ใต้โฟลเดอร์ home

- ต้องมี: Docker Desktop, `node`, `adb` และมือถือ Android เสียบ USB (เปิด USB debugging) — `npm start` เช็คให้และบอกวิธีติดตั้งถ้าขาด · colima ใช้แทนได้ (ต้องเปิดแบบ `--port-forwarder grpc`)
- AdGuard รับ DNS ที่ port 1053 · `dns-relay.mjs` ส่งต่อจาก port 53 ของ Mac (ใช้ได้ทั้ง Docker Desktop และ colima ซึ่งจอง 53 ใน VM)
- ไฟล์ลับ/ข้อมูล (`adguard/.env`, `adguard/conf`, `adguard/work`, `netcut.log`) ถูกสร้างตอนรันครั้งแรก ไม่ต้องคัดลอกไปเครื่องอื่น
