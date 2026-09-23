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
CREATE TABLE IF NOT EXISTS admins (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  rumah_sakit TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Jika tabel sudah ada tanpa kolom rumah_sakit, jalankan ini:
-- ALTER TABLE admins ADD COLUMN IF NOT EXISTS rumah_sakit TEXT NOT NULL DEFAULT '';

-- 5. Insert 6 admin rumah sakit
INSERT INTO admins (username, password, rumah_sakit) VALUES
  ('rsudsunan', 'rsudsunan123', 'RSUD Sunan Kalijaga'),
  ('rsinahdlatul', 'rsinahdlatul123', 'RSI Nahdlatul Ulama'),
  ('rspelita', 'rspelita123', 'RS Pelita Anugerah'),
  ('rsudsfatah', 'rsudsfatah123', 'RSUD Sultan Fatah'),
  ('rshjfatimah', 'rshjfatimah123', 'RS Hj. Fatimah Sulhan'),
  ('charliehospital', 'charlie123', 'Charlie Hospital')
ON CONFLICT (username) DO NOTHING;

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
