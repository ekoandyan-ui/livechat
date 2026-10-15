# Rencana Login Email dan Manajemen Password Admin

## Tujuan

Mengganti login admin dari **username** menjadi **email admin yang terdaftar**, memungkinkan admin mengganti password, dan menyediakan pemulihan password melalui email dengan alur yang aman.

## Keputusan keamanan utama

**Jangan gunakan satu password default tetap atau mengirim password baru dalam teks melalui email.** Password bersama yang ditaruh di kode, database seed, atau email mudah diteruskan/dibocorkan dan sering tidak diganti. Sebagai gantinya:

- Saat membuat akun admin, kirim **tautan aktivasi/password setup sekali pakai** ke alamat yang telah diverifikasi. Tautan bertanda tangan acak, berlaku singkat (misalnya 30 menit), hanya dapat dipakai sekali; database hanya menyimpan hash token.
- Admin menetapkan password pribadinya melalui tautan tersebut. Akun tidak dapat login dengan password sebelum aktivasi selesai.
- Untuk lupa password, kirim **tautan reset password sekali pakai** ke email akun. Jangan mengirim atau mengungkap password yang berlaku maupun password default melalui email.
- Email pemulihan harus menyatakan bahwa tautan dapat diabaikan bila tidak diminta dan tidak membocorkan apakah alamat email terdaftar.

Jika organisasi tetap memerlukan password sementara karena keterbatasan operasional, buat password acak yang unik per akun, hanya sekali pakai, berlaku sangat singkat, paksa penggantian saat login pertama, jangan simpan/tampilkan lagi, dan kirim melalui proses yang disetujui penanggung jawab keamanan. Tautan setup tetap lebih disarankan.

## Pemetaan email yang diberikan

| Rumah sakit | Email admin | Status pemetaan |
|---|---|---|
| RSUD Sunan Kalijaga | ekoandyan@gmail.com | Sesuai nama yang diberikan |
| RSI Nahdlatul Ulama / RSI NU Demak | yankeslanjutan@gmail.com | Perlu konfirmasi bahwa ini nama yang sama dengan `RSI Nahdlatul Ulama` pada aplikasi |
| RS Pelita Anugerah | tugasai063@gmail.com | Sesuai nama yang diberikan |
| **Belum dipastikan** | yankesrujukandkkdemak@gmail.com | Nama rumah sakit yang dikirim adalah “RSUD Sunan Kalijaga” untuk kedua kalinya; aplikasi saat ini memiliki `RSUD Sultan Fatah` sebagai rumah sakit keempat. Jangan tetapkan ke salah satu akun sebelum dikonfirmasi. |
| RS Hj. Fatimah Sulhan | pscdemak119@gmail.com | Sesuai nama yang diberikan |
| Charlie Hospital (Demak) | purnamaberlianekoandriantoro@gmail.com | Sesuai nama yang diberikan |

**Perlu konfirmasi sebelum provisioning:** apakah alamat `yankesrujukandkkdemak@gmail.com` seharusnya untuk **RSUD Sultan Fatah**? Jangan mengubah atau mengirim kredensial ke alamat ini sampai pemilik proyek mengonfirmasi pemetaannya.

Sebelum aktivasi, verifikasi bahwa setiap alamat email memang dikelola oleh admin/organisasi yang berhak. Batasi akun admin sesuai rumah sakitnya, dan jangan menerima alamat rumah sakit atau peran admin dari form publik.

## Fase implementasi

### Fase 1 — Persiapan akun dan data (sebelum perubahan login)

1. Tambahkan kolom email pada tabel `admins`, dengan normalisasi konsisten (trim dan lowercase) serta constraint unik yang case-insensitive.
2. Tetapkan email untuk akun yang telah diverifikasi. Tinjau akun duplikat, akun tidak aktif, dan hubungan `email` ↔ `rumah_sakit` sebelum migrasi.
3. Hapus seed password default plaintext dari `database/schema.sql`. Provision akun secara terpisah; jangan menulis password, token aktivasi, atau password reset ke Git, log, tiket, atau dokumen bersama.
4. Rencanakan migrasi bertahap agar deployment tidak terkunci: tambah email nullable, isi/verifikasi data, validasi keunikan, kemudian wajibkan email untuk admin aktif.

**Kriteria selesai:** setiap admin aktif mempunyai email unik yang telah diverifikasi dan satu cakupan rumah sakit yang benar; tidak ada akun produksi yang bergantung pada password default.

### Fase 2 — Login dengan email

1. Ubah form login menjadi email + password; lakukan normalisasi email di server.
2. Cari akun menggunakan parameter query dan verifikasi password yang sudah di-hash menggunakan bcrypt dengan cost yang sesuai atau Argon2id.
3. Setelah login berhasil, regenerasi ID sesi; jika regenerasi gagal, **batalkan login** dan jangan memberi hak admin.
4. Batasi percobaan berdasarkan IP dan akun menggunakan limiter bersama/terdistribusi; tambahkan jeda progresif dan pantau percobaan gagal. Pesan kesalahan login harus generik.
5. Gunakan session store produksi bersama, cookie `HttpOnly`, `Secure` di HTTPS, `SameSite` yang sesuai, dan TTL. Paksa sesi lama dicabut setelah perubahan password.
6. Pertahankan otorisasi berdasarkan `rumah_sakit` pada setiap halaman, API, unduhan file, dan event Socket.IO; email hanya identitas login, bukan dasar untuk memperluas akses.

**Kriteria selesai:** login hanya menerima email akun aktif dengan password valid; tidak ada username/password default; sesi baru diterbitkan setelah autentikasi dan regenerasi sukses; admin RS A tetap tidak dapat mengakses data RS B.

### Fase 3 — Aktivasi admin dan ganti password

1. Admin baru menerima tautan aktivasi sekali pakai ke email yang sudah ditetapkan dan diverifikasi.
2. Token dibuat dengan CSPRNG, dikirim hanya melalui HTTPS, disimpan dalam bentuk hash, terikat pada akun dan tujuan aktivasi, memiliki kedaluwarsa singkat, serta dihapus/dinonaktifkan setelah dipakai.
3. Validasi password baru: panjang minimum yang memadai (misalnya 12 karakter), batas maksimum yang wajar, dukung passphrase, blokir password umum/bocor jika dapat dilakukan, dan jangan memaksa pola karakter yang tidak efektif.
4. Tambahkan halaman “Ganti password” yang meminta password saat ini dan password baru; setelah sukses, hash password baru dan cabut semua sesi lain. Beri notifikasi email bahwa password berubah, tanpa menyertakan password.
5. Pertimbangkan MFA untuk akun admin, terutama bila aplikasi memuat data pasien sensitif.

**Kriteria selesai:** token aktivasi tidak dapat digunakan ulang atau setelah kedaluwarsa; password hanya tersimpan sebagai hash; perubahan password mencabut sesi lama dan menghasilkan notifikasi tanpa rahasia.

### Fase 4 — Lupa password

1. Sediakan form “Lupa password” yang menerima email.
2. Untuk semua input, tampilkan jawaban yang sama: misalnya “Jika alamat terdaftar, instruksi pemulihan akan dikirim.” Hindari enumerasi akun.
3. Jika akun cocok, buat token acak sekali pakai dengan masa berlaku singkat, simpan hash token dengan `expires_at`, dan kirim link HTTPS ke email akun.
4. Endpoint reset harus membatasi percobaan dan memvalidasi token di server; setelah sukses, atomik tandai token terpakai, simpan hash password baru, dan cabut sesi aktif lama.
5. Jangan mengirim password lama, password tetap/default, atau password baru dalam email. Jangan mencatat token reset di access log/analytics. Lindungi halaman dari referrer leakage dan gunakan no-store.
6. Kirim notifikasi setelah perubahan berhasil. Jika permintaan reset tidak diminta, penerima dapat mengabaikan email; pertimbangkan jalur pelaporan untuk akun yang dicurigai diambil alih.

**Kriteria selesai:** respons tidak mengungkap keberadaan email; tautan kedaluwarsa/sekali pakai; perubahan password membatalkan sesi lama; log dan email tidak mengandung password atau token yang dapat digunakan.

### Fase 5 — Email delivery dan operasional

1. Pilih penyedia email transaksional yang disetujui organisasi atau SMTP relay terkelola. Simpan API key/password SMTP hanya di secret manager deployment.
2. Atur domain pengirim milik organisasi beserta SPF, DKIM, dan DMARC; gunakan alamat `From` organisasi yang jelas, bukan alamat personal admin.
3. Buat template aktivasi, reset, perubahan password, dan peringatan keamanan. Tautan harus memakai origin HTTPS yang ditetapkan di konfigurasi, bukan host dari header request.
4. Catat status pengiriman tanpa menyimpan konten rahasia. Terapkan retry terbatas, antrean bila tersedia, dan penanganan aman bila penyedia email gagal.
5. Tetapkan pemilik proses: siapa yang menyetujui perubahan email admin, menonaktifkan admin, mencabut sesi, dan merotasi secret.

**Catatan privasi:** alamat email pada tabel adalah alamat yang diberikan pemohon. Verifikasi kepemilikan dan otorisasi sebelum mengirim email aktivasi/reset. Dokumen ini tidak mengirim email atau membuat akun.

### Fase 6 — Pengujian dan rilis

Uji di staging dengan akun dan data palsu:

- Login benar/salah, email uppercase/spasi, akun nonaktif, dan pesan error generik.
- Kredensial default lama tidak dapat dipakai.
- Regenerasi sesi sukses; kegagalan regenerasi tidak memberi akses.
- CSRF pada semua aksi perubahan password dan logout.
- Token aktivasi/reset valid, kedaluwarsa, telah dipakai, salah akun, dan dipakai bersamaan.
- Reset meminta respons yang sama untuk email terdaftar/tidak terdaftar.
- Rate limit tidak dapat dilewati hanya dengan mengganti koneksi/IP secara ringan; limiter lintas instance bekerja.
- Sesi lama dicabut setelah ganti/reset password.
- Akses lintas rumah sakit ditolak untuk dashboard, API, file, dan Socket.IO.
- Secret, password, serta token tidak muncul dalam Git, respons, log, analytics, atau email.
- Backup, rollback migrasi, dan prosedur pemulihan akun telah diuji.

Lakukan rollout bertahap: staging → satu admin uji → kelompok kecil admin → seluruh admin. Pertahankan prosedur rollback yang tidak mengembalikan seed password default.

## Prioritas ringkas

1. **Konfirmasi pemetaan email rumah sakit yang terduplikasi.**
2. Verifikasi kepemilikan alamat email dan hapus password default dari seed.
3. Migrasi email admin dan aktifkan login email dengan hashing password.
4. Pasang aktivasi akun melalui tautan sekali pakai dan halaman ganti password.
5. Implementasikan reset via email tanpa mengirim password.
6. Siapkan email transaksional/domain authentication, limiter terdistribusi, logging aman, dan MFA.
7. Uji staging, lakukan rollout bertahap, dan pantau kegagalan login/reset.
