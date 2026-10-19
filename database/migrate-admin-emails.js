// =============================================
// MIGRASI: Tetapkan email admin berdasarkan rumah_sakit.
//
// Jalankan manual (JANGAN otomatis saat server start):
//   node database/migrate-admin-emails.js [path-ke-mapping.json]
//
// Default mapping: database/admin-emails.json (berisi PII -> di-gitignore).
// Alur bertahap:
//   1) tambah kolom email (nullable)
//   2) isi email per rumah_sakit (idempotent)
//   3) validasi keunikan (case-insensitive)
//   4) buat unique index LOWER(email)
// =============================================
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const mappingPath = process.argv[2] || path.join(__dirname, "admin-emails.json");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function normEmail(v) {
  return String(v || "").trim().toLowerCase();
}
function isValidEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

(async () => {
  if (!fs.existsSync(mappingPath)) {
    console.error("Mapping tidak ditemukan:", mappingPath);
    process.exit(1);
  }
  const mapping = JSON.parse(fs.readFileSync(mappingPath, "utf8"));
  if (!Array.isArray(mapping) || mapping.length === 0) {
    console.error("Mapping kosong/tidak valid.");
    process.exit(1);
  }

  // 1) Pastikan kolom email ada (nullable dulu).
  await pool.query("ALTER TABLE admins ADD COLUMN IF NOT EXISTS email TEXT");
  console.log("Kolom email dipastikan ada.");

  let updated = 0;
  let problems = 0;

  // 2) Isi email per rumah_sakit (idempotent).
  for (const item of mapping) {
    const rs = String(item.rumah_sakit || "").trim();
    const email = normEmail(item.email);
    if (!rs || !isValidEmail(email)) {
      console.error(`SKIP (data tidak valid): rumah_sakit="${rs}" email="${email}"`);
      problems++;
      continue;
    }
    const found = await pool.query(
      "SELECT id, username, email FROM admins WHERE rumah_sakit = $1",
      [rs],
    );
    if (found.rows.length === 0) {
      console.error(`SKIP: tidak ada admin untuk rumah_sakit "${rs}"`);
      problems++;
      continue;
    }
    if (found.rows.length > 1) {
      console.error(
        `SKIP: ada ${found.rows.length} admin untuk rumah_sakit "${rs}" (ambigu): ` +
          found.rows.map((r) => r.username).join(", "),
      );
      problems++;
      continue;
    }
    const admin = found.rows[0];
    const current = normEmail(admin.email);
    if (current === email) {
      console.log(`OK (sudah sesuai): ${rs} -> ${email}`);
      continue;
    }
    if (current && current !== email) {
      console.error(
        `SKIP: ${rs} sudah punya email berbeda (${admin.email}); tidak ditimpa.`,
      );
      problems++;
      continue;
    }
    await pool.query("UPDATE admins SET email = $1 WHERE id = $2", [
      email,
      admin.id,
    ]);
    console.log(`UPDATE: ${rs} (${admin.username}) -> ${email}`);
    updated++;
  }

  // 3) Validasi keunikan case-insensitive.
  const dup = await pool.query(
    `SELECT LOWER(email) AS email, COUNT(*) AS n
       FROM admins
      WHERE email IS NOT NULL AND email <> ''
      GROUP BY LOWER(email) HAVING COUNT(*) > 1`,
  );
  if (dup.rows.length > 0) {
    console.error("DUPLIKAT email terdeteksi:");
    dup.rows.forEach((r) => console.error(`  ${r.email} (${r.n}x)`));
    problems += dup.rows.length;
  } else {
    console.log("Validasi keunikan: tidak ada duplikat.");
  }

  // 4) Buat unique index LOWER(email).
  if (problems === 0) {
    await pool.query(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_admins_email_lower ON admins (LOWER(email)) WHERE email IS NOT NULL",
    );
    console.log("Unique index LOWER(email) siap.");
  } else {
    console.error("Ada masalah -> index TIDAK dibuat. Perbaiki dulu lalu ulangi.");
  }

  const total = await pool.query(
    "SELECT COUNT(*) AS total, COUNT(email) AS beremail FROM admins",
  );
  console.log(
    `Selesai. diupdate=${updated}, masalah=${problems}, ` +
      `admins=${total.rows[0].total}, punya_email=${total.rows[0].beremail}`,
  );
  await pool.end();
  process.exit(problems === 0 ? 0 : 2);
})().catch(async (err) => {
  console.error("Gagal migrasi:", err.message);
  try {
    await pool.end();
  } catch (e) {}
  process.exit(1);
});
