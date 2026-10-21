# Rencana Membuat Pesan Admin dan Pasien Real-Time Tanpa Refresh

## Tujuan

Pesan yang dikirim pasien tampil di layar admin dan pesan yang dikirim admin tampil di layar pasien secara langsung, tanpa memuat ulang halaman. Bila koneksi terputus sementara, pesan yang tersimpan tidak hilang dari tampilan setelah koneksi pulih. Pengirim juga mendapat status yang jelas apakah pesan berhasil, masih menunggu, atau gagal.

> Dokumen ini adalah rencana. Source aplikasi tidak diubah.

## Kondisi implementasi saat ini

Kode sudah mempunyai fondasi real-time:

- `server.js` menyambungkan Socket.IO dengan middleware sesi Express (`io.engine.use(sessionMiddleware)`, sekitar baris 129).
- Event `join-room` memeriksa identitas sesi dan kecocokan room/rumah sakit sebelum memasukkan socket ke room (sekitar baris 3394–3425).
- Event `message` menyimpan teks ke database, kemudian memancarkan `room-message` kepada anggota room (sekitar baris 3435–3504).
- Upload lampiran juga memancarkan `room-message` setelah file disimpan (sekitar baris 3007–3023).
- `views/admin-room.ejs` dan `views/chat.ejs` membuat koneksi Socket.IO, mengirim event `message`, menerima `room-message`, lalu menambahkan pesan ke DOM tanpa refresh (masing-masing sekitar baris 142–234 dan 172–325). Keduanya mencegah render ganda berdasarkan ID pesan.
- Dashboard admin menerima `room-activity` dan `unread-update`, tetapi saat ini menjalankan `location.reload()` setiap 30 detik (`views/admin.ejs` sekitar baris 193) dan me-reload halaman bila room baru belum ada di daftar (sekitar baris 400–421).

Jadi, tujuan utama bukan membuat event Socket.IO dari nol, melainkan memastikan koneksi, pengiriman, penyimpanan, pengakuan, dan pemulihan setelah reconnect berjalan konsisten.

## Celah yang perlu ditangani

1. Client memanggil `socket.emit('message', ...)` lalu langsung mengosongkan input; belum menunggu acknowledgement bahwa database berhasil menyimpan pesan.
2. Server dapat mengabaikan pesan tanpa memberi tahu pengirim, misalnya saat rate limit tercapai atau validasi/otorisasi menolak event. Kegagalan DB hanya dicatat di log server. Pengirim dapat mengira pesan sudah terkirim padahal belum.
3. Kedua halaman melakukan `join-room` satu kali saat awal. Belum terlihat pengiriman ulang `join-room` pada event reconnect; setelah socket tersambung kembali, socket baru perlu bergabung ulang ke room.
4. Tidak ada sinkronisasi eksplisit pesan yang terlewat selama koneksi putus. Socket.IO menyampaikan event saat koneksi aktif, tetapi UI tetap perlu mengambil pesan tersimpan setelah reconnect.
5. Dashboard masih melakukan full refresh berkala, dan room baru memicu reload agar muncul. Ini tidak diperlukan untuk pembaruan pesan biasa dan dapat mengganggu navigasi admin.

## Tahapan implementasi

### Tahap 1 — Tetapkan kontrak pengiriman pesan

- Tetapkan satu format event bersama teks dan lampiran, termasuk `clientMessageId` unik, `roomId`, isi/jenis pesan, metadata balasan, dan identitas yang ditentukan server.
- Identitas pengirim harus selalu bersumber dari session server; jangan mempercayai `senderName` yang dikirim browser.
- Server memvalidasi sesi, hak akses room/rumah sakit, ukuran dan format payload sebelum menyimpan.
- Definisikan acknowledgement (ACK) sukses hanya setelah database berhasil menyimpan pesan; respons sukses membawa objek pesan kanonis dari server (ID database, waktu, pengirim, jenis, reply, dan metadata file yang aman).
- Definisikan ACK gagal dengan kode yang dapat ditangani client, misalnya `NOT_AUTHORIZED`, `RATE_LIMITED`, `VALIDATION_ERROR`, `DB_UNAVAILABLE` atau `RETRYABLE`—tanpa membocorkan detail internal.

**Kriteria selesai:** pengirim dapat membedakan pesan tersimpan dari pesan yang ditolak atau gagal.

### Tahap 2 — Buat penyimpanan dan pengiriman idempoten

- Simpan pesan terlebih dahulu dalam transaksi database; baru setelah sukses server memancarkan `room-message` kepada semua anggota room.
- Tambahkan kunci pesan client yang unik (misalnya `clientMessageId`) dan constraint/penyimpanan deduplikasi yang sesuai. Retry dari browser dengan ID yang sama harus mengembalikan hasil pesan yang sama, bukan membuat duplikat.
- Perbarui unread count dan aktivitas room secara konsisten setelah operasi simpan berhasil; kegagalan salah satu langkah dicatat dan dipulihkan tanpa memancarkan event sukses palsu.
- Untuk lampiran, pertahankan alur upload HTTP yang sudah ada; balas sukses hanya setelah DB menyimpan file dan event room dapat dipancarkan. Client menggunakan ID pesan yang sama untuk menghindari duplikasi antara respons upload dan event Socket.IO.

**Kriteria selesai:** retry setelah timeout atau ACK hilang tidak menggandakan pesan, dan event sukses tidak pernah dikirim sebelum data tersimpan.

### Tahap 3 — Tambahkan status pesan di UI admin dan pasien

- Ubah status pesan menjadi `mengirim` saat pengguna menekan Kirim.
- Setelah ACK sukses, tandai `terkirim` dan ganti tampilan sementara dengan data kanonis dari server.
- Jika timeout/koneksi putus, tandai `belum terkirim` dengan opsi **Coba lagi** yang menggunakan `clientMessageId` yang sama.
- Jangan menghapus teks dari input sebelum ada ACK sukses, atau simpan sebagai bubble pending yang dapat dipulihkan; cegah pengiriman ganda selama request masih pending.
- Bila pengirim juga menerima broadcast untuk pesannya sendiri, satukan bubble pending dan event server berdasarkan `clientMessageId`/ID database, bukan menambahkan dua bubble.
- Tampilkan banner status koneksi yang sederhana: **Terhubung**, **Menyambungkan kembali**, atau **Offline**; nonaktifkan atau beri status pada tombol kirim sesuai kebijakan yang dipilih.

**Kriteria selesai:** kegagalan koneksi/server terlihat oleh pengirim dan pesan tidak hilang diam-diam.

### Tahap 4 — Rejoin dan sinkronkan pesan setelah reconnect

- Pasang handler `connect`, `disconnect`, dan `connect_error` pada kedua halaman.
- Setiap event `connect` (termasuk koneksi ulang) mengirim ulang `join-room` dengan payload yang sama, lalu menunggu konfirmasi server `room-joined` sebelum client menganggap room aktif.
- Server tetap melakukan pemeriksaan sesi dan otorisasi setiap kali join; reconnect tidak boleh menjadi jalan untuk mengakses room lain.
- Simpan cursor pesan terakhir yang terkonfirmasi, seperti ID pesan database monotonik. Setelah `room-joined`, minta pesan yang lebih baru dari cursor melalui endpoint/API history yang sudah ada atau endpoint terotorisasi dengan `afterId`.
- Render hasil catch-up secara deduplicated dan urutkan berdasarkan ID/waktu server. Jangan mengandalkan event live saja untuk pesan yang mungkin terlewat saat offline.
- Tambahkan timeout dan fallback yang ramah jika rejoin atau sinkronisasi gagal; jangan reload halaman sebagai mekanisme pemulihan utama.

**Kriteria selesai:** setelah Wi-Fi dimatikan sementara lalu dinyalakan, socket bergabung kembali dan pesan selama offline muncul tanpa refresh.

### Tahap 5 — Perbarui dashboard admin tanpa full reload

- Hapus refresh berkala `location.reload()` setiap 30 detik setelah pembaruan DOM real-time teruji.
- Untuk event `room-activity`, perbarui preview pesan terakhir, waktu, unread badge dan urutan room langsung pada DOM.
- Jika room baru belum ada, tambahkan item room secara incremental menggunakan data minimum yang aman, atau panggil `GET /api/rooms` lalu sinkronkan daftar tanpa reload seluruh dokumen.
- Setelah reconnect, sinkronkan daftar room/unread dari server agar event yang terlewat tidak meninggalkan badge atau urutan yang salah.
- Full page reload boleh tetap tersedia sebagai fallback manual; tindakan admin seperti perubahan pin/hapus dapat diperbarui secara lokal atau memakai sinkronisasi daftar.

**Kriteria selesai:** pesan baru dan unread preview tampil di sidebar tanpa memuat ulang dashboard.

### Tahap 6 — Ketahanan deployment

- Pastikan client menggunakan endpoint Socket.IO pada origin aplikasi yang benar dan cookie sesi ikut saat handshake.
- Pantau `connect_error`, reconnect attempts, jumlah ACK sukses/gagal, latensi simpan-ke-tampil dan jumlah pesan catch-up; jangan mencatat isi chat, nama lengkap, nomor WA, token, atau cookie.
- Jika deployment hanya satu instance, pengelolaan room lokal cukup untuk tahap awal. Jika ada beberapa instance, gunakan Socket.IO adapter bersama (misalnya Redis adapter) dan konfigurasi load balancer/sticky session yang cocok; tanpa itu, socket pada instance berbeda dapat tidak menerima broadcast satu sama lain.
- Pastikan server dan browser menggunakan versi event/kontrak yang kompatibel saat deploy bertahap.

## Skenario pengujian

1. Buka satu room di browser pasien dan satu room yang sama di browser admin. Kirim pesan pasien → pesan tampil di admin tanpa refresh; kirim balasan admin → tampil di pasien tanpa refresh.
2. Uji pengirim dan penerima pada perangkat/jaringan berbeda, termasuk Android dan browser desktop.
3. Matikan jaringan selama beberapa detik pada salah satu sisi, kirim pesan di sisi lain, pulihkan jaringan; pastikan socket rejoin dan pesan terlewat disinkronkan tanpa duplikat.
4. Simulasikan ACK terlambat/hilang dan retry; pesan tersimpan paling banyak satu kali dan status UI akhirnya benar.
5. Simulasikan DB gagal atau validasi/rate limit; pengirim melihat status gagal yang dapat dipahami dan tidak melihat pesan seolah berhasil.
6. Uji pesan teks, balasan, pesan panjang, karakter khusus/HTML, dan lampiran foto/dokumen yang diizinkan; konten tidak dieksekusi sebagai HTML dan event hanya masuk ke room yang benar.
7. Uji dua room berbeda dan admin dari RS berbeda; pesan tidak boleh terlihat di room atau rumah sakit lain.
8. Pastikan unread count, preview sidebar dan urutan room berubah tanpa refresh.
9. Uji saat socket reconnect berulang dan saat halaman dibuka dalam beberapa tab; tidak ada listener ganda, duplikat pesan, atau kebocoran memory.
10. Uji deployment multi-instance bila memang digunakan; pesan harus diterima klien yang terhubung ke instance berbeda.

## Urutan prioritas

1. **P0:** ACK server setelah persistensi dan status gagal yang terlihat di kedua client; saat ini input langsung dibersihkan dan server dapat menolak tanpa respons ke client.
2. **P1:** Rejoin room setiap reconnect dan catch-up pesan berdasarkan cursor.
3. **P1:** Idempotensi untuk menghindari duplikat saat retry/ACK hilang.
4. **P2:** Hilangkan reload otomatis dashboard dan sinkronkan sidebar secara incremental.
5. **P2:** Validasi upload/realtime, keamanan scope room, serta pengujian dua perangkat dan jaringan terputus.
6. **P3:** Adapter Socket.IO bersama jika skala deployment lebih dari satu instance; instrumentasi metrik real-time yang menjaga privasi.

**Catatan:** source saat ini sudah memiliki pengiriman event dasar `room-message`. Implementasi yang disarankan harus memperkuat dan menguji jalur yang ada, bukan membuat sistem pesan kedua yang terpisah.
