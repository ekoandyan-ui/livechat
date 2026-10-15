-- =============================================
-- SCHEMA: Live Chat App (Dinkes)
-- Jalankan SQL ini di Supabase SQL Editor
-- =============================================

-- 1. Tabel "patients" (sebelumnya "user")
CREATE TABLE IF NOT EXISTS patients (
  id SERIAL PRIMARY KEY,
  nama TEXT NOT NULL,
  alamat TEXT NOT NULL DEFAULT '',
  nomor_wa TEXT NOT NULL DEFAULT '',
  rumah_sakit TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Jika tabel sudah ada, jalankan ini untuk menambah kolom alamat & nomor WA:
-- ALTER TABLE patients ADD COLUMN IF NOT EXISTS alamat TEXT NOT NULL DEFAULT '';
-- ALTER TABLE patients ADD COLUMN IF NOT EXISTS nomor_wa TEXT NOT NULL DEFAULT '';
-- (opsional hapus kolom kelas: ALTER TABLE patients DROP COLUMN IF EXISTS kelas;)

-- 2. Tabel messages untuk menyimpan chat secara permanen
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  room_id TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Index untuk performa query
CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages(room_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

-- 4. Tabel admin untuk login admin rumah sakit
-- username dipertahankan sebagai identifier internal (label & data historis),
-- tetapi LOGIN memakai kolom email.
CREATE TABLE IF NOT EXISTS admins (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT,
  password TEXT NOT NULL,
  rumah_sakit TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Jika tabel sudah ada tanpa kolom rumah_sakit, jalankan ini:
-- ALTER TABLE admins ADD COLUMN IF NOT EXISTS rumah_sakit TEXT NOT NULL DEFAULT '';

-- 5. Kolom email + keunikan case-insensitive (migrasi bertahap).
--    Alur: tambah kolom (nullable) -> isi & verifikasi email ->
--    buat unique index. Lihat database/migrate-admin-emails.js
ALTER TABLE admins ADD COLUMN IF NOT EXISTS email TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_admins_email_lower
  ON admins (LOWER(email)) WHERE email IS NOT NULL;

-- CATATAN KEAMANAN:
-- Tidak ada seed password default. Akun admin di-provisioning secara terpisah
-- dan password disimpan hanya sebagai hash. Jangan pernah menulis password,
-- token aktivasi, atau token reset ke Git, log, tiket, atau dokumen bersama.

-- 6. Index untuk isolasi rumah sakit
CREATE INDEX IF NOT EXISTS idx_admins_rumah_sakit ON admins(rumah_sakit);

-- 7. Kolom lampiran pada tabel messages (foto / video / dokumen)
-- message_type: 'text' (biasa) atau 'file' (lampiran)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_type TEXT NOT NULL DEFAULT 'text';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_name TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_mime TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_data TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_size BIGINT;

-- 8. Kolom balas pesan (reply) pada tabel messages
-- reply_to berisi id pesan asli yang dibalas (NULL jika bukan pesan balasan)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to BIGINT;
CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to);

-- 9. Tabel visibilitas pesan untuk fitur "Hapus untuk Saya"
-- Mencatat pesan mana saja yang disembunyikan dari pengguna tertentu
-- (pesan tetap ada di database & tetap terlihat oleh lawan bicara)
CREATE TABLE IF NOT EXISTS message_visibility (
  message_id BIGINT NOT NULL,
  user_name TEXT NOT NULL,
  room_id TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (message_id, user_name)
);
CREATE INDEX IF NOT EXISTS idx_visibility_message ON message_visibility(message_id);

-- 10. Kolom "sematkan" room di daftar pasien admin
-- is_pinned: true = room muncul paling atas pada daftar room chat admin
ALTER TABLE patients ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN NOT NULL DEFAULT FALSE;

-- 11. Tabel notifikasi pesan belum dibaca per admin & room
-- unread_count: berapa pesan baru belum dibaca oleh admin pada room tsb.
-- Direset ke 0 saat admin membuka/membaca room chat tsb.
CREATE TABLE IF NOT EXISTS room_unread (
  admin_name TEXT NOT NULL,
  room_id TEXT NOT NULL,
  unread_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (admin_name, room_id)
);

-- 12. Aktivasi & manajemen password admin (Fase 3-4)
-- is_active        : akun hanya bisa login setelah aktivasi selesai (TRUE).
-- session_version  : dinaikkan setiap perubahan password -> semua sesi lama dicabut.
-- password         : dibuat NULLABLE agar akun "pending" belum punya password.
ALTER TABLE admins ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
ALTER TABLE admins ALTER COLUMN password DROP NOT NULL;

-- Token aktivasi / reset password (disimpan sebagai HASH, sekali pakai).
CREATE TABLE IF NOT EXISTS admin_tokens (
  id SERIAL PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,               -- 'activation' | 'reset'
  token_hash TEXT NOT NULL UNIQUE,      -- sha256(token) hex
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_tokens_admin ON admin_tokens(admin_id, purpose);
CREATE INDEX IF NOT EXISTS idx_admin_tokens_hash ON admin_tokens(token_hash);
