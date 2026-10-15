// =============================================
// PROVISION ADMIN (Fase 3)
//
// Membuat akun admin baru dalam keadaan PENDING (is_active = FALSE,
// password NULL) dan menerbitkan token aktivasi sekali pakai (30 menit).
//
// Pemakaian:
//   node database/provision-admin.js --email <email> --username <username> --rs "<Rumah Sakit>"
//
// Opsi:
//   --send   kirim email aktivasi (bila SMTP dikonfigurasi). Bila tidak,
//            tautan aktivasi dicetak ke console.
//
// Membutuhkan env DATABASE_URL (lihat .env.example).
// =============================================
require("dotenv").config();
const crypto = require("crypto");
const { Pool } = require("pg");
const mailer = require("../mailer");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--send") out.send = true;
    else if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
  }
  return out;
}

function hashToken(raw) {
  return crypto.createHash("sha256").update(String(raw)).digest("hex");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const email = String(args.email || "").trim().toLowerCase();
  const username = String(args.username || "").trim();
  const rumahSakit = String(args.rs || "").trim();

  if (!email || !username || !rumahSakit) {
    console.error(
      'Penggunaan: node database/provision-admin.js --email <email> --username <username> --rs "<Rumah Sakit>" [--send]',
    );
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL belum diset.");
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const dup = await pool.query(
      "SELECT id, username, email FROM admins WHERE LOWER(email) = $1 OR username = $2",
      [email, username],
    );
    if (dup.rows.length) {
      console.error("Akun dengan email/username tersebut sudah ada:", dup.rows[0]);
      process.exit(1);
    }

    const ins = await pool.query(
      `INSERT INTO admins (username, password, email, rumah_sakit, is_active, session_version)
       VALUES ($1, NULL, $2, $3, FALSE, 0)
       RETURNING id`,
      [username, email, rumahSakit],
    );
    const adminId = ins.rows[0].id;

    const raw = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    await pool.query(
      "INSERT INTO admin_tokens (admin_id, purpose, token_hash, expires_at) VALUES ($1,$2,$3,$4)",
      [adminId, "activation", hashToken(raw), expiresAt],
    );

    const link = `${mailer.getBaseUrl()}/admin/activate?token=${encodeURIComponent(raw)}`;
    console.log(`Akun admin #${adminId} (${username} / ${email} / ${rumahSakit}) dibuat PENDING.`);
    console.log(`Tautan aktivasi (berlaku 30 menit, sekali pakai):\n${link}`);

    if (args.send) {
      const out = await mailer.sendActivationEmail(email, raw, { rumahSakit });
      if (out.error) console.error("Gagal kirim email aktivasi:", out.error);
      else if (out.skipped) console.log("SMTP belum dikonfigurasi -> email tidak terkirim (pakai tautan di atas).");
      else console.log("Email aktivasi terkirim.");
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Gagal provisioning admin:", err.message);
  process.exit(1);
});
