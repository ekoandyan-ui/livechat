# Rencana ID Pasien Tetap dan Lanjutkan Chat

## Tujuan dan aturan perilaku

1. Setiap pasien memiliki **satu identitas/ID yang tetap** selama data pasien masih ada di database.
2. Menekan Back, meninggalkan halaman, menutup browser, atau kembali di kemudian hari **tidak membuat pasien/room baru** dan tidak menghapus riwayat chat.
3. Saat pasien kembali dan percakapan masih ada, aplikasi menampilkan pemberitahuan dengan **satu pilihan saja: “Lanjutkan chat”**. Tidak ada pilihan “Mulai baru”.
4. Jika admin menjalankan **Hapus Total Chat**, identitas pasien dan seluruh pesan terkait dihapus sesuai fungsi penghapusan total saat ini. ID lama tidak digunakan lagi. Jika orang tersebut mendaftar kembali, sistem membuat ID baru.
5. Jika data sudah dihapus admin, aplikasi tidak boleh memulihkan atau membuka kembali room lama dari localStorage, URL, cache, atau sesi yang tertinggal.

## Temuan pada implementasi saat ini

- `POST /tambah` selalu menjalankan `INSERT INTO patients`, sehingga setiap pengiriman form membuat baris pasien dan ID baru.
- `views/index.ejs` menyimpan referensi chat di localStorage, tetapi overlay saat ini menampilkan **Lanjutkan Chat** dan **Mulai Baru**; query `startNew=1` juga menghapus referensi tersebut.
- Dialog Back di `views/chat.ejs` saat ini menawarkan “Lanjutkan chat” dan “Mulai baru”.
- `deletePatientFully()` menghapus pesan dan baris pasien. Dengan ID database berurutan, ID yang sudah dihapus sebaiknya tidak dipakai ulang.
- Sesi aplikasi dapat memakai MemoryStore saat Redis tidak disiapkan. Sesi memori dapat hilang saat server restart dan tidak cocok untuk produksi/multi-instance.

## Keputusan rancangan yang disarankan

### ID dan cara mengenali pasien

- Pertahankan `patients.id` sebagai ID internal yang stabil selama baris pasien hidup.
- Jangan menggunakan nama, alamat, atau nomor WhatsApp yang diketik ulang sebagai bukti identitas. Data tersebut mudah salah ketik atau diketahui orang lain.
- Untuk kembali pada **browser/perangkat yang sama**, gunakan sesi server persisten sebagai sumber identitas utama; localStorage hanya menjadi petunjuk UI, bukan bukti otorisasi.
- Untuk kembali setelah cookie/localStorage dibersihkan atau dari **perangkat lain**, perlu langkah pembuktian identitas, misalnya OTP ke nomor WhatsApp yang sudah diverifikasi atau kode pemulihan acak yang dibuat server. Aplikasi sekarang belum memiliki autentikasi pasien/layanan OTP, sehingga cakupan lintas perangkat harus diputuskan sebelum implementasi.
- Jika ID pasien perlu muncul di tautan atau dibagikan ke client, gunakan identifier acak/opaque seperti UUID untuk ID publik; jangan jadikan nomor urut database sebagai kredensial akses. Tetap wajib memeriksa sesi dan kepemilikan room di server.

> Rekomendasi awal: fase pertama menjamin resume pada browser yang sama dengan sesi server persisten. Fase lintas perangkat ditambahkan setelah metode verifikasi pasien dipilih dan tersedia.

## Rencana implementasi

### Tahap 1 — Tetapkan status dan siklus hidup chat

Buat aturan server-side yang eksplisit:

- **Aktif:** baris pasien dan room masih ada; pasien berhak melanjutkan room tersebut.
- **Dihapus:** admin telah menghapus total; room tidak dapat digunakan dan semua referensi resume harus dicabut.
- Keluar dari halaman atau browser **bukan** tindakan hapus dan tidak mengubah status pasien.
- Pendaftaran baru hanya dilakukan ketika tidak ada identitas/room aktif yang dapat dilanjutkan atau identitas lama telah dihapus.

### Tahap 2 — Gunakan sesi server sebagai sumber identitas

1. Setelah pendaftaran pertama berhasil, simpan relasi pasien/room di sesi server dan pertahankan sesi secara aman.
2. Siapkan Redis/session store persisten untuk produksi dan semua instance; gunakan `SESSION_SECRET` yang konsisten. Jangan mengandalkan MemoryStore untuk resume lintas restart.
3. Saat pasien mengunjungi `/`, server memeriksa sesi pasien, lalu memverifikasi bahwa baris pasien dan room masih ada.
4. Jika masih aktif, render halaman pemberitahuan “Anda memiliki percakapan yang masih berlangsung” dengan **hanya tombol “Lanjutkan chat”**. Tombol membawa pasien ke room yang berasal dari sesi server, bukan ID room yang dipercaya dari browser.
5. Jika sesi tidak ada tetapi localStorage memiliki data lama, jangan langsung membuka room. Tampilkan langkah verifikasi yang ditentukan (fase pertama dapat meminta pasien mendaftar/masuk kembali; fase lintas perangkat memerlukan OTP atau kode pemulihan).
6. Jika server menyatakan pasien/room sudah dihapus, bersihkan sesi dan localStorage, lalu tampilkan pemberitahuan bahwa percakapan lama telah dihapus. Jangan menampilkan tombol resume untuk room tersebut.

### Tahap 3 — Hilangkan jalur “Mulai baru” dari chat aktif

- Hapus tombol dan handler “Mulai baru” dari dialog Back di `views/chat.ejs`.
- Ubah dialog menjadi satu aksi utama **“Lanjutkan chat”**. Deskripsi menjelaskan bahwa kembali ke chat menjaga percakapan yang sedang berjalan.
- Saat tombol Back browser ditekan, tetap tahan navigasi dan tampilkan dialog. Menekan “Lanjutkan chat” menutup dialog dan tetap berada di room yang sama.
- Hapus cabang `startNew=1` dan tombol “Mulai Baru” pada `views/index.ejs` setelah jalur resume server-side siap. Jangan menghapus localStorage/session hanya karena pasien menutup browser.
- Pastikan halaman tidak menawarkan pendaftaran kedua ketika sesi pasien valid; cegah pengiriman ganda form dengan token/idempotensi dan pemeriksaan server.

### Tahap 4 — Cegah pembuatan ID ganda

Ubah alur `POST /tambah` agar tidak selalu membuat pasien baru:

1. Jika sesi menunjuk pada pasien aktif, arahkan kembali ke room pasien itu alih-alih menjalankan `INSERT` baru.
2. Jika belum ada sesi aktif, jalankan proses pendaftaran baru dan buat ID satu kali.
3. Gunakan transaksi dan constraint unik untuk kunci pendaftaran/idempotency yang sesuai agar klik ganda, refresh POST, atau retry jaringan tidak menghasilkan pasien ganda.
4. Jangan menyimpulkan pasien yang sama hanya dari nama/alamat. Untuk mengenali pasien lintas perangkat, gunakan langkah verifikasi yang disepakati.
5. Pertahankan pembatasan rumah sakit: pasien hanya dapat melanjutkan room yang terikat ke rumah sakit/identitasnya.

### Tahap 5 — Tangani penghapusan total oleh admin

1. Pertahankan makna **Hapus Total**: hapus pasien, pesan, lampiran, data unread/metadata room, dan subscription notifikasi yang berkaitan jika fitur push sudah ada.
2. Jalankan penghapusan dalam transaksi agar tidak tertinggal sebagian data bila salah satu query gagal.
3. Setelah berhasil, kirim event `chat-deleted` ke client yang sedang online dan invalidasi identitas/session pasien yang terkait.
4. Di browser pasien, hapus referensi resume dan navigasikan ke halaman awal dengan pesan netral: “Percakapan ini telah dihapus. Untuk memulai percakapan, isi formulir kembali.”
5. Pada kunjungan berikutnya, cek keberadaan pasien di server sebelum menawarkan resume. Jangan mengandalkan timer/localStorage saja.
6. Bila pasien mendaftar kembali setelah data lama benar-benar dihapus, buat ID baru; jangan menggunakan ulang ID lama.

### Tahap 6 — Privasi dan keamanan resume

- Jangan memasukkan alamat, nomor WhatsApp, isi pesan, atau credential pemulihan ke localStorage, URL, atau teks notifikasi.
- Terapkan pemeriksaan identitas/otorisasi pada setiap route dan Socket.IO event untuk room; mengetahui `roomId` saja tidak boleh cukup untuk membaca chat.
- Terapkan CSRF pada form/endpoint mutasi, rate limit untuk pendaftaran dan verifikasi, serta cookie sesi `HttpOnly`, `SameSite`, dan `Secure` di HTTPS produksi.
- Jika memakai OTP/kode pemulihan, simpan hanya hash token, beri masa berlaku, batasi percobaan, gunakan sekali pakai, dan jangan catat token ke log.
- Sediakan pesan error yang tidak membocorkan apakah nomor tertentu terdaftar.

## Pengujian dan kriteria penerimaan

Uji di staging menggunakan pasien dan pesan dummy:

1. Pasien mendaftar sekali: satu baris pasien dan satu room dibuat.
2. Pasien menekan Back: hanya dialog dengan tombol **Lanjutkan chat** yang muncul; tidak ada “Mulai baru”.
3. Pasien menutup tab/browser lalu membuka aplikasi kembali pada browser yang sama: pemberitahuan resume muncul dan tombol membuka room dengan ID yang sama.
4. Refresh, koneksi terputus, pengiriman form ganda, atau restart server tidak membuat pasien/room duplikat (dengan session store persisten aktif).
5. Tanpa sesi yang valid, manipulasi localStorage atau URL room tidak memberi akses ke percakapan.
6. Admin menghapus total: pasien, pesan, dan referensi resume tidak dapat dipulihkan; browser pasien menerima pemberitahuan atau menemukan status terhapus saat kunjungan berikutnya.
7. Setelah penghapusan dan pendaftaran baru, pasien memperoleh ID baru, bukan ID lama yang dipakai ulang.
8. Admin rumah sakit lain tidak dapat mengakses atau menghapus room tersebut.
9. Jalur chat, Socket.IO, CSRF, unread badge, unggahan, dan login admin tetap berfungsi.

**Kriteria rilis:** hanya satu ID/room dibuat per pendaftaran aktif; resume kembali memakai ID yang sama selama data belum dihapus; pilihan “Mulai baru” tidak tersedia; penghapusan admin membuat ID/room lama tidak dapat dipakai; tidak ada akses room hanya berdasarkan data browser.

## Urutan kerja yang disarankan

1. Putuskan cakupan resume: browser sama saja atau termasuk lintas perangkat; untuk lintas perangkat, pilih OTP/kode pemulihan.
2. Siapkan Redis/session store produksi dan identitas pasien yang tervalidasi server.
3. Ubah halaman awal menjadi pemberitahuan resume dengan satu tombol.
4. Hapus pilihan “Mulai baru” dari dialog Back dan jalur `startNew`.
5. Ubah `POST /tambah` agar resume sesi aktif, bukan membuat row baru.
6. Perkuat transaksi dan cleanup pada penghapusan total admin.
7. Jalankan checklist pengujian di staging sebelum rilis.
