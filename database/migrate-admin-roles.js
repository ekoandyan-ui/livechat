// =============================================
// MIGRASI: Peran admin (role) + cakupan Super Admin.
//
// Jalankan manual (JANGAN otomatis saat server start):
//   node database/migrate-admin-roles.js
//
// Perubahan:
//   1) Tambah kolom `role` (nullable) lalu isi 'hospital_admin' untuk akun lama.
//   2) Jadikan NOT NULL + DEFAULT 'hospital_admin'.
//   3) rumah_sakit menjadi NULLABLE (Super Admin tidak terikat satu rumah sakit).
//   4) Constraint: role hanya 'hospital_admin' | 'super_admin'.
//   5) Constraint cakupan: hospital_admin WAJIB punya rumah_sakit;
//      super_admin rumah_sakit HARUS NULL.
//   6) Index idx_admins_role.
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

  // 1) Kolom role.
  await pool.query("ALTER TABLE admins ADD COLUMN IF NOT EXISTS role TEXT");
  console.log("Kolom role dipastikan ada.");

  // 2) Backfill akun lama sebagai admin rumah sakit.
  const back = await pool.query(
    "UPDATE admins SET role = 'hospital_admin' WHERE role IS NULL OR btrim(role) = ''",
  );
  console.log(`Backfill role hospital_admin: ${back.rowCount} baris.`);

  // 3) NOT NULL + DEFAULT.
  await pool.query("ALTER TABLE admins ALTER COLUMN role SET DEFAULT 'hospital_admin'");
  await pool.query("ALTER TABLE admins ALTER COLUMN role SET NOT NULL");
  console.log("role diset NOT NULL DEFAULT 'hospital_admin'.");

  // 4) rumah_sakit nullable (super_admin tanpa rumah sakit).
  await pool.query("ALTER TABLE admins ALTER COLUMN rumah_sakit DROP NOT NULL");
  console.log("rumah_sakit kini NULLABLE.");

  // 5) Constraint nilai role.
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admins_role_chk') THEN
        ALTER TABLE admins ADD CONSTRAINT admins_role_chk
          CHECK (role IN ('hospital_admin', 'super_admin'));
      END IF;
    END $$;
  `);

  // 6) Constraint cakupan role <-> rumah_sakit.
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admins_role_scope_chk') THEN
        ALTER TABLE admins ADD CONSTRAINT admins_role_scope_chk CHECK (
          (role = 'hospital_admin' AND rumah_sakit IS NOT NULL AND btrim(rumah_sakit) <> '')
          OR (role = 'super_admin' AND rumah_sakit IS NULL)
        );
      END IF;
    END $$;
  `);

  // 7) Index role.
  await pool.query("CREATE INDEX IF NOT EXISTS idx_admins_role ON admins(role)");
  console.log("Constraint admins_role_chk, admins_role_scope_chk & index idx_admins_role siap.");

  // Verifikasi.
  const cols = await pool.query(
    "SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_name='admins' AND column_name IN ('role','rumah_sakit') ORDER BY column_name",
  );
  console.table(cols.rows);
  const byRole = await pool.query("SELECT role, COUNT(*) AS n FROM admins GROUP BY role ORDER BY role");
  console.table(byRole.rows);
  const cons = await pool.query(
    "SELECT conname FROM pg_constraint WHERE conrelid = 'admins'::regclass AND contype = 'c' ORDER BY conname",
  );
  console.log("CHECK constraints admins:", cons.rows.map((r) => r.conname).join(", "));

  console.log("Migrasi role selesai.");
}

main()
  .catch((err) => {
    console.error("Gagal migrasi role:", err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
