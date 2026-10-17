// =============================================
// PROVISION ADMIN (Fase 3)
//
// Membuat akun admin baru dalam keadaan PENDING (is_active = FALSE,
// password NULL) dan menerbitkan token aktivasi sekali pakai (30 menit).
//
// Pemakaian:
//   Admin rumah sakit:
//     node database/provision-admin.js --email <email> --username <username> --rs "<Rumah Sakit>"
//
//   Super Admin (administratif global, tanpa rumah sakit):
//     node database/provision-admin.js --email <email> --username <username> --role super_admin
//
// Opsi:
//   --role <hospital_admin|super_admin>  default: hospital_admin
//   --super                              alias singkat untuk --role super_admin
//   --patient-read                       (khusus super_admin) beri permission
//                                        patient_data_read (baca-saja, beralasan, diaudit)
//   --send   kirim email aktivasi (bila SMTP dikonfigurasi). Bila tidak,
//            tautan aktivasi dicetak ke console.
//
// Membutuhkan env DATABASE_URL (lihat .env.example).
// =============================================
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const crypto = require("crypto");
const { Pool } = require("pg");
const mailer = require("../mailer");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--send") out.send = true;
    else if (a === "--super") out.super = true;
    else if (a === "--patient-read") out.patientRead = true;
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
  const role = args.super ? "super_admin" : String(args.role || "hospital_admin").trim();
  const needsRs = role === "hospital_admin";
  const rumahSakit = String(args.rs || "").trim();

  if (!["hospital_admin", "super_admin"].includes(role)) {
    console.error('Nilai --role tidak valid. Gunakan "hospital_admin" atau "super_admin".');
    process.exit(1);
  }
  if (!email || !username || (needsRs && !rumahSakit)) {
    console.error(
      'Penggunaan: node database/provision-admin.js --email <email> --username <username> --rs "<Rumah Sakit>" [--role hospital_admin|super_admin] [--send]',
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
      `INSERT INTO admins (username, password, email, rumah_sakit, role, patient_data_read, is_active, session_version)
       VALUES ($1, NULL, $2, $3, $4, $5, FALSE, 0)
       RETURNING id`,
      [
        username,
        email,
        needsRs ? rumahSakit : null,
        role,
        role === "super_admin" ? !!args.patientRead : false,
      ],
    );
    const adminId = ins.rows[0].id;

    const raw = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    await pool.query(
      "INSERT INTO admin_tokens (admin_id, purpose, token_hash, expires_at) VALUES ($1,$2,$3,$4)",
      [adminId, "activation", hashToken(raw), expiresAt],
    );

    // Catat audit provisioning (aktor: CLI operator).
    try {
      await pool.query(
        `INSERT INTO admin_audit_events
           (actor_username, actor_role, action, target_type, target_admin_id,
            target_username, result, reason, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          "cli:provision-admin",
          "system",
          "admin_provision",
          "admin",
          adminId,
          username,
          "success",
          `role=${role}`,
          JSON.stringify({ email, role, rumah_sakit: needsRs ? rumahSakit : null }),
        ],
      );
    } catch (e) {
      console.warn("Peringatan: gagal menulis audit provisioning:", e.message);
    }

    const scope = needsRs ? `rumah sakit "${rumahSakit}"` : "SUPER ADMIN (global)";
    const link = `${mailer.getBaseUrl()}/admin/activate?token=${encodeURIComponent(raw)}`;
    console.log(`Akun ${role} #${adminId} (${username} / ${email} / ${scope}) dibuat PENDING.`);
    console.log(`Tautan aktivasi (berlaku 30 menit, sekali pakai):\n${link}`);

    if (args.send) {
      const out = await mailer.sendActivationEmail(email, raw, {
        rumahSakit: needsRs ? rumahSakit : undefined,
      });
      if (out.error) console.error("Gagal kirim email aktivasi:", out.error);
      else console.log(`Email aktivasi dikirim ke ${email}.`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Gagal provisioning admin:", err.message);
  process.exit(1);
});
