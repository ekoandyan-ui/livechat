// =============================================
// MIGRASI: Aktivasi & manajemen password admin (Fase 3-4).
//
// Jalankan manual:
//   node database/migrate-admin-auth.js
//
// Idempotent. Menambahkan:
//   - admins.is_active, session_version, password_changed_at
//   - password menjadi NULLABLE (agar akun "pending" belum punya password)
//   - tabel admin_tokens (token aktivasi/reset, disimpan sebagai hash)
// =============================================
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const STATEMENTS = [
  "ALTER TABLE admins ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE",
  "ALTER TABLE admins ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE admins ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ",
  "ALTER TABLE admins ALTER COLUMN password DROP NOT NULL",
  `CREATE TABLE IF NOT EXISTS admin_tokens (
     id SERIAL PRIMARY KEY,
     admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
     purpose TEXT NOT NULL,
     token_hash TEXT NOT NULL UNIQUE,
     expires_at TIMESTAMPTZ NOT NULL,
     used_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ DEFAULT NOW()
   )`,
  "CREATE INDEX IF NOT EXISTS idx_admin_tokens_admin ON admin_tokens(admin_id, purpose)",
  "CREATE INDEX IF NOT EXISTS idx_admin_tokens_hash ON admin_tokens(token_hash)",
];

(async () => {
  for (const sql of STATEMENTS) {
    await pool.query(sql);
  }
  console.log("Migrasi admin auth selesai: kolom & tabel siap.");

  const cols = await pool.query(
    `SELECT column_name, is_nullable, data_type
       FROM information_schema.columns
      WHERE table_name = 'admins' AND column_name IN ('is_active','session_version','password_changed_at','password','email')
      ORDER BY column_name`,
  );
  cols.rows.forEach((c) =>
    console.log(`  admins.${c.column_name}: ${c.data_type}, nullable=${c.is_nullable}`),
  );

  const tbl = await pool.query(
    "SELECT to_regclass('public.admin_tokens') AS t",
  );
  console.log("  admin_tokens:", tbl.rows[0].t || "(tidak ada)");

  await pool.end();
})().catch(async (err) => {
  console.error("Gagal migrasi:", err.message);
  try { await pool.end(); } catch (e) {}
  process.exit(1);
});
