// =============================================
// MIGRASI: Web Push subscriptions (notifikasi pesan baru).
//
// Jalankan manual:
//   node database/migrate-push-subscriptions.js
//
// Idempotent. Membuat tabel push_subscriptions:
//   - endpoint unik per subscription, kunci p256dh/auth
//   - pemilik: owner_type ('patient'|'admin') + owner_id
//   - konteks otorisasi: rumah_sakit (admin & pasien) dan room_id (pasien)
//   - revoked_at untuk pencabutan (unsubscribe)
// =============================================
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
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
   )`,
  "CREATE INDEX IF NOT EXISTS idx_push_owner ON push_subscriptions(owner_type, owner_id)",
  "CREATE INDEX IF NOT EXISTS idx_push_admin_rs ON push_subscriptions(owner_type, rumah_sakit) WHERE revoked_at IS NULL",
];

(async () => {
  for (const sql of STATEMENTS) {
    await pool.query(sql);
  }
  console.log("Migrasi push_subscriptions selesai: tabel siap.");

  const cols = await pool.query(
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_name = 'push_subscriptions'
      ORDER BY ordinal_position`,
  );
  cols.rows.forEach((c) =>
    console.log(`  push_subscriptions.${c.column_name}: ${c.data_type} nullable=${c.is_nullable}`),
  );

  await pool.end();
})().catch(async (err) => {
  console.error("Gagal migrasi:", err.message);
  try { await pool.end(); } catch (e) {}
  process.exit(1);
});
