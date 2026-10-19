// =============================================
// MIGRASI: MFA (TOTP) + permission patient_data_read (Tahap 3).
//
// Jalankan manual:
//   node database/migrate-admin-mfa.js
//
// Membuat:
//   - kolom admins.mfa_secret (terenkripsi di aplikasi), mfa_enabled,
//     mfa_enrolled_at, mfa_last_step (anti-replay), patient_data_read.
//   - tabel admin_mfa_recovery_codes (hanya HASH kode yang disimpan).
//   - tabel admin_access_sessions (sesi izin baca data pasien: alasan + masa berlaku).
//   - constraint: patient_data_read hanya boleh untuk role super_admin.
//
// Catatan: JANGAN menyimpan secret/kode pemulihan dalam bentuk plaintext.
// =============================================
const path = require("path");
require(path.join(__dirname, "..", "node_modules", "dotenv")).config({
  path: path.join(__dirname, "..", ".env"),
});
const { Pool } = require(path.join(__dirname, "..", "node_modules", "pg"));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL belum diset.");
    process.exit(1);
  }

  // Kolom pada admins.
  await pool.query("ALTER TABLE admins ADD COLUMN IF NOT EXISTS mfa_secret TEXT");
  await pool.query(
    "ALTER TABLE admins ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE",
  );
  await pool.query("ALTER TABLE admins ADD COLUMN IF NOT EXISTS mfa_enrolled_at TIMESTAMPTZ");
  await pool.query("ALTER TABLE admins ADD COLUMN IF NOT EXISTS mfa_last_step BIGINT");
  await pool.query(
    "ALTER TABLE admins ADD COLUMN IF NOT EXISTS patient_data_read BOOLEAN NOT NULL DEFAULT FALSE",
  );
  console.log("Kolom MFA pada admins siap.");

  // patient_data_read hanya untuk super_admin.
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admins_patient_read_scope_chk') THEN
        ALTER TABLE admins ADD CONSTRAINT admins_patient_read_scope_chk
          CHECK (patient_data_read = FALSE OR role = 'super_admin');
      END IF;
    END $$;`);
  console.log("Constraint admins_patient_read_scope_chk siap.");

  // Kode pemulihan MFA (hanya hash).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_mfa_recovery_codes (
      id SERIAL PRIMARY KEY,
      admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_mfa_recovery_admin ON admin_mfa_recovery_codes(admin_id)",
  );
  console.log("Tabel admin_mfa_recovery_codes siap.");

  // Sesi izin baca data pasien (read-only, beralasan, berjangka waktu).
  await pool.query(`
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
    )`);
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_access_sessions_admin ON admin_access_sessions(admin_id, permission, expires_at DESC)",
  );
  console.log("Tabel admin_access_sessions siap.");

  // Verifikasi.
  const cols = await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='admins' AND column_name LIKE 'mfa%' OR (table_name='admins' AND column_name='patient_data_read') ORDER BY column_name",
  );
  console.log("Kolom MFA admins:", cols.rows.map((r) => r.column_name).join(", "));

  console.log("Migrasi MFA selesai.");
}

main()
  .catch((err) => {
    console.error("Gagal migrasi MFA:", err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
