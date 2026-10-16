# Rencana Notifikasi Pesan Baru saat Web Ditutup

## Tujuan

Memberi tahu pasien atau admin tentang pesan baru ketika tidak ada tab aplikasi yang sedang aktif, termasuk saat browser berada di latar belakang atau—jika browser dan sistem operasi mendukung—sudah ditutup. Mekanismenya adalah **Web Push API + Service Worker**, bukan Socket.IO saja.

Notifikasi bersifat upaya terbaik: browser, sistem operasi, izin pengguna, koneksi, dan kebijakan baterai dapat menunda atau mencegah pengiriman. Notifikasi tidak boleh menjadi saluran komunikasi darurat atau satu-satunya sumber informasi; chat dan badge pesan belum dibaca tetap menjadi sumber utama.

## Kondisi aplikasi saat ini yang menjadi dasar rencana

- Aplikasi memakai Express, EJS, PostgreSQL, dan Socket.IO.
- Pesan chat disimpan di tabel `messages` pada event Socket.IO, lalu disiarkan ke room.
- Identitas pasien/admin dan batas akses rumah sakit tersedia dari sesi server; akses room sudah diperiksa berdasarkan identitas dan rumah sakit.
- Belum terlihat direktori `public`, manifest PWA, service worker, atau pustaka Web Push pada project.
- Redis untuk sesi saat ini opsional dan aplikasi dapat jatuh kembali ke MemoryStore. Untuk membuka link notifikasi secara andal setelah restart atau pada beberapa instance, sesi produksi perlu memakai store persisten (misalnya Redis) dan `SESSION_SECRET` yang konsisten.

## Rekomendasi arsitektur

1. Browser meminta izin notifikasi setelah pengguna menekan tombol **Aktifkan notifikasi**.
2. Browser mendaftarkan service worker dan membuat push subscription.
3. Server memvalidasi identitas sesi, lalu menyimpan subscription yang terikat ke pasien atau admin yang sah.
4. Saat pesan sudah berhasil disimpan di PostgreSQL, server menentukan penerima yang berhak dan mengirim push ke subscription penerima—bukan pengirim.
5. Service worker menerima push di latar belakang dan menampilkan notifikasi generik.
6. Jika notifikasi ditekan, browser membuka halaman chat yang sesuai; server tetap memeriksa sesi dan hak akses sebelum menampilkan percakapan.

## Tahapan implementasi

### Tahap 1 — Tetapkan perilaku produk dan dukungan perangkat

Sebelum coding, sepakati:

- Apakah push diaktifkan pasien, admin, atau keduanya. **Saran:** keduanya, dengan pilihan opt-in terpisah.
- Pesan pasien dikirim ke admin mana. **Saran awal:** hanya admin aktif yang sudah opt-in dan berwenang pada rumah sakit yang tercantum di room; jangan menyiarkan lintas rumah sakit. Jika kelak ada penugasan admin per room, gunakan daftar admin yang ditugaskan.
- Apakah push dikirim hanya saat tidak ada tab yang terlihat, atau juga saat tab terbuka tetapi tidak fokus. **Saran:** ketika tidak ada tab chat untuk room tersebut yang terlihat; jika tab relevan sedang aktif, cukup gunakan Socket.IO.
- Browser dan perangkat minimum yang harus didukung. Web Push memerlukan browser yang mendukung API, izin notifikasi, dan HTTPS; pada sebagian perangkat mobile, pengguna mungkin perlu memasang aplikasi ke Home Screen. Verifikasi persyaratan spesifik browser/OS yang akan dipakai saat implementasi.

### Tahap 2 — Prasyarat HTTPS dan PWA

1. Pastikan domain aplikasi produksi memakai HTTPS. `localhost` dapat dipakai untuk pengembangan, tetapi bukan pengganti pengujian push di domain produksi.
2. Buat direktori `public/` dan aktifkan `express.static` dengan konfigurasi aman di `server.js`.
3. Tambahkan `public/service-worker.js` pada URL tingkat root (`/service-worker.js`) agar cakupan service worker dapat meliputi halaman pasien dan admin.
4. Tambahkan `public/manifest.webmanifest`, ikon aplikasi, nama/warna tema, dan `display: standalone` untuk dukungan pengalaman PWA.
5. Tautkan manifest dan registrasikan service worker pada halaman yang perlu menerima push.
6. Atur kebijakan cache service worker dengan hati-hati. Jangan cache halaman chat yang berisi data pasien, API, atau halaman admin.

### Tahap 3 — Izin dan kendali pengguna

1. Tambahkan tombol **Aktifkan notifikasi pesan** pada halaman pasien dan pengaturan/menu admin.
2. Minta `Notification.requestPermission()` hanya sebagai respons atas tindakan langsung pengguna; jelaskan tujuan notifikasi sebelum meminta izin.
3. Jika izin ditolak, jangan terus meminta. Tampilkan instruksi umum untuk mengaktifkannya melalui pengaturan browser/perangkat.
4. Sediakan status yang jelas: belum diaktifkan, aktif, izin ditolak, atau gagal tersambung.
5. Sediakan tombol **Matikan notifikasi** yang mencabut subscription dari server dan menghentikan subscription pada browser.
6. Jangan menganggap satu perangkat mewakili semua perangkat: setiap browser/perangkat yang opt-in dapat mempunyai subscription sendiri.

### Tahap 4 — Backend, kunci, dan penyimpanan subscription

1. Tambahkan pustaka Web Push yang sesuai Node.js (misalnya `web-push`) dan lock dependency setelah implementasi disetujui.
2. Buat pasangan kunci VAPID untuk identitas pengirim. Simpan private key hanya sebagai secret environment di hosting; jangan commit ke Git, menaruhnya di JavaScript browser, atau mencetaknya ke log. Public key boleh diberikan ke client.
3. Tambahkan migrasi PostgreSQL untuk tabel subscription. Kolom yang disarankan:
   - id dan endpoint unik per subscription;
   - kunci subscription `p256dh` dan `auth`;
   - jenis pemilik (`patient`/`admin`) dan ID pemilik;
   - room/pasien atau rumah sakit sesuai kebutuhan otorisasi;
   - waktu dibuat, terakhir dipakai, dan dicabut.
4. Terapkan constraint agar subscription terikat ke tepat satu identitas yang valid. Satu pemilik boleh memiliki beberapa perangkat.
5. Batasi akses tabel dan perlakukan endpoint serta kunci subscription sebagai data sensitif. Jangan mencatat seluruh objek subscription dalam log. Pertimbangkan enkripsi data sensitif saat disimpan bila sesuai kemampuan pengelolaan secret dan database.
6. Pastikan masa hidup sesi produksi persisten menggunakan Redis/session store yang benar; jangan mengandalkan MemoryStore untuk produksi atau multi-instance.

### Tahap 5 — Endpoint subscription yang terotorisasi

Buat endpoint, misalnya:

- `POST /api/push/subscribe` untuk membuat atau memperbarui subscription;
- `DELETE /api/push/subscribe` untuk mencabut subscription perangkat tersebut;
- `GET /api/push/public-key` untuk public VAPID key bila diperlukan.

Kontrol wajib:

- Identitas diambil dari sesi server, bukan dari `userId`, `roomId`, atau rumah sakit yang dipercaya begitu saja dari body browser.
- Pasien hanya dapat mendaftarkan subscription miliknya sendiri dan room miliknya.
- Admin hanya dapat menerima notifikasi untuk rumah sakit/room yang diizinkan oleh sesi admin.
- Pertahankan pemeriksaan origin, CSRF, batas ukuran body, dan rate limit untuk endpoint mutasi.
- Validasi bentuk subscription dan jangan menerima endpoint sembarang sebagai sarana proxy/SSRF.

### Tahap 6 — Hubungkan ke event pesan yang sudah tersimpan

1. Integrasikan pengiriman setelah `INSERT INTO messages` berhasil di event `socket.on("message")`; jangan mengirim push sebelum penyimpanan berhasil.
2. Tentukan penerima dari identitas pengirim dan `roomId` yang sudah divalidasi server:
   - pesan pasien → admin yang berwenang pada rumah sakit/room;
   - balasan admin → pasien pemilik room tersebut;
   - jangan kirim notifikasi kepada pengirim.
3. Gunakan status/unread yang sudah ada sebagai dasar penentuan kebutuhan notifikasi; jangan mengubah hitungan unread hanya karena push dikirim.
4. Cegah push ganda ketika penerima sedang melihat room. Pilihan yang disarankan: service worker memeriksa tab same-origin yang terlihat; jika tab relevan aktif, kirim pembaruan ke tab melalui `postMessage`/Socket.IO dan jangan tampilkan OS notification.
5. Push merupakan pekerjaan tambahan setelah pesan tersimpan. Jika provider push gagal, pesan tetap tersimpan dan chat Socket.IO tetap berfungsi.
6. Hapus subscription kedaluwarsa saat provider mengembalikan status seperti 404/410. Tangani kegagalan sementara dengan retry terbatas/backoff dan logging tanpa isi pesan atau credential.

### Tahap 7 — Service worker dan privasi notifikasi

1. Tambahkan handler `push` yang membaca payload minimal dan menampilkan notifikasi sistem dengan `showNotification()`.
2. Isi notifikasi sebaiknya generik, contohnya **“Ada pesan baru di Live Chat”**. Jangan tampilkan isi pesan, nama pasien, alamat, nomor WhatsApp, diagnosis, rumah sakit, atau lampiran pada layar kunci.
3. Jika perlu membuka room tertentu saat notifikasi ditekan, simpan hanya referensi non-deskriptif yang dibutuhkan di `notification.data`; server tetap harus mengautentikasi dan mengotorisasi akses saat halaman dibuka.
4. Tambahkan `notificationclick` untuk fokus ke tab aplikasi yang sudah terbuka atau membuka halaman chat yang tepat.
5. Jika sesi sudah tidak valid, arahkan ke proses masuk/form yang sesuai tanpa membocorkan detail pasien. Karena session store MemoryStore dapat hilang ketika proses restart, Redis persisten adalah prasyarat penting agar pengalaman buka kembali bekerja konsisten.
6. Gunakan `tag`/pengelompokan notifikasi per room agar pesan beruntun tidak membanjiri perangkat; jangan letakkan informasi pasien dalam tag yang terlihat pengguna.

### Tahap 8 — Operasional dan pemantauan

- Tambahkan secret VAPID dan konfigurasi push ke environment hosting. Jangan menyimpan nilainya di `.env.example` selain placeholder.
- Simpan status aktivasi dan waktu pengiriman minimum yang diperlukan, tanpa isi pesan/PHI di log.
- Ukur keberhasilan/kegagalan berdasarkan kode status provider, jumlah subscription aktif, dan penghapusan subscription kadaluwarsa.
- Beri tahu admin/pasien bahwa push bergantung pada izin browser, pengaturan OS, koneksi, dan kebijakan hemat baterai; sediakan badge unread dan chat sebagai fallback.

## Pengujian dan kriteria penerimaan

Uji di staging, dengan pasien dummy dan data non-produksi:

1. HTTPS di browser desktop yang didukung: pesan diterima saat tab chat tidak terbuka; uji juga browser ditutup jika platform mendukung.
2. Uji browser/device mobile yang memang dipakai pengguna, termasuk prasyarat instalasi PWA bila berlaku.
3. Uji izin notifikasi diberikan, ditolak, dicabut dari pengaturan browser, dan diaktifkan ulang.
4. Pasien menerima balasan admin; admin yang berwenang menerima pesan pasien; pengirim tidak mendapat push untuk pesannya sendiri.
5. Admin rumah sakit lain tidak menerima notifikasi room tersebut.
6. Klik notifikasi membuka room yang benar hanya bila sesi masih berwenang; sesi kedaluwarsa tidak membocorkan data.
7. Pesan tetap tersimpan jika push provider gagal; subscription 404/410 dibersihkan; pengiriman tidak duplikat berlebihan.
8. Pastikan tidak ada isi pesan atau data identitas pasien di notifikasi layar kunci, payload yang ditampilkan, log, atau URL yang mudah dibaca.
9. Pastikan fungsi chat real-time, badge unread, CSRF, dan penghapusan pasien tetap berjalan.

**Kriteria rilis:** user dapat opt-in/opt-out dengan jelas; push hanya menuju penerima berhak; isi notifikasi generik; subscription kadaluwarsa dibersihkan; aplikasi tetap berfungsi saat push gagal; pengujian HTTPS pada browser target lulus.

## Urutan kerja yang disarankan

1. Putuskan penerima, perangkat target, dan aturan kapan notifikasi ditampilkan.
2. Siapkan HTTPS, Redis session store produksi, `public/`, manifest, dan service worker.
3. Implementasikan UI izin serta endpoint subscription dengan otorisasi.
4. Tambahkan migrasi subscription dan secret VAPID.
5. Hubungkan pengiriman ke event pesan setelah persistensi sukses.
6. Buat handler push/click yang generik dan aman.
7. Uji seluruh skenario lintas perangkat di staging, perbaiki, lalu rilis bertahap.
