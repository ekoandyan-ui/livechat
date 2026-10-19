// =============================================
// MIGRASI: Audit administratif (append-only) + login tracking.
//
// Jalankan manual:
//   node database/migrate-admin-audit.js
//
// Membuat:
//   - tabel admin_audit_events (append-only, immutable)
//   - tabel admin_login_events (riwayat percobaan login)
//   - kolom admins.last_login_at
//   - trigger pencegah UPDATE/DELETE (escape hatch: SET lc.allow_audit_purge='on')
//
// Catatan:
//   - Kolom actor/target disimpan sebagai INTEGER TANPA foreign key agar
//     riwayat audit tetap utuh walau akun dihapus (dan tidak ada UPDATE
//     kaskade yang menabrak sifat append-only).
//   - JANGAN menyimpan password/token/secret/isi chat di tabel ini.
//
// Idempotent: aman dijalankan berulang.
// =============================================
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL belum diset.");
    process.exit(1);
  }

  // Kolom waktu login terakhir pada admins.
  await pool.query("ALTER TABLE admins ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ");
  console.log("Kolom admins.last_login_at dipastikan ada.");

  // Tabel audit administratif.
  await pool.query(`
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
      result TEXT NOT NULL DEFAULT 'success',
      reason TEXT,
      metadata JSONB,
      ip_hash TEXT
    )`);
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_admin_audit_actor ON admin_audit_events(actor_admin_id, created_at DESC)",
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_admin_audit_target ON admin_audit_events(target_admin_id, created_at DESC)",
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_admin_audit_action ON admin_audit_events(action, created_at DESC)",
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_admin_audit_time ON admin_audit_events(created_at DESC)",
  );
  console.log("Tabel admin_audit_events siap.");

  // Tabel riwayat login.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_login_events (
      id SERIAL PRIMARY KEY,
      admin_id INTEGER,
      email_attempted TEXT,
      success BOOLEAN NOT NULL,
      reason TEXT,
      ip_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_admin_login_admin ON admin_login_events(admin_id, created_at DESC)",
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_admin_login_time ON admin_login_events(created_at DESC)",
  );
  console.log("Tabel admin_login_events siap.");

  // Fungsi & trigger immutable (append-only).
  await pool.query(`
    CREATE OR REPLACE FUNCTION admin_audit_immutable() RETURNS trigger AS $$
    BEGIN
      IF current_setting('lc.allow_audit_purge', true) = 'on' THEN
        RETURN COALESCE(NEW, OLD);
      END IF;
      RAISE EXCEPTION 'Tabel audit bersifat append-only (UPDATE/DELETE ditolak).';
    END;
    $$ LANGUAGE plpgsql`);

  for (const t of ["admin_audit_events", "admin_login_events"]) {
    await pool.query(`DROP TRIGGER IF EXISTS trg_${t}_immutable ON ${t}`);
    await pool.query(
      `CREATE TRIGGER trg_${t}_immutable
         BEFORE UPDATE OR DELETE ON ${t}
         FOR EACH ROW EXECUTE FUNCTION admin_audit_immutable()`,
    );
  }
  console.log("Trigger immutable terpasang pada kedua tabel audit.");

  // Verifikasi.
  const cols = await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='admin_audit_events' ORDER BY ordinal_position",
  );
  console.log("Kolom admin_audit_events:", cols.rows.map((r) => r.column_name).join(", "));
  const trg = await pool.query(
    `SELECT tgname FROM pg_trigger WHERE tgname LIKE 'trg_admin_%_immutable' ORDER BY tgname`,
  );
  console.log("Trigger:", trg.rows.map((r) => r.tgname).join(", "));

  console.log("Migrasi audit selesai.");
}

main()
  .catch((err) => {
    console.error("Gagal migrasi audit:", err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
