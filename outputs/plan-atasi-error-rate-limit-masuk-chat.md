# Rencana Mengatasi Error Rate Limit saat Pasien Klik “Masuk Chat”

## Tujuan

Mengurangi pemblokiran pasien yang sah saat mengirim form dan memastikan error **“Terlalu banyak pendaftaran. Coba lagi beberapa saat.”** tidak ditampilkan sebagai JSON mentah pada browser. Perlindungan anti-spam tetap dipertahankan.

## Temuan awal dari source lokal

Pada source yang diperiksa, `POST /tambah` menjalankan `resolveExistingPatient` sebelum `registerLimiter` (`server.js`, sekitar baris 1238). Pasien yang dikenali sebagai pasien lama dilewati oleh limiter (`skip: req => !!req.existingPatient`). Untuk pendaftaran baru, limiter memakai batas `REGISTER_LIMIT` atau default **30 request per alamat IP dalam 15 menit**, serta melewati request gagal 4xx/5xx (`server.js`, sekitar baris 184–195). IP efektif dipengaruhi konfigurasi reverse proxy (`app.set("trust proxy", 1)`).

Jika request ditolak, `registerLimitHandler` memeriksa tipe `Accept`: request yang dianggap HTML dirender kembali ke halaman form dengan pesan dan nilai form dipertahankan; request yang dianggap bukan HTML menerima JSON dengan teks error tersebut (`server.js`, sekitar baris 138–170). Karena itu, munculnya JSON di browser perlu ditelusuri: mungkin request dilakukan melalui fetch/AJAX, deployment production masih memakai versi handler lama, atau header `Accept` berbeda dari yang diharapkan.

`resolveExistingPatient` mencari pasien melalui cookie token, sesi, atau nomor WhatsApp bersama rumah sakit (`server.js`, sekitar baris 1180–1236). Pencocokan nomor saja tidak boleh diperlakukan sebagai bukti kepemilikan chat; mekanisme resume perlu memastikan pasien membuktikan kontrol atas sesi/token atau faktor verifikasi lain.

## Tahap 1 — Pastikan sumber error di production

1. Catat waktu kejadian, rumah sakit yang dipilih, URL, status HTTP, dan apakah request dikirim sebagai form biasa atau fetch/AJAX. Jangan mencatat nama, alamat, nomor WA, cookie, token, atau isi chat ke laporan umum.
2. Di Developer Tools → Network, periksa request `POST /tambah`: status (diperkirakan 429), response body, header `Accept`, `Retry-After`, serta header rate-limit bila tersedia. Jangan menyalin nilai cookie atau payload pribadi.
3. Cocokkan commit/build production dengan source lokal. Source lokal saat ini memiliki `registerLimitHandler` yang seharusnya merender halaman form untuk request HTML. Bila browser justru menampilkan JSON, pastikan deployment menjalankan commit baru dan tidak ada route/proxy versi lama.
4. Periksa log `[RATE-LIMIT] /tambah diblokir` pada waktu kejadian. Log lokal dirancang menyimpan hash IP, rumah sakit, dan waktu reset; gunakan hanya untuk diagnosis terbatas dan jangan mencoba membalik hash menjadi alamat IP.
5. Pastikan nilai `REGISTER_LIMIT`, jumlah instance server, konfigurasi limiter store (Redis bila multi-instance), serta pengaturan proxy menghasilkan identifikasi client IP yang benar. Jangan membuka atau membagikan nilai environment rahasia.

**Selesai bila:** terbukti limiter mana yang memblokir, ambang dan durasi efektifnya, jenis request, serta apakah production selaras dengan source lokal.

## Tahap 2 — Atasi gangguan sementara dengan aman

- Jika pasien memang terkena 429, ikuti `Retry-After` atau estimasi reset yang server kirim dan minta pasien mencoba sekali setelah waktunya berlalu.
- Hindari menyuruh pasien mengulang klik berkali-kali; hal itu dapat menambah request dan memperpanjang gangguan.
- Jika pengiriman mungkin sudah berhasil tetapi browser tidak menerima respons, jangan langsung kirim form baru tanpa memeriksa status operasi; cegah pendaftaran/room ganda.
- Bila chat terkait kondisi mendesak, halaman gangguan harus mengarahkan ke kanal resmi rumah sakit/jalur darurat yang telah diverifikasi.

## Tahap 3 — Tuning berdasarkan data, bukan menghapus proteksi

1. Ukur jumlah pendaftaran baru yang sah pada waktu tersibuk per RS dan jumlah pasien yang berbagi jaringan publik.
2. Sesuaikan `REGISTER_LIMIT` dan window setelah staging/load test, dengan batas yang memberi ruang bagi puncak penggunaan normal serta margin aman. Hindari menghapus limiter atau memilih angka tanpa data.
3. Pertimbangkan limiter bertingkat: IP sebagai sinyal anti-abuse, limiter per operasi/sesi yang terverifikasi, serta tantangan adaptif hanya untuk pola berisiko. Jangan menggunakan nomor WA mentah sebagai satu-satunya identitas limiter.
4. Pastikan limiter memakai store bersama dan konfigurasi key IP benar ketika berjalan di belakang proxy atau beberapa instance; jangan mempercayai header proxy yang dapat dipalsukan dari koneksi langsung.
5. Tetap kecualikan pasien existing dari jatah pendaftaran baru hanya jika identitas existing aman diverifikasi. Validasi kepemilikan cookie/session/token; pencocokan nomor WA saja harus memicu verifikasi tambahan sebelum memberi akses ke percakapan lama.

**Selesai bila:** banyak pasien sah di Wi-Fi/seluler bersama dapat mendaftar di beban normal, sementara pendaftaran otomatis berlebihan tetap dibatasi.

## Tahap 4 — Tahan retry dan double-submit

- Pertahankan penonaktifan tombol setelah submit, dengan indikator “Memproses…”. Ini membantu UX, tetapi bukan satu-satunya perlindungan karena retry dapat berasal dari browser/jaringan.
- Tambahkan idempotency key sekali pakai untuk operasi form. Retry dengan key yang sama mengembalikan hasil pertama, bukan membuat room baru atau dianggap percobaan baru.
- Gunakan transaksi dan constraint database yang sesuai untuk mencegah dua request paralel membuat pasien duplikat.
- Jika koneksi terputus setelah server menyimpan data, sediakan pengecekan status submit memakai key yang sama sebelum meminta pasien mencoba pendaftaran baru.

## Tahap 5 — Pastikan tampilan error sesuai tipe request

- Form browser biasa harus mengembalikan halaman EJS yang ramah, mempertahankan input yang aman, menunjukkan lama tunggu jika diketahui, dan menyediakan tombol kembali/coba lagi.
- API/fetch tetap mengembalikan JSON berstatus 429 dan `Retry-After`; frontend harus menangkapnya dan menampilkan pesan pada halaman, bukan menavigasi browser ke response JSON.
- Jangan menampilkan stack trace, detail konfigurasi, IP, atau informasi akun di pesan pasien.
- Pastikan respons sukses tetap mengarahkan pasien ke chat; respons 429 tidak membuat pasien baru di database.

**Selesai bila:** test form normal tidak menampilkan JSON mentah dan API tetap memberi format error terstruktur.

## Pengujian staging dan penerimaan

1. Buat uji otomatis terhadap handler rate limit dengan header `Accept: text/html` dan `Accept: application/json`; pastikan masing-masing mendapat HTML dan JSON yang benar.
2. Uji jumlah request pada batas default dan nilai `REGISTER_LIMIT` yang disetujui; verifikasi status 429 dan `Retry-After`.
3. Uji banyak pasien berbeda dari satu IP/NAT pada volume penggunaan normal yang disepakati; pasien sah tidak terblokir sebelum kapasitas wajar.
4. Uji pasien existing yang memiliki token/session sah: ia dapat melanjutkan chat tanpa mengonsumsi kuota pendaftaran baru.
5. Uji bahwa nomor WA yang diketahui tetapi tanpa bukti kepemilikan tidak membuka chat pasien lain.
6. Uji double-click, retry jaringan, request paralel, dan timeout: paling banyak satu pasien/room dibuat.
7. Uji multi-instance dan store limiter bersama; hasil pembatasan tidak boleh acak antar-instance.
8. Uji pada Android/browser nyata bahwa error 429 ditampilkan sebagai instruksi ramah, bukan JSON mentah.
9. Pastikan log dan telemetry tidak memuat PII, token, cookie, password, OTP, atau isi chat.

## Urutan prioritas implementasi

1. Cocokkan request production dan versi deployment; validasi status/header/log 429.
2. Periksa konfigurasi `REGISTER_LIMIT`, store Redis/shared limiter, dan trust proxy.
3. Amankan aturan deteksi pasien lama agar pencocokan nomor WA saja tidak memberi akses ke chat.
4. Sesuaikan ambang limiter berdasarkan volume nyata dan uji pada staging.
5. Tambahkan idempotensi dan transaksi agar retry tidak menggandakan pasien.
6. Validasi tampilan HTML/JSON dan jalankan pilot produksi dengan pemantauan metrik agregat.

> Dokumen ini adalah rencana analisis/perbaikan. Kode proyek tidak diubah.
