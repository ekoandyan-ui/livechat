# Rencana Super Admin untuk Pemantauan Akun Admin

## Tujuan

Menambahkan peran **Super Admin** melalui akun utama yang ditetapkan ke `ekoandyan@gmail.com` untuk memantau/mengelola akun admin lintas rumah sakit serta, bila ada tujuan kerja yang sah dan tercatat, melihat chat dan data pasien secara **baca-saja**.

Akses ke chat dan data pasien merupakan izin terpisah dari pengelolaan akun. Rencana ini tidak memberi akses tanpa batas untuk mengubah, menghapus, atau mengekspor massal data pasien; akses harus dibatasi, diberi alasan, dan diaudit.

## Kondisi aplikasi yang terlihat saat ini

- Tabel `admins` menyimpan email, rumah sakit, status aktif, hash password, dan versi sesi; belum terlihat kolom role untuk membedakan Super Admin dan admin rumah sakit.
- Sesi admin menyimpan identitas admin dan satu `adminRumahSakit`; beberapa route membatasi data dengan konteks rumah sakit itu.
- Middleware `requireAdmin` melindungi halaman admin umum, sehingga menambah Super Admin perlu middleware dan pemeriksaan role tersendiri.
- Email mempunyai unique index tanpa membedakan kapitalisasi, dan sudah ada alur aktivasi serta token reset.

Temuan ini berdasarkan source code yang ditinjau; ketersediaan konfigurasi, email, MFA, dan infrastruktur pada production perlu diverifikasi terpisah.

## Prinsip keamanan

1. Email `ekoandyan@gmail.com` menjadi **akun Super Admin utama yang ditetapkan**, bukan satu-satunya pemeriksaan otorisasi. Hak istimewa harus berasal dari role tersimpan di database dan sesi terverifikasi.
2. Jangan memberi role Super Admin otomatis kepada siapa pun hanya karena ia mengetik alamat email tersebut saat pendaftaran. Akun harus diprovisioning lewat proses khusus, email diverifikasi, dan role dicatat secara eksplisit.
3. Super Admin tidak boleh melihat password, hash password, token aktivasi/reset, atau secret. Hak untuk melihat isi chat dan data pasien diberikan sebagai **permission terpisah**, bersifat baca-saja, memerlukan alasan, dan dicatat.
4. Admin rumah sakit tetap hanya melihat dan mengelola lingkup rumah sakitnya sendiri. Izin global Super Admin untuk membaca data pasien tidak boleh menjadi bypass implisit untuk mengubah atau menghapus data, mengirim pesan sebagai petugas, atau mengambil alih sesi pasien.
5. Setiap tindakan administratif dan setiap akses terhadap data pasien harus memerlukan otorisasi; aksi tulis dilindungi CSRF, dan akses baca pasien dicatat dalam audit log.

## Fitur yang direncanakan

### Dashboard pemantauan akun

Buat halaman khusus, misalnya `/super-admin/admins`, berisi daftar admin yang dapat dicari dan difilter berdasarkan rumah sakit serta status. Informasi yang ditampilkan secukupnya:

- nama/username, email, rumah sakit, role;
- status aktif/nonaktif dan status aktivasi;
- waktu akun dibuat dan login terakhir yang berhasil;
- ringkasan percobaan login gagal atau notifikasi keamanan yang relevan;
- status MFA untuk memastikan akun dengan hak tinggi sudah dilindungi.

Jangan menampilkan password atau hash password. Dashboard pengelolaan akun tetap terpisah dari dashboard pemantauan chat dan data pasien.

### Pemantauan chat dan data pasien

Buat halaman terpisah yang hanya dapat dibuka oleh Super Admin dengan permission baca-pasien yang aktif. Tampilan ini dapat mencari pasien/room lintas rumah sakit dan membaca riwayat chat serta data pasien yang diperlukan untuk tujuan yang disetujui. Batasi hasil awal pada metadata minimum—misalnya rumah sakit, status room, waktu aktivitas, dan ID internal—lalu tampilkan data identitas lengkap atau isi pesan hanya setelah Super Admin memilih room dan mencatat alasan akses.

- Tampilkan indikator yang jelas bahwa akses lintas rumah sakit sedang dilakukan; tampilkan rumah sakit, room, dan alasan akses pada header sesi pemantauan.
- Terapkan akses **baca-saja**: tidak ada kirim pesan, edit data pasien, hapus pesan, pin, perubahan status klinis, atau ekspor massal dari layar ini.
- Perlakukan lampiran sebagai akses terpisah: perlu permission yang sama, diperiksa oleh server, dan tiap unduhan dicatat. Jangan membuat URL file publik.
- Catat setiap pencarian, pembukaan profil, pembacaan riwayat chat, pembukaan lampiran, dan ekspor yang disetujui: siapa, pasien/room mana, rumah sakit, waktu, alasan, hasil, serta tindakan yang dilakukan.
- Minta alasan akses per sesi/kasus; untuk akses darurat, gunakan mekanisme break-glass berjangka pendek dengan alasan wajib dan tinjauan setelahnya.
- Batasi hasil dan laju pencarian; cegah enumerasi ID, scraping, dan unduhan massal. Masking data pada hasil daftar, unmask hanya pada halaman yang benar-benar diperlukan.
- Tentukan bersama penanggung jawab organisasi apakah pasien/petugas perlu diberi pemberitahuan mengenai akses lintas rumah sakit, berdasarkan kebijakan dan kewajiban privasi yang berlaku.

Isi chat dapat memuat informasi kesehatan yang sensitif. Persetujuan kebijakan, tujuan pemrosesan, masa retensi, pengguna yang berwenang, dan proses peninjauan akses harus ditetapkan sebelum fitur ini diaktifkan.

### Pengelolaan akun admin

Super Admin dapat, sesuai kebijakan yang disetujui:

- membuat/mengundang akun admin untuk rumah sakit tertentu;
- mengaktifkan atau menonaktifkan akun;
- mengubah penempatan rumah sakit dengan alasan yang dicatat;
- mengirim ulang tautan aktivasi atau reset password yang aman;
- mencabut sesi admin dengan menaikkan `session_version`;
- meninjau riwayat administratif akun.

Utamakan **nonaktifkan akun** daripada menghapus permanen agar jejak audit tidak hilang. Perubahan email harus melalui proses verifikasi email baru. Jangan pernah memberikan fitur untuk melihat atau mengirim password admin.

### Riwayat dan peringatan

Catat peristiwa seperti login berhasil/gagal, aktivasi akun, perubahan role/rumah sakit, aktivasi/nonaktif akun, permintaan reset, pencabutan sesi, dan perubahan MFA. Log harus menyimpan aktor, target, tindakan, waktu, hasil, dan alasan bila relevan. Minimalkan data teknis seperti IP, batasi akses log, tetapkan masa retensi, dan jangan mencatat password, token, OTP, isi chat, atau secret.

Peringatan dapat dibuat untuk kejadian berisiko, misalnya banyak login gagal, perubahan role, penonaktifan akun, atau reset akun Super Admin. Pengiriman peringatan harus memakai kanal organisasi yang disetujui dan tidak menyertakan data pasien.

## Rancangan teknis

### 1. Tetapkan role dan cakupan akses

- Tambahkan kolom `role` dengan nilai yang dibatasi, sekurangnya `hospital_admin` dan `super_admin`.
- Tetapkan aturan konsisten untuk `rumah_sakit`: wajib terisi untuk `hospital_admin`; Super Admin memiliki cakupan global administratif dan tidak perlu dikaitkan ke satu rumah sakit.
- Tambahkan constraint database agar role dan cakupan tidak berada dalam kombinasi yang tidak sah.
- Saat login, simpan `adminId`, `role`, `rumahSakit` bila ada, dan `session_version` ke sesi setelah regenerasi sesi berhasil.
- Pada setiap request terlindungi, periksa bahwa akun masih aktif, role masih berlaku, dan `session_version` cocok dengan database. Perubahan role atau status harus membuat sesi lama tidak berwenang.

### 2. Pisahkan middleware dan route

- Pertahankan `requireAdmin` untuk halaman admin rumah sakit dan akses yang dibatasi oleh rumah sakit.
- Tambahkan middleware khusus `requireSuperAdmin` untuk dashboard serta endpoint manajemen akun.
- Jangan membuat `requireSuperAdmin` otomatis lolos ke semua route chat pasien. Tambahkan permission terpisah, misalnya `patient_data_read`, dengan MFA/step-up authentication, alasan akses, ruang lingkup/waktu berlaku, serta audit khusus. Untuk versi awal permission ini hanya memberi baca-saja; tindakan tulis dan ekspor massal tetap ditolak.
- Semua perubahan data akun memakai `POST`/`PATCH`/`DELETE` yang sesuai, CSRF, rate limit, validasi server-side, dan pengecekan ulang target di server. Jangan mengandalkan tombol yang disembunyikan di UI sebagai kontrol keamanan.

### 3. Otorisasi akses chat dan data pasien

- Gunakan middleware/permission khusus untuk halaman pencarian pasien, profil, API pesan, Socket.IO `join-room`, dan endpoint file. Jangan mengandalkan hanya proteksi halaman HTML.
- Untuk pengguna dengan `patient_data_read`, verifikasi permission dari database pada setiap request sensitif; jangan menerima `roomId`, `patientId`, rumah sakit, atau alasan akses sebagai bukti hak.
- Batasi sesi pemantauan dengan step-up MFA dan alasan wajib. Sesi akses khusus dapat kedaluwarsa otomatis; setiap pembacaan dan unduhan tetap harus dicatat.
- Jangan memberikan hak `message`, `delete`, `upload`, `pin`, atau `export` kepada Super Admin melalui permission baca-pasien.
- Hindari memasukkan isi chat dan data pasien dalam audit log; catat referensi internal dan metadata minimum yang dibutuhkan untuk investigasi.

### 4. Provisioning akun `ekoandyan@gmail.com`

1. Pastikan alamat tersebut benar-benar dikuasai dan akan dipantau oleh penanggung jawab institusi; aktifkan verifikasi dua langkah pada akun email dan amankan opsi pemulihannya.
2. Buat perintah provisioning satu kali yang dijalankan operator berwenang di lingkungan deployment—bukan endpoint publik dan bukan seed password dalam `schema.sql`.
3. Perintah memeriksa email yang telah diverifikasi, menetapkan role `super_admin`, dan mengirim tautan aktivasi sekali pakai agar pemilik menetapkan password sendiri.
4. Wajibkan MFA untuk role Super Admin sebelum hak administratif digunakan. Simpan secret MFA secara aman; kode pemulihan harus sekali pakai dan hanya hash yang disimpan.
5. Setelah login pertama, catat peristiwa provisioning, minta pemilik meninjau akun admin yang ada, dan uji pencabutan sesi.
6. Sediakan satu akun pemulihan terpisah yang dikendalikan organisasi bila kebijakan mengharuskan kesinambungan layanan; jangan berbagi satu password antarpetugas.

Jika Gmail tersebut merupakan akun personal dan bukan mailbox yang dijamin tetap dikuasai organisasi, pertimbangkan mailbox institusi khusus sebelum menggunakannya sebagai satu-satunya akun dengan hak tertinggi.

### 5. Skema audit dan login

- Buat tabel append-only `admin_audit_events` dengan foreign key aktor/target bila tersedia, nama tindakan, waktu, hasil, dan metadata yang sudah disaring.
- Tambahkan pencatatan waktu login admin terakhir dan/atau tabel login events untuk riwayat yang diperlukan; tentukan batas retensi dan indeks agar query dashboard efisien.
- Tambahkan event audit spesifik untuk akses pasien: `patient_search`, `patient_profile_view`, `chat_history_view`, `attachment_view/download`, serta `break_glass_access`. Simpan ID internal/room, rumah sakit, alasan, waktu, hasil, dan aktor; hindari merekam isi pesan atau data identitas lengkap.
- Pastikan akun runtime tidak dapat mengubah atau menghapus audit historis secara sembarang; batasi akses pembacaan log ke Super Admin yang berwenang dan petugas audit.
- Untuk penonaktifan, reset keamanan, atau perubahan role, naikkan `session_version`, cabut token yang belum dipakai bila perlu, dan pastikan sesi lama ditolak pada request berikutnya.

## Tahapan implementasi

### Tahap 1 — Persetujuan kebijakan dan inventaris

Tentukan pemilik akun Super Admin, tujuan sah pemantauan chat/data pasien, kategori data yang boleh dilihat, batasan rumah sakit, apakah alasan akses diperlukan per room, masa retensi log, proses tinjauan akses, serta tindakan apa yang membutuhkan persetujuan kedua. Tentukan juga kebijakan pemberitahuan pasien/petugas.

**Kriteria selesai:** ruang lingkup dan tujuan akses lintas rumah sakit tertulis serta disetujui penanggung jawab organisasi; akses baca-pasien dapat dinonaktifkan terpisah dari pengelolaan akun.

### Tahap 2 — Migrasi role dan provisioning

Tambahkan role dan constraint secara kompatibel. Beri role `hospital_admin` pada akun yang sudah ada setelah pemetaan rumah sakit diperiksa. Buat provisioning satu kali untuk `ekoandyan@gmail.com`; jangan menetapkan Super Admin melalui perbandingan email di kode atau seed password.

**Kriteria selesai:** akun lama tetap dapat login dengan cakupan yang sama; hanya provisioning khusus yang dapat memberi role Super Admin.

### Tahap 3 — Middleware dan MFA

Implementasikan `requireSuperAdmin`, permission terpisah `patient_data_read`, verifikasi role/status/session version di server, MFA dan step-up authentication, serta pemisahan akses pengelolaan akun, pembacaan pasien, dan tindakan tulis.

**Kriteria selesai:** manipulasi session/cookie, ID akun, URL, room, atau payload tidak dapat menaikkan role/permission; admin rumah sakit tidak dapat membuka dashboard global; permission baca tidak dapat dipakai untuk mengubah data.

### Tahap 4 — Dashboard dan tindakan akun

Bangun daftar/filter akun, ringkasan login, aktivasi/nonaktif, pengelolaan rumah sakit, tautan aktivasi/reset, dan pencabutan sesi. Bangun panel pemantauan pasien/chat terpisah, baca-saja, dengan alasan akses, masking, batas pencarian, dan indikator sesi pemantauan. Tambahkan konfirmasi untuk tindakan berdampak tinggi.

**Kriteria selesai:** Super Admin dapat menjalankan tugas akun yang disetujui dan membaca data pasien hanya dengan permission aktif; password/hash/token tidak pernah terlihat; akses pasien dan tindakan penting terekam.

### Tahap 5 — Audit, peringatan, dan uji staging

Tambahkan event audit dan peringatan terbatas. Uji semua role dengan akun dummy dan rumah sakit uji, termasuk akses pasien lintas rumah sakit yang sah, pencarian tanpa alasan, percobaan ekspor/tulis, akses socket/file tanpa permission, CSRF, sesi kedaluwarsa, role yang dicabut, MFA gagal, serta penonaktifan saat sesi masih aktif.

**Kriteria selesai:** seluruh tes negatif menolak akses, akses baca yang sah tercatat dengan aktor/target/alasan yang benar, audit dan peringatan tidak menyimpan isi chat atau data pasien yang tidak diperlukan.

## Skenario uji penerimaan

1. `ekoandyan@gmail.com` hanya memperoleh role Super Admin setelah provisioning dan verifikasi; email serupa atau casing berbeda tidak dapat mengambil role melalui form.
2. Super Admin dapat melihat akun admin lintas rumah sakit, tetapi tidak dapat melihat password, hash, token, atau secret.
3. Super Admin dengan `patient_data_read` dan MFA dapat mencari serta membaca profil/riwayat chat pasien sesuai ruang lingkup yang disetujui; akses tanpa permission atau tanpa alasan ditolak.
4. Permission baca-pasien tidak mengizinkan mengirim pesan, mengubah data, menghapus, atau mengunduh massal; akses lampiran memerlukan pemeriksaan dan pencatatan tersendiri.
5. Admin rumah sakit hanya melihat admin di lingkupnya bila fitur itu disediakan, dan tidak dapat membuka dashboard global atau mengubah akun rumah sakit lain.
6. Super Admin dapat menonaktifkan akun; sesi akun tersebut ditolak pada request berikutnya.
7. Perubahan role atau penempatan rumah sakit mencabut sesi lama dan tercatat di audit.
8. Reset akun dilakukan melalui tautan satu kali; token kedaluwarsa/terpakai ditolak dan respons publik tidak mengungkap keberadaan email.
9. Akses Super Admin membutuhkan MFA; kegagalan MFA tidak membuat sesi berhak tinggi.
10. Semua perubahan dilindungi CSRF, rate limit, validasi server, dan dicatat; percobaan langsung ke endpoint tanpa role ditolak.
11. Setiap pencarian, pembukaan chat, dan lampiran mencatat aktor, pasien/room, rumah sakit, alasan, dan waktu tanpa menyimpan isi pesan dalam log.

## Urutan kerja yang disarankan

1. Sahkan ruang lingkup dan kebijakan pemantauan akun.
2. Verifikasi penguasaan mailbox `ekoandyan@gmail.com`, MFA email, dan prosedur pemulihan.
3. Migrasikan role serta provision akun Super Admin lewat alat operator satu kali.
4. Implementasikan MFA, middleware/route khusus, dan permission baca-pasien yang terpisah dari tindakan tulis.
5. Bangun dashboard akun serta panel pemantauan chat/data pasien baca-saja sesuai kebijakan.
6. Tambahkan audit akses pasien, peringatan, tinjauan berkala, pengujian staging, dan dokumentasi pemulihan.
7. Rilis bertahap setelah seluruh skenario penerimaan lulus.

**Catatan:** ini adalah rencana desain. Akun Super Admin belum dibuat dan kode aplikasi belum diubah.
