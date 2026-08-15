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
