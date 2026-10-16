// =============================================
// MAILER: pengiriman email transaksional (Fase 5)
//
// - Konfigurasi SMTP via env (secret manager), bukan di kode.
// - Bila SMTP belum dikonfigurasi, email TIDAK dikirim; pemanggil boleh
//   mencetak tautan ke console HANYA pada mode non-production (dev).
// - Tautan memakai APP_BASE_URL (origin HTTPS tetap), bukan host dari request.
// - Konten email tidak pernah memuat password/token lama yang masih berlaku.
// =============================================
const nodemailer = require("nodemailer");

const IS_PRODUCTION = process.env.NODE_ENV === "production";

function getBaseUrl() {
  const configured = (process.env.APP_BASE_URL || "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  const port = process.env.PORT || 8000;
  return `http://localhost:${port}`;
}

function getFromAddress() {
  return process.env.MAIL_FROM || process.env.SMTP_USER || "no-reply@localhost";
}

let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  const port = Number(process.env.SMTP_PORT || 587);
  // Gmail App Password sering ditempel dengan spasi; buang spasi agar valid.
  const pass = String(process.env.SMTP_PASS).replace(/\s+/g, "");
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === "true" || port === 465,
    auth: { user: process.env.SMTP_USER, pass },
  });
}

function mailerConfigured() {
  return !!transporter;
}

async function sendMail({ to, subject, text, html }) {
  if (!transporter) {
    console.warn(
      `[MAILER] SMTP belum dikonfigurasi -> email ke ${to} TIDAK terkirim (subject: "${subject}").`,
    );
    return { skipped: true };
  }
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await transporter.sendMail({
        from: getFromAddress(),
        to,
        subject,
        text,
        html,
      });
      return { skipped: false };
    } catch (err) {
      lastErr = err;
      console.error(`[MAILER] gagal kirim (percobaan ${attempt}/3):`, err.message);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  return { skipped: false, error: lastErr ? lastErr.message : "unknown" };
}

function wrap(title, bodyHtml) {
  return `<!DOCTYPE html><html lang="id"><body style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;line-height:1.55">
  <h2 style="color:#0ea5e9">${title}</h2>
  ${bodyHtml}
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0" />
  <p style="font-size:12px;color:#64748b">Email otomatis. Jangan balas pesan ini.</p>
  </body></html>`;
}

// ---------- Template ----------

async function sendActivationEmail(to, token, { rumahSakit } = {}) {
  const link = `${getBaseUrl()}/admin/activate?token=${encodeURIComponent(token)}`;
  const subject = "Aktivasi Akun Admin Live Chat";
  const text =
    `Akun admin${rumahSakit ? ` (${rumahSakit})` : ""} telah dibuat.\n\n` +
    `Tetapkan password Anda melalui tautan berikut (berlaku 30 menit, sekali pakai):\n${link}\n\n` +
    `Jika Anda tidak merasa meminta ini, abaikan email ini.`;
  const html = wrap(
    "Aktivasi Akun Admin",
    `<p>Akun admin${rumahSakit ? ` untuk <b>${rumahSakit}</b>` : ""} telah dibuat.</p>
     <p>Tetapkan password Anda melalui tautan berikut. Tautan berlaku <b>30 menit</b> dan <b>hanya dapat dipakai sekali</b>:</p>
     <p><a href="${link}" style="background:#0ea5e9;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Aktivasi &amp; Set Password</a></p>
     <p style="font-size:13px;color:#64748b">Atau salin: ${link}</p>
     <p>Jika Anda tidak merasa meminta ini, abaikan email ini.</p>`,
  );
  return { ...(await sendMail({ to, subject, text, html })), link };
}

async function sendResetEmail(to, token) {
  const link = `${getBaseUrl()}/admin/reset-password?token=${encodeURIComponent(token)}`;
  const subject = "Reset Password Admin Live Chat";
  const text =
    `Permintaan reset password diterima untuk akun ini.\n\n` +
    `Ganti password melalui tautan berikut (berlaku 30 menit, sekali pakai):\n${link}\n\n` +
    `Jika Anda tidak meminta reset, abaikan email ini dan password tetap tidak berubah.`;
  const html = wrap(
    "Reset Password Admin",
    `<p>Permintaan <b>reset password</b> diterima untuk akun ini.</p>
     <p>Ganti password melalui tautan berikut. Tautan berlaku <b>30 menit</b> dan <b>hanya dapat dipakai sekali</b>:</p>
     <p><a href="${link}" style="background:#0ea5e9;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Reset Password</a></p>
     <p style="font-size:13px;color:#64748b">Atau salin: ${link}</p>
     <p>Jika Anda tidak meminta reset, abaikan email ini dan password tetap tidak berubah.</p>`,
  );
  return { ...(await sendMail({ to, subject, text, html })), link };
}

async function sendPasswordChangedEmail(to) {
  const subject = "Password Admin Anda Telah Diubah";
  const text =
    `Password akun admin Anda baru saja diubah. Semua sesi lain telah dicabut.\n\n` +
    `Jika ini bukan Anda, segera hubungi penanggung jawab keamanan aplikasi.`;
  const html = wrap(
    "Password Diubah",
    `<p>Password akun admin Anda baru saja <b>diubah</b>. Semua sesi lain telah dicabut.</p>
     <p>Jika ini bukan Anda, segera hubungi penanggung jawab keamanan aplikasi.</p>`,
  );
  return sendMail({ to, subject, text, html });
}

// Kirim password baru (hasil reset "Lupa Password") ke email terdaftar.
async function sendNewPasswordEmail(to, password) {
  const subject = "Password Baru Admin Live Chat";
  const text =
    `Permintaan reset password diterima. Sistem telah membuat password baru untuk akun ini.\n\n` +
    `Password baru: ${password}\n\n` +
    `Segera login dan ganti password ini melalui menu "Ganti Password".\n` +
    `Semua sesi lain telah dicabut.\n\n` +
    `Jika ini bukan Anda, segera hubungi penanggung jawab keamanan aplikasi.`;
  const html = wrap(
    "Password Baru Admin",
    `<p>Permintaan <b>reset password</b> diterima. Sistem telah membuat password baru untuk akun ini.</p>
     <p>Password baru Anda:</p>
     <p style="font-size:20px;font-family:monospace;background:#f1f5f9;padding:10px 14px;border-radius:8px;display:inline-block"><b>${password}</b></p>
     <p>Segera login lalu ganti password ini melalui menu <b>Ganti Password</b>. Semua sesi lain telah dicabut.</p>
     <p style="font-size:13px;color:#64748b">Jika ini bukan Anda, segera hubungi penanggung jawab keamanan aplikasi.</p>`,
  );
  return sendMail({ to, subject, text, html });
}

module.exports = {
  getBaseUrl,
  mailerConfigured,
  sendMail,
  sendActivationEmail,
  sendResetEmail,
  sendPasswordChangedEmail,
  sendNewPasswordEmail,
};
