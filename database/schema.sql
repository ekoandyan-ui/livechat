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

-- Jika tabel sudah ada, jalankan ini untuk menambah kolom alamat & nomor WA & token:
-- ALTER TABLE patients ADD COLUMN IF NOT EXISTS alamat TEXT NOT NULL DEFAULT '';
-- ALTER TABLE patients ADD COLUMN IF NOT EXISTS nomor_wa TEXT NOT NULL DEFAULT '';
-- ALTER TABLE patients ADD COLUMN IF NOT EXISTS patient_token TEXT;
-- CREATE UNIQUE INDEX IF NOT EXISTS idx_patients_token ON patients(patient_token) WHERE patient_token IS NOT NULL;
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
  rumah_sakit TEXT,
  role TEXT NOT NULL DEFAULT 'hospital_admin',
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

-- 13. Web Push subscriptions (notifikasi pesan baru saat web ditutup)
-- endpoint  : URL push service (unik per perangkat/browser).
-- p256dh/auth: kunci subscription (data sensitif; jangan dicatat ke log).
-- owner_type/owner_id: pemilik subscription (pasien atau admin).
-- rumah_sakit: konteks otorisasi (admin wajib; pasien juga diisi dari room).
-- revoked_at : diisi saat pengguna mematikan notifikasi (unsubscribe).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id SERIAL PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('patient','admin')),
  owner_id INTEGER NOT NULL,
  rumah_sakit TEXT,
  room_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT chk_push_owner_admin CHECK (owner_type <> 'admin' OR rumah_sakit IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_push_owner ON push_subscriptions(owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_push_admin_rs ON push_subscriptions(owner_type, rumah_sakit) WHERE revoked_at IS NULL;

-- 14. Peran admin (role) & cakupan Super Admin
-- role        : 'hospital_admin' (lingkup satu rumah sakit) atau
--               'super_admin' (administratif global, tanpa akses isi percakapan).
-- rumah_sakit : WAJIB untuk hospital_admin; HARUS NULL untuk super_admin.
-- Migrasi data lama: lihat database/migrate-admin-roles.js
ALTER TABLE admins ADD COLUMN IF NOT EXISTS role TEXT;
UPDATE admins SET role = 'hospital_admin' WHERE role IS NULL OR btrim(role) = '';
ALTER TABLE admins ALTER COLUMN role SET DEFAULT 'hospital_admin';
ALTER TABLE admins ALTER COLUMN role SET NOT NULL;
ALTER TABLE admins ALTER COLUMN rumah_sakit DROP NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admins_role_chk') THEN
    ALTER TABLE admins ADD CONSTRAINT admins_role_chk
      CHECK (role IN ('hospital_admin','super_admin'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admins_role_scope_chk') THEN
    ALTER TABLE admins ADD CONSTRAINT admins_role_scope_chk CHECK (
      (role = 'hospital_admin' AND rumah_sakit IS NOT NULL AND btrim(rumah_sakit) <> '')
      OR (role = 'super_admin' AND rumah_sakit IS NULL)
    );
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_admins_role ON admins(role);

-- 15. Audit administratif (append-only) + riwayat login admin
-- JANGAN menyimpan password/hash/token/secret/isi chat di sini.
-- actor/target disimpan tanpa FK agar riwayat tetap utuh saat akun dihapus.
-- Waktu login terakhir (ringkas; detail ada di admin_login_events).
ALTER TABLE admins ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS admin_audit_events (
  id SERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_admin_id INTEGER,
  actor_username TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_admin_id INTEGER,
  target_username TEXT,
  result TEXT NOT NULL DEFAULT 'success',   -- success | failure | denied
  reason TEXT,
  metadata JSONB,
  ip_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_actor ON admin_audit_events(actor_admin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_target ON admin_audit_events(target_admin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_action ON admin_audit_events(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_time ON admin_audit_events(created_at DESC);

CREATE TABLE IF NOT EXISTS admin_login_events (
  id SERIAL PRIMARY KEY,
  admin_id INTEGER,
  email_attempted TEXT,
  success BOOLEAN NOT NULL,
  reason TEXT,
  ip_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_login_admin ON admin_login_events(admin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_login_time ON admin_login_events(created_at DESC);

-- Immutability: tolak UPDATE/DELETE. Escape hatch retensi: SET lc.allow_audit_purge='on'.
CREATE OR REPLACE FUNCTION admin_audit_immutable() RETURNS trigger AS $$
BEGIN
  IF current_setting('lc.allow_audit_purge', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'Tabel audit bersifat append-only (UPDATE/DELETE ditolak).';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_admin_audit_events_immutable ON admin_audit_events;
CREATE TRIGGER trg_admin_audit_events_immutable
  BEFORE UPDATE OR DELETE ON admin_audit_events
  FOR EACH ROW EXECUTE FUNCTION admin_audit_immutable();
DROP TRIGGER IF EXISTS trg_admin_login_events_immutable ON admin_login_events;
CREATE TRIGGER trg_admin_login_events_immutable
  BEFORE UPDATE OR DELETE ON admin_login_events
  FOR EACH ROW EXECUTE FUNCTION admin_audit_immutable();

-- 16. MFA (TOTP) + izin baca data pasien (Tahap 3)
-- mfa_secret      : secret TOTP, DIENKRIPSI di aplikasi (AES-256-GCM), bukan plaintext.
-- mfa_enabled     : TRUE setelah enrollment terverifikasi.
-- mfa_last_step   : nomor step TOTP terakhir yang diterima (anti-replay).
-- patient_data_read: permission terpisah, HANYA untuk super_admin; default FALSE.
-- Migrasi: lihat database/migrate-admin-mfa.js
ALTER TABLE admins ADD COLUMN IF NOT EXISTS mfa_secret TEXT;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS mfa_enrolled_at TIMESTAMPTZ;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS mfa_last_step BIGINT;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS patient_data_read BOOLEAN NOT NULL DEFAULT FALSE;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admins_patient_read_scope_chk') THEN
    ALTER TABLE admins ADD CONSTRAINT admins_patient_read_scope_chk
      CHECK (patient_data_read = FALSE OR role = 'super_admin');
  END IF;
END $$;

-- Kode pemulihan MFA: hanya HASH yang disimpan; sekali pakai (used_at).
CREATE TABLE IF NOT EXISTS admin_mfa_recovery_codes (
  id SERIAL PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mfa_recovery_admin ON admin_mfa_recovery_codes(admin_id);

-- Sesi izin baca data pasien: beralasan (reason), berjangka waktu (expires_at),
-- dapat dicabut (revoked_at). Read-only; tidak memberi hak tulis/ekspor.
CREATE TABLE IF NOT EXISTS admin_access_sessions (
  id SERIAL PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  reason TEXT NOT NULL,
  scope TEXT,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  ip_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_access_sessions_admin ON admin_access_sessions(admin_id, permission, expires_at DESC);

-- =============================================
-- BAGIAN 17: SESSION STORE (persisten)
-- Dipakai connect-pg-simple bila REDIS_URL tidak diset, agar login admin
-- tidak hilang saat server di-restart (pengganti MemoryStore).
-- Dibuat otomatis oleh connect-pg-simple (createTableIfMissing), definisi ini
-- sebagai rujukan/migrasi manual.
-- =============================================
CREATE TABLE IF NOT EXISTS admin_sessions (
  sid VARCHAR NOT NULL COLLATE "default" PRIMARY KEY,
  sess JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expire ON admin_sessions(expire);
