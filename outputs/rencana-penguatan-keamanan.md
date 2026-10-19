# Rencana Penguatan Keamanan Aplikasi Live Chat

**Tujuan:** menurunkan risiko pengambilalihan akun, akses lintas pasien/rumah sakit, kebocoran data, dan gangguan layanan. Tidak ada aplikasi yang dapat dijamin “tidak bisa diretas”; sasaran rencana ini adalah mengurangi permukaan serangan, membatasi dampak, dan mempercepat deteksi serta pemulihan.

## Kondisi awal yang menjadi dasar rencana

Berdasarkan tinjauan kode lokal sebelumnya:

- `database/schema.sql` masih berisi akun dan kata sandi admin bawaan dalam teks biasa. Hashing saat aplikasi berjalan tidak membuat kata sandi default menjadi rahasia.
- Batas body parser sudah diturunkan dari 50 MB menjadi 20 MB, tetapi endpoint pendaftaran dan upload belum tampak memiliki rate limit. Batas upload `MAX_BASE64` 45 MiB tidak selaras dengan batas body parser 20 MB, sehingga batas efektif sebenarnya lebih rendah dan perlu disatukan.
- `express-session` belum dikonfigurasi dengan session store produksi.
- Koneksi PostgreSQL menggunakan `ssl: { rejectUnauthorized: false }`.
- Login admin memiliki rate limit umum, tetapi belum ada kontrol yang terlihat untuk percobaan per akun, MFA, atau pembatasan pesan realtime.
- Pemeriksaan otorisasi per room dan parameterisasi query sudah ada; pertahankan dan uji regresinya.

Status akun aktif, konfigurasi hosting, kebijakan database, serta keterjangkauan aplikasi dari internet belum diverifikasi. Temuan kode tidak dengan sendirinya membuktikan bahwa deployment telah terekspos.

## Prioritas 0 — Tindakan segera (hari yang sama)

1. **Hilangkan kredensial bawaan.** Hapus seed akun/kata sandi default dari `database/schema.sql`; siapkan admin melalui proses provisioning yang aman. Ganti kata sandi semua akun yang pernah dibuat dari seed, bukan hanya mengubah cara penyimpanannya. Wajibkan kata sandi kuat dan unik.
2. **Periksa dan rotasi rahasia produksi bila perlu.** Pemilik deployment harus memeriksa secret manager secara langsung. Rotasi `SESSION_SECRET` dan kredensial database bila pernah dibagikan, masuk ke log, atau terpapar. Jangan menaruh nilainya di chat, kode, atau Git.
3. **Periksa akses dan jejak penggunaan.** Pastikan akun admin yang tidak diperlukan dinonaktifkan, tinjau log login dan akses tak biasa, dan pastikan cadangan database terbaru tersedia. Jika ada tanda akses tidak sah, isolasi akun/secret terkait dan jalankan prosedur respons insiden.

**Selesai bila:** tidak ada akun dengan kredensial default yang dapat login; seluruh admin yang aktif memakai kredensial baru dan unik; rahasia produksi hanya berada di secret manager.

## Prioritas 1 — Autentikasi dan sesi produksi (1–3 hari)

1. **Gunakan session store yang tahan produksi**, misalnya Redis atau PostgreSQL store yang dipelihara. Hindari `MemoryStore`; tentukan TTL, pembersihan sesi kedaluwarsa, serta perilaku saat store tidak tersedia.
2. **Pertahankan regenerasi ID sesi** setelah login dan perubahan hak akses. Tangani kegagalan `req.session.regenerate` secara eksplisit; jangan melanjutkan login bila regenerasi gagal. Hancurkan sesi saat logout dan jadikan logout sebagai `POST` yang dilindungi CSRF, bukan perubahan status melalui `GET`.
3. **Tegaskan konfigurasi cookie**: `HttpOnly`, `Secure` pada HTTPS, `SameSite=Lax` atau kebijakan yang sesuai, masa berlaku terbatas, dan pemeriksaan konfigurasi proxy yang benar-benar digunakan.
4. **Perkuat login admin.** Pertahankan bcrypt atau pindah ke Argon2 yang dikelola dengan benar; tambahkan limit per IP dan per akun melalui store bersama, jeda progresif untuk percobaan gagal, dan MFA untuk admin. Hindari penguncian permanen yang dapat dipakai untuk DoS.
5. **Siapkan proses pemulihan kredensial** yang terverifikasi; jangan menambahkan endpoint reset sederhana yang mengungkap apakah sebuah username ada.

**Selesai bila:** uji menunjukkan ID sesi berubah saat login, logout membatalkan sesi, sesi dapat dicabut, dan MFA/rate limit berfungsi konsisten lintas instance aplikasi.

## Prioritas 2 — Pembatasan penyalahgunaan dan DoS (2–5 hari)

1. **Tambahkan rate limit terdistribusi** untuk pendaftaran pasien, login, upload, penghapusan, dan API polling. Atur berdasarkan IP dan, jika dapat diidentifikasi dengan aman, akun/session; jangan mengandalkan satu instance atau limiter di memori pada deployment multi-instance.
2. **Terapkan validasi server-side pada pendaftaran:** panjang maksimum nama/alamat/nomor telepon, format yang diizinkan, field wajib, normalisasi input, dan batas frekuensi pembuatan record.
3. **Selaraskan batas request dan upload.** Pilih ukuran maksimum yang sesuai kebutuhan operasional (misalnya beberapa MiB, bukan puluhan MiB), validasi ukuran aktual byte setelah decode, tolak payload berlebih sebelum pemrosesan mahal, dan pastikan batas reverse proxy/hosting tidak lebih longgar. Uji permintaan tepat di bawah dan di atas batas.
4. **Hindari menyimpan file besar sebagai base64 dalam tabel pesan.** Pertimbangkan object storage privat dengan URL bertanda tangan berumur pendek. Batasi kapasitas per file, per room, dan per periode; gunakan pemindaian malware/format bila tersedia; verifikasi tipe dan ekstensi secara konsisten.
5. **Batasi chat realtime.** Terapkan panjang maksimum pesan, jumlah pesan per socket/session per rentang waktu, batas koneksi/heartbeat yang wajar, serta penanganan pesan malformed. Jangan menerima payload tanpa batas hanya karena autentikasi socket berhasil.
6. **Tinjau `trust proxy`.** Percayai hanya jumlah/lapisan proxy yang benar pada deployment, agar alamat IP untuk rate limit tidak mudah dipalsukan.

**Selesai bila:** uji beban wajar dan pengujian limit menunjukkan request berlebih ditolak, layanan tetap responsif, dan satu pengguna tidak dapat membuat pertumbuhan database/storage tanpa batas.

## Prioritas 3 — Koneksi database, hak akses, dan data sensitif (3–7 hari)

1. **Aktifkan verifikasi sertifikat TLS PostgreSQL.** Konfigurasikan CA/sertifikat yang benar dan gagal secara aman bila verifikasi tidak berhasil; jangan menonaktifkan `rejectUnauthorized` untuk produksi.
2. **Pisahkan migrasi dari proses aplikasi.** Jalankan perubahan skema secara terkontrol saat deployment, bukan dengan akun runtime. Gunakan akun aplikasi dengan hak minimum yang diperlukan dan akun migrasi terpisah.
3. **Tinjau batas tenant.** Pertahankan pemeriksaan hospital-scoped pada semua route dan event socket. Tambahkan tes negatif untuk pasien rumah sakit lain, room yang dibuat-buat, file, API pesan, hapus, dan socket join/send. Pertimbangkan Row-Level Security sebagai lapisan tambahan setelah dirancang dan diuji dengan cermat.
4. **Kurangi paparan data.** Tetapkan retensi untuk pesan dan lampiran, batasi siapa yang dapat melihat data pasien, hindari memasukkan PII/kata sandi/token ke log, dan lindungi backup serta kredensial aksesnya. Tinjau kewajiban privasi/keamanan data kesehatan yang berlaku bersama penanggung jawab organisasi.

**Selesai bila:** koneksi TLS terverifikasi; runtime aplikasi tidak bisa menjalankan DDL yang tidak dibutuhkan; pengujian lintas rumah sakit selalu menghasilkan penolakan; akses backup dibatasi dan pemulihan telah diuji.

## Prioritas 4 — Perlindungan browser, upload, dan dependensi (minggu pertama)

1. Tambahkan header keamanan melalui konfigurasi teruji (misalnya Helmet): CSP yang disesuaikan dengan inline script dan CDN yang benar-benar dipakai, `X-Content-Type-Options`, `Referrer-Policy`, dan HSTS hanya jika seluruh domain produksi sudah HTTPS.
2. Pertahankan escaping EJS dan escaping konten pesan dinamis. Tambahkan uji XSS untuk nama, alamat, pesan, reply, dan nama file; gunakan `textContent`/DOM API aman dan hindari interpolasi data tidak tepercaya ke `innerHTML`.
3. Pada download lampiran, gunakan tipe yang telah diverifikasi, `nosniff`, nama file aman, dan `Content-Disposition` yang tepat. Pastikan konten aktif tidak dirender sebagai halaman dari origin aplikasi.
4. Tambahkan pemeriksaan dependency terjadwal pada `package-lock.json` (`npm audit` atau scanner setara), secret scanning Git, dan pembaruan keamanan terkontrol. Catat pengecualian yang memang belum dapat diperbaiki.

**Selesai bila:** header diverifikasi pada deployment staging; payload XSS uji tampil sebagai teks; tidak ada temuan dependensi kritis/tinggi yang tidak ditangani.

## Prioritas 5 — Verifikasi, pemantauan, dan pemulihan (berjalan terus)

1. Tambahkan tes otomatis untuk login, CSRF, session fixation, otorisasi lintas pasien/rumah sakit, batas upload, validasi file, dan kontrol rate limit.
2. Jalankan pengujian keamanan dinamis pada staging dengan data palsu, bukan terhadap produksi tanpa rencana dan izin. Setelah perubahan besar, lakukan tinjauan independen atau penetration test dengan cakupan dan waktu yang disepakati.
3. Pantau lonjakan kegagalan login, pembuatan pasien, upload, koneksi socket, penggunaan database/storage, serta respons 4xx/5xx; buat peringatan dan prosedur eskalasi.
4. Uji backup dan pemulihan secara berkala; dokumentasikan cara mencabut sesi dan merotasi secret jika terjadi insiden.

**Selesai bila:** pengujian keamanan berjalan di CI/staging, peringatan sampai ke penanggung jawab, dan organisasi berhasil melakukan simulasi pemulihan.

## Urutan implementasi yang disarankan

| Urutan | Fokus | Risiko yang dikurangi | Perkiraan |
|---|---|---|---|
| 1 | Rotasi kredensial bawaan dan audit akun | Pengambilalihan admin | Segera |
| 2 | Session store, MFA, dan login controls | Pembajakan/penyalahgunaan akun | 1–3 hari |
| 3 | Rate limit, batas input, upload, dan socket | Spam, DoS, pembengkakan storage | 2–5 hari |
| 4 | TLS database dan least privilege | Penyadapan/kompromi database | 3–7 hari |
| 5 | Header, XSS tests, dependency scanning | Serangan browser dan dependency | Minggu pertama |
| 6 | Monitoring, backup restore, security testing | Dampak dan waktu pemulihan | Berkelanjutan |

Perkiraan waktu bersifat kasar dan bergantung pada hosting, ketersediaan Redis/object storage, proses persetujuan internal, serta kebutuhan operasional.

## Kriteria rilis keamanan minimum

Sebelum rilis produksi berikutnya, pastikan setidaknya:

- Semua kredensial bawaan dihapus/diganti; kata sandi baru bersifat unik.
- HTTPS aktif; cookie sesi aman; session store produksi digunakan.
- Login admin memakai limit yang efektif dan MFA telah diaktifkan atau ada jadwal/rencana mitigasi yang disetujui.
- Pendaftaran, upload, dan socket memiliki validasi serta rate/payload limits.
- Sertifikat TLS database diverifikasi dan akun runtime memakai hak minimum.
- Tes membuktikan akses lintas rumah sakit/pasien ditolak.
- Backup dapat dipulihkan dan secret tidak masuk Git/log.

**Catatan:** rencana ini bukan sertifikasi keamanan dan tidak menjamin aplikasi kebal peretasan. Setelah langkah awal selesai, lakukan verifikasi pada konfigurasi staging dan deployment produksi yang benar-benar digunakan.
