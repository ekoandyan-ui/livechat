# Rencana Fitur End Chat pada Tampilan Pasien

## Tujuan dan aturan perilaku

Menambahkan opsi **End Chat** pada menu Options di tampilan pasien agar pasien dapat menutup sesi konsultasi yang sedang berjalan.

Aturan yang harus dipenuhi:

1. **Tampilan pasien**
   - Opsi End Chat hanya muncul untuk pasien, tidak untuk admin.
   - Memilih opsi menampilkan pop-up konfirmasi.
   - Setelah dikonfirmasi, riwayat percakapan tidak lagi ditampilkan kepada pasien.
   - Pasien dapat mendaftar konsultasi baru, termasuk dengan rumah sakit lain, tanpa terikat percakapan lama.

2. **Tampilan admin**
   - Seluruh riwayat percakapan tetap tersimpan dan dapat dibuka admin sebagai arsip.
   - Data hanya terhapus bila admin menghapusnya secara manual lewat fitur yang sudah ada.
   - Kotak chat dinonaktifkan.
   - Kotak chat diganti keterangan **"Chat telah diakhiri oleh pasien"**.

3. **Konfirmasi**
   - Teks: **"Apakah Anda yakin ingin mengakhiri sesi konsultasi ini?."**
   - Tombol **"Batal"** dan **"Ya, Akhiri Chat"**.

4. **Batasan**
   - End Chat hanya mengubah status sesi dan visibilitas riwayat pada tampilan pasien.
   - Tidak ada penghapusan baris `patients`, `messages`, atau lampiran dari sisi pasien.

## Kondisi kode saat ini yang menjadi dasar rencana

- Satu baris tabel `patients` mewakili satu pasien sekaligus satu room. Room id selalu berbentuk `${rumah_sakit}_${patientId}`.
- `database/schema.sql` sudah memiliki kolom demografi `tanggal_lahir` dan `jenis_kelamin` (BAGIAN 19). Migrasi startup idempoten mengikuti pola `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` dan `DO $$ ... pg_constraint ... END $$;`.
- `server.js`:
  - `sessionIdentity()` (sekitar baris 229) menghasilkan identitas `patient` atau `admin` dari sesi server.
  - `identityCanAccessRoom()` (sekitar baris 247) hanya memeriksa kecocokan room atau rumah sakit. Belum ada pemeriksaan status sesi.
  - Middleware auto-restore sesi pasien dari cookie `dinkes_patient_token` (sekitar baris 1182) mengambil pasien hanya berdasarkan token.
  - `GET /` (sekitar baris 1212) menampilkan overlay "Lanjutkan Chat" bila `req.session.patientRoomId` masih ada.
  - `findExistingPatient()` (sekitar baris 1361) mencari pasien lama lewat token cookie, sesi, lalu nomor WhatsApp + rumah sakit. Semua cabang belum memfilter status sesi.
  - `POST /tambah` (sekitar baris 1417) memakai ulang baris pasien lama bila ditemukan, sehingga konsultasi baru akan menempel ke room lama.
  - `GET /chat/:roomId` (sekitar baris 1558) hanya memeriksa keberadaan pasien dan kepemilikan sesi.
  - `GET /api/messages/:roomId` (sekitar baris 3087), `GET /api/patient-exists/:roomId` (sekitar baris 3121), `POST /api/upload` (sekitar baris 3185), `POST /api/message/delete` (sekitar baris 3323), socket `join-room` (sekitar baris 3730), dan socket `message` (sekitar baris 3793) memakai `identityCanAccessRoom()` tanpa status sesi.
  - `fetchAdminRooms()` (sekitar baris 2871) dan `GET /api/rooms` (sekitar baris 3438) membangun daftar room admin.
  - `GET /admin/room/:patientId` (sekitar baris 2946) mengirim objek `user` lengkap ke `views/admin-room.ejs`.
- `views/partials/chat-actions.ejs` membangun menu titik tiga secara dinamis di `menuButton()` dengan item Cari Pesan, Galeri, dan Dokumen. Partial ini dipakai bersama oleh pasien dan admin, dan `window.__chatCtx.isAdmin` tersedia di kedua halaman.
- `views/chat.ejs` menyimpan sesi tampilan di `localStorage` dengan kunci `dinkes_chat_session`, memiliki listener `chat-deleted`, dan melakukan polling `/api/patient-exists` tiap 20 detik.
- `views/admin-room.ejs` selalu merender composer dan script-nya langsung mengambil `#msgInput` serta `#sendBtn`.
- `views/admin.ejs` merender daftar room, memiliki `syncRooms()` yang memuat ulang `/api/rooms`, serta listener `room-activity` dan `unread-update`.
- `email-worker.js` menyimpan notifikasi di `email_outbox`, menggabungkan baris pending per penerima, dan sudah memiliki `markCancelled(db, row, code)`.
- Event yang sudah ada: `chat-deleted` (admin menghapus total), `room-message`, `messages-deleted`, `room-activity`, `unread-update`. End Chat harus memakai event baru `chat-ended` agar semantiknya tidak tercampur dengan penghapusan admin.

## Keputusan rancangan

### 1. Status sesi disimpan pada baris pasien

Tambahkan dua kolom pada `patients`:

- `chat_ended_at TIMESTAMPTZ NULL` — waktu sesi diakhiri.
- `chat_ended_by TEXT NULL` — pelaku pengakhiran, untuk saat ini `'patient'`; disiapkan juga untuk `'admin'` bila nanti dibutuhkan.

Baris pasien **tidak dihapus**. Nilai `chat_ended_at IS NULL` berarti sesi masih aktif. Ini menjaga arsip admin tetap utuh dan membuat perubahan status bersifat idempoten.

### 2. End Chat adalah aksi pasien yang terotorisasi dan idempoten

Endpoint baru hanya menerima identitas pasien dari sesi server. `roomId` tidak diambil dari body, melainkan dihitung dari `req.session.patientRoomId`. Admin dan pasien lain tidak boleh mengakhiri sesi yang bukan miliknya.

Pengakhiran kedua kali tidak menghasilkan error: `UPDATE ... WHERE chat_ended_at IS NULL` dan respons tetap sukses dengan penanda `alreadyEnded`.

### 3. Server adalah sumber kebenaran, cookie/localStorage hanya pembersihan tampilan

Menghapus cookie dan `localStorage` penting untuk pengalaman pasien, tetapi bukan pengamanan utama. Semua route dan socket tetap memeriksa `chat_ended_at` di database, sehingga tautan lama atau cookie yang masih tersimpan di perangkat lain tidak dapat membuka kembali percakapan.

### 4. Konsultasi baru membuat baris pasien baru

Setelah sesi berakhir, `findExistingPatient()` tidak boleh mengembalikan baris yang sudah ended. Pendaftaran berikutnya membuat baris `patients` baru dengan token baru dan room baru, sehingga:

- pasien dapat memilih rumah sakit yang sama maupun berbeda;
- riwayat lama tetap menjadi arsip terpisah;
- admin melihat dua room: satu berstatus diakhiri, satu aktif.

### 5. Tampilan pasien dan arsip admin dipisahkan

- Pasien diarahkan ke `/` setelah End Chat. `/chat/:roomId` lama akan menolak akses.
- Admin tetap dapat membuka `/admin/room/:patientId`, melihat seluruh pesan, tetapi composer diganti keterangan.
- Admin tetap dapat memakai `POST /api/room/delete` atau `POST /api/patient/delete` untuk penghapusan manual seperti sekarang.

### 6. Notifikasi email ikut dihentikan

Saat sesi berakhir:

- baris `email_outbox` yang masih `pending` untuk room/pasien tersebut dibatalkan dengan kode `chat_ended`;
- worker tidak boleh membuat notifikasi baru untuk penerima pasien pada room yang sudah ended;
- notifikasi admin untuk pesan lama tidak perlu diubah, karena tidak akan ada pesan baru setelah sesi berakhir.

## Rencana implementasi

### Tahap 1 — Skema dan migrasi database

1. `database/schema.sql`
   - Tambahkan `chat_ended_at TIMESTAMPTZ` dan `chat_ended_by TEXT` pada `CREATE TABLE IF NOT EXISTS patients`.
   - Tambahkan BAGIAN baru setelah BAGIAN 19:
     ```sql
     ALTER TABLE patients ADD COLUMN IF NOT EXISTS chat_ended_at TIMESTAMPTZ;
     ALTER TABLE patients ADD COLUMN IF NOT EXISTS chat_ended_by TEXT;
     ```
   - Tambahkan constraint idempoten `chk_patients_chat_ended_by` dengan nilai yang diizinkan `('patient','admin')`, mengikuti pola `pg_constraint` yang sudah dipakai `chk_patients_jenis_kelamin`.
   - Opsional: indeks parsial untuk mempercepat pencarian sesi aktif:
     ```sql
     CREATE INDEX IF NOT EXISTS idx_patients_active
       ON patients (rumah_sakit, id) WHERE chat_ended_at IS NULL;
     ```

2. `server.js`
   - Tambahkan migrasi startup idempoten untuk kedua kolom dan constraint, lalu log sekali, misalnya `Kolom status End Chat siap.`
   - Migrasi harus aman dijalankan berulang dan tidak mengubah data pasien lama (semua tetap dianggap aktif karena `chat_ended_at` bernilai `NULL`).

### Tahap 2 — Helper status dan endpoint pengakhiran

1. Tambahkan helper terpusat, misalnya:
   - `roomSessionEnded(patient)` → `Boolean(patient && patient.chat_ended_at)`.
   - `getPatientByRoomId(roomId)` bila diperlukan untuk pemeriksaan route/socket.
   - `assertActiveRoomForIdentity(id, roomId)` → selalu `true` untuk admin; untuk pasien memeriksa baris pasien dan `chat_ended_at IS NULL`.

2. Tambahkan route:

   ```
   POST /api/chat/end
   Header: x-csrf-token
   Body: tidak memerlukan roomId
   ```

   Alur:
   1. Ambil `id = sessionIdentity(req)`.
   2. Tolak bila `id.type !== 'patient'` atau tidak ada `id.roomId` → `403 { error: 'Akses ditolak.' }`.
   3. Parse `patientId` dari `id.roomId`.
   4. Jalankan transaksi:
      - `SELECT id, rumah_sakit, chat_ended_at FROM patients WHERE id = $1 FOR UPDATE`.
      - Pastikan `${rumah_sakit}_${id}` sama dengan `id.roomId`.
      - `UPDATE patients SET chat_ended_at = NOW(), chat_ended_by = 'patient' WHERE id = $1 AND chat_ended_at IS NULL RETURNING chat_ended_at`.
      - `UPDATE email_outbox SET status = 'cancelled', last_error_code = 'chat_ended', updated_at = NOW() WHERE status = 'pending' AND (room_id = $2 OR (recipient_type = 'patient' AND recipient_id = $1))`.
   5. Setelah commit, emit `chat-ended` ke room dan kanal admin rumah sakit:
      ```js
      io.to(roomId).emit("chat-ended", {
        roomId,
        patientId,
        endedAt,
        endedBy: "patient",
      });
      io.to(ADMIN_CHAN(rumahSakit)).emit("chat-ended", {
        roomId,
        patientId,
        endedAt,
        endedBy: "patient",
      });
      ```
   6. Bersihkan identitas pasien:
      - `clearPatientCookie(res)`;
      - hapus `req.session.patientRoomId`, `patientName`, `patientRumahSakit`, `patientToken`;
      - regenerasi sesi dan buat `csrfToken` baru agar sesi lama tidak dapat dipakai ulang.
   7. Respons `200 { ok: true, redirect: '/', endedAt, alreadyEnded }`.

3. Idempotensi:
   - Bila `chat_ended_at` sudah terisi, tetap balas `200` dengan `alreadyEnded: true`, tanpa menggandakan efek samping.
   - Tetap jalankan pembatalan outbox pending agar baris yang tertinggal ikut dibersihkan.

### Tahap 3 — Penolakan akses pasien ke sesi yang sudah berakhir

Periksa `chat_ended_at` pada semua jalur berikut. Admin selalu dikecualikan agar arsip tetap dapat dibuka.

1. `GET /chat/:roomId`
   - Setelah `SELECT * FROM patients WHERE id = $1`, bila `roomSessionEnded(user)`:
     - bersihkan cookie dan kunci sesi pasien;
     - redirect ke `/`.
   - Jangan merender riwayat pesan.

2. `GET /api/messages/:roomId`
   - Untuk identitas pasien, bila room sudah ended → `410 { error: 'Sesi konsultasi telah diakhiri.', code: 'CHAT_ENDED' }`.
   - Admin tetap mendapat pesan arsip.

3. `GET /api/patient-exists/:roomId`
   - Ambil juga `chat_ended_at`.
   - Untuk pasien pemilik: bila ended → `{ exists: false, ended: true }` agar polling di `chat.ejs` memicu pembersihan dan redirect.
   - Untuk admin: `{ exists: true, ended: true, userName }` agar status arsip tetap informatif.

4. `POST /api/upload` dan `POST /api/message/delete`
   - Setelah `identityCanAccessRoom`, panggil `assertActiveRoomForIdentity`.
   - Pasien pada room ended → `410 { code: 'CHAT_ENDED' }`.
   - Admin tetap boleh menghapus pesan arsip secara manual.

5. Socket `join-room`
   - Bila identitas pasien dan room sudah ended: jangan `socket.join(roomId)`, emit `chat-ended` ke socket tersebut.
   - Admin tetap join untuk membaca arsip.

6. Socket `message`
   - Setelah validasi room, untuk identitas pasien periksa `chat_ended_at`.
   - Bila ended, balas `ack({ ok: false, code: 'CHAT_ENDED', error: 'Sesi konsultasi telah diakhiri.' })`.
   - Admin juga ditolak mengirim pesan ke room ended (sesuai requirement komposer dinonaktifkan), tetapi tetap boleh membaca dan menghapus.

7. Opsional, pengetatan akses lampiran:
   - `GET /api/file/:id` saat ini mengambil file berdasarkan id pesan. Bila ingin privasi penuh, tambahkan pemeriksaan identitas dan tolak pasien untuk room ended. Ini bukan syarat utama karena tampilan pasien sudah diarahkan keluar, tetapi layak dicatat sebagai tindak lanjut keamanan.

### Tahap 4 — Auto-restore, resume, dan pendaftaran ulang

1. Middleware auto-restore (sekitar baris 1182)
   - Ubah query token menjadi `WHERE patient_token = $1 AND chat_ended_at IS NULL`.
   - Bila token valid tetapi sesi sudah ended → `clearPatientCookie(res)`, jangan isi `req.session` pasien.

2. `GET /`
   - Query `activePatient` menjadi `WHERE id = $1 AND chat_ended_at IS NULL`.
   - Bila ended → bersihkan sesi/cookie, `activePatient` tetap `null`, overlay "Lanjutkan Chat" tidak muncul.

3. `findExistingPatient()`
   - Tambahkan `chat_ended_at IS NULL` pada ketiga query: token cookie, sesi, dan nomor WhatsApp + rumah sakit.
   - Dengan begitu, pendaftaran baru setelah End Chat selalu jatuh ke jalur INSERT dan membuat baris baru.
   - Tidak perlu mengubah `house_sakit` pada baris lama.

4. `POST /tambah`
   - Tidak perlu perubahan besar. Jalur `existingPatient` hanya akan menerima pasien aktif.
   - Pastikan setelah INSERT baris baru, event `room-activity` tetap dikirim ke admin rumah sakit yang dipilih.

5. Catatan konsistensi
   - Jangan memakai ulang token pasien lama untuk konsultasi baru. Token baru sudah dibuat pada jalur INSERT.
   - Jangan mengubah `nomor_wa` atau data demografi baris lama; data itu adalah bagian arsip.

### Tahap 5 — UI pasien: menu Options dan dialog konfirmasi

1. `views/partials/chat-actions.ejs`
   - Tambahkan ikon `SVG.end` (misalnya ikon power/keluar) dan item menu:
     ```js
     if (!(window.__chatCtx && window.__chatCtx.isAdmin)) {
       items.push({
         k: "end",
         label: "End Chat",
         icon: SVG.end,
         act: openEndChat,
       });
     }
     ```
   - Item hanya dirender untuk pasien. Admin tidak melihat opsi ini.
   - Gaya item dapat memakai kelas khusus, misalnya `ct-menu-item ct-menu-danger`, dengan warna merah halus agar berbeda dari item navigasi biasa.

2. Dialog konfirmasi
   - Buat satu dialog yang dipakai ulang, mengikuti pola modal yang sudah ada di `chat-actions.ejs`.
   - Isi:
     - Judul, misalnya "Akhiri Sesi Konsultasi".
     - Teks persis: **"Apakah Anda yakin ingin mengakhiri sesi konsultasi ini?."**
     - Tombol **"Batal"** dan **"Ya, Akhiri Chat"**.
   - Tombol Batal menutup dialog tanpa perubahan.
   - Tombol "Ya, Akhiri Chat":
     - nonaktifkan tombol selama proses untuk mencegah klik ganda;
     - kirim `POST /api/chat/end` dengan header `x-csrf-token` dari `<meta name="csrf-token">`;
     - bila sukses: `localStorage.removeItem('dinkes_chat_session')`, lalu `window.location.href = '/'`;
     - bila gagal: tampilkan pesan kesalahan singkat, aktifkan kembali tombol, dan jangan hapus apa pun.

3. `views/chat.ejs`
   - Tambahkan listener `chat-ended`:
     - hapus `dinkes_chat_session`;
     - arahkan ke `/`.
   - Listener ini menangani kasus sesi diakhiri dari tab lain atau perangkat lain.
   - Polling `/api/patient-exists` yang sudah ada akan menjadi jaring pengaman bila socket terputus.

4. Setelah redirect ke `/`
   - Form pendaftaran tampil tanpa overlay resume.
   - Pasien dapat memilih rumah sakit yang sama atau berbeda.
   - Data demografi diisi ulang dan membuat baris pasien baru.

### Tahap 6 — UI admin: arsip tetap terbaca, composer dinonaktifkan

1. `server.js` — `GET /admin/room/:patientId`
   - Objek `user` sudah memuat `chat_ended_at`; tidak perlu query tambahan.
   - Kirim juga `isChatEnded` dan `chatEndedAt` melalui `data-ctx` agar script dapat menginisialisasi tampilan.

2. `views/admin-room.ejs`
   - Tambahkan CSS untuk banner dan keterangan:
     ```css
     .chat-ended-note {
       display: flex;
       align-items: center;
       justify-content: center;
       color: var(--subtle);
       font-size: 14px;
       font-weight: 600;
       text-align: center;
       min-height: 46px;
     }
     ```
   - Bila `isChatEnded`:
     - tetap render semua pesan;
     - ganti isi `.chat-input` dengan **"Chat telah diakhiri oleh pasien"**;
     - jangan tampilkan input, tombol lampiran, emoji, maupun tombol kirim;
     - tampilkan penanda kecil di header, misalnya "Diakhiri".
   - Script:
     - tambahkan `function showChatEnded()` yang mengisi `.chat-input`, menonaktifkan `msgInput`/`sendBtn` bila masih ada, dan memasang `window.__chatEnded = true`;
     - panggil `showChatEnded()` saat inisialisasi bila `ctx.isChatEnded`;
     - pada `doSend()`, hentikan lebih awal bila `window.__chatEnded`;
     - tambahkan listener `socket.on('chat-ended', ...)` yang memanggil `showChatEnded()` bila `payload.roomId === roomId`;
     - listener ini membuat composer langsung nonaktif saat pasien menekan End Chat, tanpa admin perlu me-refresh.
   - Jangan mengubah `messages` atau memanggil `messages-deleted` saat event `chat-ended` diterima.

3. Penghapusan manual oleh admin
   - `POST /api/message/delete` tetap berfungsi untuk pesan arsip.
   - `POST /api/room/delete` dan `POST /api/patient/delete` tetap menjadi satu-satunya jalur penghapusan data.
   - Tidak ada perubahan pada `deletePatientFully()`.

### Tahap 7 — Sidebar admin dan detail pasien

1. `server.js` — `fetchAdminRooms()`
   - Tambahkan ke objek room:
     - `isEnded: Boolean(user.chat_ended_at)`;
     - `chatEndedAt: user.chat_ended_at || null`.
   - `GET /api/rooms` otomatis membawa field tersebut karena memakai `fetchAdminRooms()`.

2. `views/admin.ejs`
   - Render badge kecil **"Diakhiri"** pada item room yang `room.isEnded`.
   - Tambahkan badge yang sama pada `buildItem()` agar hasil `syncRooms()` konsisten.
   - Tambahkan listener `socket.on('chat-ended', ...)` yang memanggil `syncRooms()` supaya status pada sidebar berubah real-time.
   - Badge belum dibaca tidak perlu ditampilkan untuk room ended. `bumpUnread()` juga sebaiknya melewati room ended agar tidak ada badge yang tidak bisa dibuka untuk membalas.

3. Opsional: `views/admin-patient.ejs`
   - Tampilkan baris status "Chat diakhiri pada ..." bila `chat_ended_at` ada, agar admin tahu konteks arsip.

### Tahap 8 — Email worker dan event realtime

1. `email-worker.js`
   - Pada cabang penerima pasien, tambahkan syarat `AND chat_ended_at IS NULL` pada query `SELECT id, email FROM patients ...`.
   - Bila penerima pasien sudah ended, jangan queue dan batalkan baris pending dengan kode `chat_ended`.
   - Pada `processRow` cabang pasien, bila baris pasien sudah ended → `markCancelled(db, row, 'chat_ended')`.
   - Tidak perlu mengubah format email, pengirim, atau isi pesan.

2. `server.js`
   - Endpoint End Chat membatalkan outbox pending seperti pada Tahap 2.
   - `bumpUnread()` dapat menambahkan filter room ended, meskipun secara praktik tidak akan ada pesan baru setelah sesi berakhir.
   - `queueEmailForMessage()` tidak perlu diubah selain efek query worker di atas.

3. Event realtime
   - `chat-ended` hanya untuk memberi tahu perubahan status.
   - `chat-deleted` tetap khusus penghapusan total oleh admin.
   - Jangan memakai `chat-deleted` untuk End Chat karena handler pasien akan menghapus `localStorage` dan redirect tanpa membedakan arsip admin.

## Perubahan per file

| File                              | Perubahan                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `database/schema.sql`             | Kolom `chat_ended_at`, `chat_ended_by`, constraint, BAGIAN migrasi baru, indeks opsional.                                                                                                                                                                                                                                                                   |
| `server.js`                       | Migrasi startup; helper status; endpoint `POST /api/chat/end`; filter ended pada `/`, auto-restore, `/tambah`/`findExistingPatient`, `/chat/:roomId`, `/api/messages`, `/api/patient-exists`, `/api/upload`, `/api/message/delete`; pemeriksaan socket `join-room`/`message`; field `isEnded` pada `fetchAdminRooms`; emit `chat-ended`; pembatalan outbox. |
| `email-worker.js`                 | Filter `chat_ended_at IS NULL` untuk penerima pasien; `markCancelled(..., 'chat_ended')`.                                                                                                                                                                                                                                                                   |
| `views/partials/chat-actions.ejs` | Item menu End Chat khusus pasien; dialog konfirmasi; pemanggilan endpoint; pembersihan `localStorage` dan redirect.                                                                                                                                                                                                                                         |
| `views/chat.ejs`                  | Listener `chat-ended` untuk redirect; penyesuaian bila diperlukan agar dialog/menu memakai konteks pasien.                                                                                                                                                                                                                                                  |
| `views/admin-room.ejs`            | `data-ctx` status ended; keterangan "Chat telah diakhiri oleh pasien"; composer dinonaktifkan; listener `chat-ended`.                                                                                                                                                                                                                                       |
| `views/admin.ejs`                 | Badge "Diakhiri" pada render server dan `buildItem()`; listener `chat-ended` → `syncRooms()`.                                                                                                                                                                                                                                                               |
| `views/admin-patient.ejs`         | Opsional: status arsip "Chat diakhiri pada ...".                                                                                                                                                                                                                                                                                                            |
| `outputs/plan-end-chat-pasien.md` | Dokumen rencana ini.                                                                                                                                                                                                                                                                                                                                        |

## Edge case dan keputusan penanganan

| Skenario                                                              | Perilaku yang diharapkan                                                                                       |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Pasien menekan End Chat dua kali / request ganda                      | Endpoint idempoten; respons sukses; tidak ada duplikasi efek.                                                  |
| Pasien menutup tab sebelum request selesai                            | Tidak ada perubahan status; sesi tetap aktif.                                                                  |
| Admin sedang membuka room saat pasien End Chat                        | Event `chat-ended` menonaktifkan composer dan menampilkan keterangan tanpa reload. Pesan arsip tetap terlihat. |
| Admin mengirim pesan tepat setelah End Chat                           | Server menolak dengan `CHAT_ENDED`; UI admin sudah nonaktif.                                                   |
| Pesan terkirim tepat sebelum End Chat                                 | Pesan tersimpan dan menjadi bagian arsip. Outbox pending dibatalkan.                                           |
| Pasien membuka tautan `/chat/:roomId` lama                            | Ditolak dan diarahkan ke `/`, meskipun cookie lama masih ada.                                                  |
| Cookie pasien lama masih ada di perangkat lain                        | Auto-restore mengabaikan token untuk sesi ended; semua API/socket menolak.                                     |
| Pasien mendaftar lagi dengan nomor WhatsApp dan rumah sakit yang sama | Baris pasien baru dibuat; baris lama tetap ended dan menjadi arsip.                                            |
| Pasien mendaftar dengan rumah sakit berbeda                           | Baris pasien baru dibuat; tidak memakai token/sesi room lama.                                                  |
| Overlay "Lanjutkan Chat" setelah End Chat                             | Tidak muncul karena sesi/cookie dibersihkan dan `/` memfilter sesi ended.                                      |
| Admin menghapus room ended secara manual                              | Data terhapus lewat jalur admin yang sudah ada; pasien sudah tidak terhubung.                                  |
| Socket pasien terputus saat End Chat                                  | Polling `/api/patient-exists` mengembalikan `exists: false` dan halaman diarahkan ke `/`.                      |
| Email notifikasi masih pending saat End Chat                          | Baris outbox dibatalkan dengan kode `chat_ended`; tidak ada email terkirim.                                    |
| Admin membuka arsip room ended                                        | Semua pesan, lampiran, dan metadata tetap dapat dibaca; composer tidak tersedia.                               |
| Pasien mengakses `/api/file/:id` langsung                             | Di luar cakupan utama; dicatat sebagai opsi pengetatan keamanan pada Tahap 3.                                  |

## Pengujian dan kriteria penerimaan

### Pemeriksaan statis dan migrasi

1. `node --check server.js` berhasil.
2. `node --check email-worker.js` berhasil.
3. Migrasi startup berjalan dua kali tanpa error dan hanya mencatat log sekali.
4. Query `information_schema.columns` menunjukkan `chat_ended_at` dan `chat_ended_by` ada.
5. Constraint `chk_patients_chat_ended_by` ada dan menolak nilai di luar `patient`/`admin`.
6. Semua pasien lama memiliki `chat_ended_at IS NULL` sehingga tetap aktif.

### Pengujian pasien

1. Menu Options pasien menampilkan **End Chat**; menu admin tidak menampilkannya.
2. Dialog menampilkan teks dan dua tombol persis sesuai permintaan.
3. Tombol Batal menutup dialog dan chat tetap dapat dipakai.
4. Tombol "Ya, Akhiri Chat" mengakhiri sesi, menghapus `localStorage`, dan mengarahkan ke `/`.
5. Setelah redirect, form pendaftaran tampil tanpa overlay resume.
6. `/chat/:roomId` lama mengarah ke `/`.
7. `/api/messages`, `/api/upload`, `/api/message/delete`, dan socket `message` menolak dengan kode `CHAT_ENDED`.
8. `GET /api/patient-exists` untuk room ended mengembalikan `exists: false`.
9. End Chat kedua kali tetap sukses dan tidak mengubah `chat_ended_at` pertama.
10. Request tanpa CSRF → `403`.
11. Request dari sesi admin atau pasien lain → `403`.

### Pengujian admin

1. Room ended tetap muncul di sidebar dengan badge "Diakhiri".
2. Membuka `/admin/room/:patientId` menampilkan seluruh riwayat.
3. Composer diganti teks **"Chat telah diakhiri oleh pasien"**.
4. Bila pasien End Chat saat admin membuka room, perubahan tampilan terjadi tanpa reload.
5. Admin tidak dapat mengirim pesan ke room ended.
6. Admin tetap dapat menghapus pesan atau menghapus room secara manual.
7. `/api/rooms` memuat `isEnded` dan `chatEndedAt`.

### Pengujian konsultasi baru

1. Daftar ulang setelah End Chat dengan nomor WhatsApp dan rumah sakit yang sama menghasilkan `patients.id` baru.
2. Daftar dengan rumah sakit berbeda menghasilkan baris baru dan room baru.
3. Baris lama tetap memiliki `chat_ended_at` dan riwayat pesan yang utuh.
4. Token baru tidak sama dengan token lama.
5. Admin melihat room lama (arsip) dan room baru (aktif) secara terpisah.

### Pengujian email dan regresi

1. Buat pesan yang menghasilkan outbox pending, lalu End Chat sebelum delay → status menjadi `cancelled` dengan `last_error_code = 'chat_ended'`; tidak ada email terkirim.
2. Pesan pada sesi aktif tetap menghasilkan notifikasi seperti sebelumnya.
3. Chat aktif yang belum diakhiri tidak mengalami perubahan perilaku.
4. `chat-deleted` dari admin tetap menghapus tampilan pasien dan mengarahkan ke `/`.
5. Rate limiter, `trust proxy`, dan konfigurasi `.env` tidak berubah.

## Risiko dan batasan

- **Partial menu dipakai bersama.** Risiko utama adalah opsi End Chat muncul di tampilan admin. Mitigasi: guard `ctx.isAdmin` dan pengujian visual pada kedua halaman.
- **Script admin-room mengasumsikan composer selalu ada.** Mitigasi: jangan menghapus elemen dari DOM; ganti isi `.chat-input` dan tambahkan guard `window.__chatEnded` pada pengiriman.
- **Pemeriksaan status harus konsisten.** Bila satu route terlewat, pasien dapat membaca atau mengirim pesan setelah End Chat. Mitigasi: helper terpusat dan daftar route/socket pada Tahap 3.
- **Arsip tumbuh tanpa batas.** Sesuai requirement, data hanya dihapus manual oleh admin. Perlu kesadaran operasional, bukan perubahan otomatis pada fitur ini.
- **Akses file langsung.** `/api/file/:id` belum memeriksa identitas. End Chat menyembunyikan riwayat dari UI pasien, tetapi pengetatan endpoint file sebaiknya direncanakan terpisah.
- **Multi-instance.** Presence dan socket saat ini bersifat satu instance. Endpoint End Chat tetap aman karena status disimpan di database, tetapi event realtime lintas instance memerlukan adapter Socket.IO bila nanti diskalakan.
- **Tidak ada perubahan pada limiter, `trust proxy`, `.env*`, atau `admins.seed.json`.** Semua perubahan bersifat aplikasi dan skema.

## Urutan kerja yang disarankan

1. Tambahkan kolom dan migrasi database.
2. Tambahkan helper status dan endpoint `POST /api/chat/end`.
3. Tutup akses pasien pada route dan socket.
4. Perbarui auto-restore, `/`, `findExistingPatient`, dan alur pendaftaran ulang.
5. Tambahkan menu dan dialog End Chat pada tampilan pasien.
6. Nonaktifkan composer dan tampilkan keterangan pada tampilan admin.
7. Tambahkan badge sidebar dan listener realtime.
8. Hentikan outbox pending dan tambahkan filter pada worker email.
9. Jalankan seluruh pengujian dan pastikan chat aktif tidak mengalami regresi.

> Dokumen ini hanya rencana. Belum ada perubahan kode yang dilakukan. Jangan commit/push, dan jangan menyentuh `.env*` atau `admins.seed.json`.
