-- =============================================
-- SKEMA DATABASE LIVE CHAT & ADMIN DINKES (SUPABASE)
-- =============================================

-- 1. Tabel User / Pasien (Digunakan untuk Form Nama & Kelas)
CREATE TABLE IF NOT EXISTS "user" (
    id SERIAL PRIMARY KEY,
    nama VARCHAR(100) NOT NULL,
    kelas VARCHAR(50) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Tabel Admin Users (Digunakan untuk Login Username & Password)
CREATE TABLE IF NOT EXISTS "admin_users" (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'admin',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Insert Default Admin Account (Username: admin, Password: admin123)
-- Catatan: Password disimpan sebagai plaintext/hash default 'admin123'
INSERT INTO "admin_users" (username, password, role)
VALUES ('admin', 'admin123', 'admin')
ON CONFLICT (username) DO NOTHING;
