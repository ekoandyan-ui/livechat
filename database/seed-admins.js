// =============================================
// SEEDER: Akun admin awal (super_admin + admin rumah sakit).
//
// Dipakai saat DEPLOY ke server baru: setelah `schema.sql` dijalankan, tabel
// `admins` masih kosong (schema sengaja tidak berisi seed). Skrip ini mengisi
// akun awal secara IDEMPOTENT (aman dijalankan berulang, tidak menimpa data).
//
// Cara pakai:
//   node database/seed-admins.js
//   node database/seed-admins.js --file database/admins.seed.json
//   node database/seed-admins.js --send          (kirim email aktivasi bila SMTP aktif)
//   node database/seed-admins.js --dry-run       (lihat rencana tanpa menulis)
//   node database/seed-admins.js --password <pw> (langsung aktif dgn password ini,
//                                                 hash disimpan; tanpa ini akun PENDING)
//
// Sumber daftar (prioritas):
//   1) --file <path>
//   2) env ADMIN_SEED_FILE
//   3) database/admins.seed.json
//   4) database/admin-emails.json   (format lama: [{rumah_sakit, email}])
//   5) env ADMIN_SEED_JSON          (string JSON)
//
// Format tiap entri:
//   { "username": "...", "email": "...", "rumah_sakit": "...", "role": "hospital_admin",
//     "patient_data_read": false }
// role: "hospital_admin" (wajib punya rumah_sakit) atau "super_admin" (rumah_sakit null).
//
// Keamanan: TIDAK ada password default. Secara default akun dibuat PENDING +
// tautan aktivasi (30 menit, sekali pakai), sama seperti provision-admin.js.
// =============================================
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const mailer = require("../mailer");

function poolConfig() {
  const url = process.env.DATABASE_URL || "";
  const isLocal = /localhost|127\.0\.0\.1|sslmode=disable/i.test(url);
  return { connectionString: url, ssl: isLocal ? false : { rejectUnauthorized: false } };
}

function parseArgs(argv) {
  const out = { send: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--send") out.send = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--file") out.file = argv[++i];
    else if (a === "--password") out.password = argv[++i];
  }
  return out;
}

function normEmail(v) {
  return String(v || "").trim().toLowerCase();
}
function isValidEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}
function slugify(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}
function hashToken(raw) {
  return crypto.createHash("sha256").update(String(raw)).digest("hex");
}

// Cari & muat daftar admin dari berbagai sumber.
function loadRoster(args) {
  const candidates = [];
  if (args.file) candidates.push({ src: "argumen --file", path: args.file, required: true });
  if (process.env.ADMIN_SEED_FILE) candidates.push({ src: "env ADMIN_SEED_FILE", path: process.env.ADMIN_SEED_FILE, required: true });
  candidates.push({ src: "database/admins.seed.json", path: path.join(__dirname, "admins.seed.json") });
  candidates.push({ src: "database/admin-emails.json", path: path.join(__dirname, "admin-emails.json") });

  for (const c of candidates) {
    if (fs.existsSync(c.path)) {
      let data;
      try {
        data = JSON.parse(fs.readFileSync(c.path, "utf8"));
      } catch (e) {
        throw new Error(`Gagal membaca ${c.src}: ${e.message}`);
      }
      if (!Array.isArray(data)) throw new Error(`${c.src} harus berupa array JSON.`);
      return { source: c.src, entries: data };
    }
    if (c.required) throw new Error(`Sumber wajib tidak ditemukan: ${c.path}`);
  }

  if (process.env.ADMIN_SEED_JSON) {
    let data;
    try {
      data = JSON.parse(process.env.ADMIN_SEED_JSON);
    } catch (e) {
      throw new Error(`env ADMIN_SEED_JSON bukan JSON valid: ${e.message}`);
    }
    if (!Array.isArray(data)) throw new Error("env ADMIN_SEED_JSON harus berupa array JSON.");
    return { source: "env ADMIN_SEED_JSON", entries: data };
  }

  throw new Error(
    "Tidak ada sumber daftar admin. Buat database/admins.seed.json, set ADMIN_SEED_FILE/ADMIN_SEED_JSON, atau pakai --file <path>.",
  );
}

// Normalisasi + validasi entri dari format apa pun.
function normalize(entries) {
  const out = [];
  const problems = [];
  entries.forEach((raw, i) => {
    const role = String(raw.role || "hospital_admin").trim();
    const rumahSakit = String(raw.rumah_sakit || "").trim();
    const email = normEmail(raw.email);
    let username = String(raw.username || "").trim();

    if (!username) username = slugify(rumahSakit || email.split("@")[0]);

    if (!["hospital_admin", "super_admin"].includes(role)) {
      problems.push(`#${i + 1}: role tidak valid (${role}).`);
      return;
    }
    if (!isValidEmail(email)) {
      problems.push(`#${i + 1}: email tidak valid (${raw.email || "-"}).`);
      return;
    }
    if (!username) {
      problems.push(`#${i + 1}: username kosong.`);
      return;
    }
    if (role === "hospital_admin" && !rumahSakit) {
      problems.push(`#${i + 1}: hospital_admin wajib punya rumah_sakit (${email}).`);
      return;
    }
    out.push({
      username,
      email,
      role,
      rumah_sakit: role === "super_admin" ? null : rumahSakit,
      patient_data_read: role === "super_admin" ? !!raw.patient_data_read : false,
    });
  });
  return { out, problems };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL belum diset.");
    process.exit(1);
  }
  if (args.password && String(args.password).length < 8) {
    console.error("--password minimal 8 karakter.");
    process.exit(1);
  }

  const { source, entries } = loadRoster(args);
  const { out: roster, problems } = normalize(entries);
  problems.forEach((p) => console.error("VALIDASI:", p));
  if (problems.length) {
    console.error(`Ada ${problems.length} entri tidak valid. Perbaiki dulu (tidak ada yang ditulis).`);
    process.exit(1);
  }
  if (!roster.length) {
    console.error("Daftar admin kosong.");
    process.exit(1);
  }
  if (!roster.some((a) => a.role === "super_admin")) {
    console.warn("PERINGATAN: tidak ada super_admin di daftar. Pastikan minimal ada satu.");
  }

  console.log(`Sumber daftar: ${source} (${roster.length} entri).`);
  console.log(args.password ? "Mode: AKTIF (pakai --password, wajib diganti setelah login)." : "Mode: PENDING + tautan aktivasi.");
  if (args.dryRun) console.log("MODE DRY-RUN: tidak ada perubahan ditulis.");

  const pool = new Pool(poolConfig());
  const created = [];
  try {
    for (const a of roster) {
      const dup = await pool.query(
        "SELECT id, username, email, role, rumah_sakit FROM admins WHERE LOWER(email) = $1 OR username = $2",
        [a.email, a.username],
      );
      if (dup.rows.length) {
        const ex = dup.rows[0];
        const same = ex.username === a.username && normEmail(ex.email) === a.email && ex.role === a.role;
        console.log(`SKIP (sudah ada #${ex.id} ${ex.username}): ${a.email}${same ? "" : "  <-- beda username/role, TIDAK ditimpa"}`);
        continue;
      }

      if (args.dryRun) {
        console.log(`AKAN BUAT: ${a.role} ${a.username} / ${a.email} / ${a.rumah_sakit || "(global)"}`);
        continue;
      }

      let insert;
      if (args.password) {
        const bcrypt = require("bcryptjs");
        const hash = bcrypt.hashSync(String(args.password), 12);
        insert = await pool.query(
          `INSERT INTO admins (username, email, rumah_sakit, role, patient_data_read, password, is_active, session_version)
           VALUES ($1,$2,$3,$4,$5,$6,TRUE,1) RETURNING id`,
          [a.username, a.email, a.rumah_sakit, a.role, a.patient_data_read, hash],
        );
      } else {
        insert = await pool.query(
          `INSERT INTO admins (username, email, rumah_sakit, role, patient_data_read, password, is_active, session_version)
           VALUES ($1,$2,$3,$4,$5,NULL,FALSE,0) RETURNING id`,
          [a.username, a.email, a.rumah_sakit, a.role, a.patient_data_read],
        );
      }
      const adminId = insert.rows[0].id;

      let raw = null;
      let link = null;
      if (!args.password) {
        raw = crypto.randomBytes(32).toString("hex");
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
        await pool.query(
          "INSERT INTO admin_tokens (admin_id, purpose, token_hash, expires_at) VALUES ($1,$2,$3,$4)",
          [adminId, "activation", hashToken(raw), expiresAt],
        );
        link = `${mailer.getBaseUrl()}/admin/activate?token=${encodeURIComponent(raw)}`;
      }

      try {
        await pool.query(
          `INSERT INTO admin_audit_events
             (actor_username, actor_role, action, target_type, target_admin_id, target_username, result, reason, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            "cli:seed-admins",
            "system",
            "admin_provision",
            "admin",
            adminId,
            a.username,
            "success",
            `role=${a.role}`,
            JSON.stringify({ email: a.email, role: a.role, rumah_sakit: a.rumah_sakit }),
          ],
        );
      } catch (e) {
        console.warn("Peringatan: gagal menulis audit:", e.message);
      }

      created.push({ ...a, id: adminId, link });
      const scope = a.rumah_sakit ? `RS "${a.rumah_sakit}"` : "SUPER ADMIN (global)";
      console.log(`BUAT: ${a.role} #${adminId} ${a.username} / ${a.email} / ${scope}`);
      if (link) console.log(`  Aktivasi (30 menit): ${link}`);

      if (args.send && raw) {
        const res = await mailer.sendActivationEmail(a.email, raw, { rumahSakit: a.rumah_sakit });
        if (res.error) console.error("  Gagal kirim email:", res.error);
        else if (res.skipped) console.warn("  SMTP belum dikonfigurasi -> email TIDAK terkirim (pakai tautan di atas).");
        else console.log(`  Email aktivasi dikirim ke ${a.email}.`);
      }
    }

    console.log(`\nSelesai. dibuat=${created.length}, total_daftar=${roster.length}.`);
    if (created.some((c) => !args.password)) {
      console.log("Akun PENDING: bagikan tautan aktivasi di atas (atau jalankan ulang dengan --send).");
    }
    if (args.password) {
      console.log("Akun dibuat AKTIF dengan --password. WAJIB ganti password setelah login pertama.");
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Gagal seeding admin:", err.message);
  process.exit(1);
});
