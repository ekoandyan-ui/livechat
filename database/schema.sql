-- =============================================
-- SCHEMA: Live Chat App (Dinkes)
-- Jalankan SQL ini di Supabase SQL Editor
-- =============================================

-- 1. Pastikan tabel "user" sudah ada (dari project sebelumnya)
-- Kalau belum, buat dulu:
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  nama TEXT NOT NULL,
  kelas TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

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

-- 4. (Opsional) Tabel admin untuk login admin
CREATE TABLE IF NOT EXISTS admins (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Insert admin default (username: admin, password: admin123)
-- Hapus baris ini setelah login pertama, atau ganti password-nya
INSERT INTO admins (username, password) VALUES ('admin', 'admin123')
ON CONFLICT (username) DO NOTHING;
