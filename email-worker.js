// =============================================
// EMAIL WORKER: notifikasi pesan baru via email
//
// Alur:
//   pesan tersimpan -> queueEmailForMessage() -> email_outbox (pending)
//   -> worker berkala mengirim setelah jeda, dengan pemeriksaan ulang:
//      penerima masih offline, masih opt-in, dan (untuk admin) masih unread.
//
// Prinsip:
//   - Simpan dulu, notifikasi kemudian (tidak pernah sebelum INSERT sukses).
//   - Satu baris pending per penerima -> pesan beruntun digabung.
//   - Kegagalan email tidak boleh mengganggu chat.
//   - Alamat email tidak pernah dicatat mentah di log.
//   - In-memory presence -> cocok untuk satu instance (lihat presence.js).
// =============================================
const mailer = require("./mailer");
const presence = require("./presence");

function envInt(name, fallback, min, max) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  const v = Math.floor(n);
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function isEnabled() {
  const raw = String(process.env.EMAIL_NOTIFY_ENABLED || "true").trim().toLowerCase();
  return raw !== "false" && raw !== "0" && raw !== "off";
}

function isDryRun() {
  const raw = String(process.env.EMAIL_DRY_RUN || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

// Fitur siap dipakai bila diaktifkan dan SMTP tersedia (atau mode dry-run).
function featureReady() {
  if (!isEnabled()) return false;
  return isDryRun() || mailer.mailerConfigured();
}

function getDelaySeconds() {
  return envInt("EMAIL_NOTIFY_DELAY_SECONDS", 90, 0, 86400);
}

function getMaxAttempts() {
  return envInt("EMAIL_MAX_ATTEMPTS", 5, 1, 100);
}

function getMaxPerHour() {
  return envInt("EMAIL_MAX_PER_HOUR", 6, 1, 1000);
}

function getNotifyUrl() {
  const explicit = String(process.env.EMAIL_NOTIFY_URL || "").trim();
  if (explicit) return explicit;
  // Default sesuai format pesan yang diminta. Dapat dioverride lewat
  // EMAIL_NOTIFY_URL (mis. saat staging).
  return "https://livechat.demakkab.go.id";
}

// Format roomId: "<rumah_sakit>_<id_pasien>".
function roomHospital(roomId) {
  const raw = String(roomId || "");
  const i = raw.lastIndexOf("_");
  return i > -1 ? raw.substring(0, i) : raw;
}

function patientIdFromRoom(roomId) {
  return presence.patientIdFromRoom(roomId);
}

// Tulis/naikkan baris outbox. Satu baris pending per penerima.
async function upsertOutbox(db, recipient, roomId, messageId) {
  const delay = getDelaySeconds();
  await db.query(
    `INSERT INTO email_outbox
       (recipient_type, recipient_id, recipient_email, room_id,
        message_count, first_message_id, last_message_id, not_before)
     VALUES ($1, $2, $3, $4, 1, $5, $5,
             NOW() + make_interval(secs => $6::double precision))
     ON CONFLICT (recipient_type, recipient_id) WHERE status = 'pending'
     DO UPDATE SET
       message_count   = email_outbox.message_count + EXCLUDED.message_count,
       last_message_id = EXCLUDED.last_message_id,
       recipient_email = EXCLUDED.recipient_email,
       room_id         = EXCLUDED.room_id,
       not_before      = GREATEST(email_outbox.not_before, EXCLUDED.not_before),
       updated_at      = NOW()`,
    [
      recipient.type,
      recipient.id,
      recipient.email,
      roomId,
      Number(messageId) || null,
      delay,
    ],
  );
}

// Dipanggil setelah pesan benar-benar tersimpan. Best effort: pemanggil
// cukup `.catch()` dan tidak boleh menunggu hasilnya untuk ACK chat.
async function queueEmailForMessage({ db, sender, roomId, messageId }) {
  if (!featureReady()) return;
  if (!db || !sender || !roomId || !sender.type) return;

  const rs = roomHospital(roomId);

  if (sender.type === "patient") {
    // Bila ada admin RS yang sedang membuka aplikasi, cukup badge/chat.
    if (presence.isHospitalAdminVisible(rs)) return;

    const r = await db.query(
      `SELECT id, email FROM admins
        WHERE rumah_sakit = $1
          AND is_active = TRUE
          AND email IS NOT NULL
          AND email <> ''
          AND email_notify = TRUE`,
      [rs],
    );
    for (const admin of r.rows) {
      const email = mailer.normalizeEmail(admin.email);
      if (!email) continue;
      await upsertOutbox(
        db,
        { type: "admin", id: admin.id, email },
        roomId,
        messageId,
      );
    }
    return;
  }

  if (sender.type === "admin") {
    const patientId = patientIdFromRoom(roomId);
    if (!patientId) return;
    if (presence.isPatientVisible(patientId)) return;

    const r = await db.query(
      `SELECT id, email FROM patients
        WHERE id = $1
          AND chat_ended_at IS NULL
          AND email IS NOT NULL
          AND email <> ''
          AND email_notify = TRUE`,
      [patientId],
    );
    const patient = r.rows[0];
    if (!patient) return;
    const email = mailer.normalizeEmail(patient.email);
    if (!email) return;
    await upsertOutbox(
      db,
      { type: "patient", id: patient.id, email },
      roomId,
      messageId,
    );
  }
}

async function markCancelled(db, row, code) {
  await db.query(
    `UPDATE email_outbox
        SET status = 'cancelled', last_error_code = $2, updated_at = NOW()
      WHERE id = $1 AND status = 'pending'`,
    [row.id, code],
  );
}

async function markSent(db, row) {
  await db.query(
    `UPDATE email_outbox
        SET status = 'sent', sent_at = NOW(), attempts = attempts + 1,
            last_error_code = NULL, updated_at = NOW()
      WHERE id = $1 AND status = 'pending'`,
    [row.id],
  );
}

async function retryOrFail(db, row, code) {
  const maxAttempts = getMaxAttempts();
  const attempts = Number(row.attempts || 0) + 1;
  if (attempts >= maxAttempts) {
    await db.query(
      `UPDATE email_outbox
          SET status = 'failed', attempts = $2, last_error_code = $3,
              updated_at = NOW()
        WHERE id = $1 AND status = 'pending'`,
      [row.id, attempts, code],
    );
    console.error(
      `[EMAIL] outbox #${row.id} (${row.recipient_type}) gagal permanen setelah ${attempts} percobaan.`,
    );
    return;
  }
  // Backoff eksponensial: 2 menit, 4 menit, ... maksimal 30 menit.
  const backoffSeconds = Math.min(1800, 120 * Math.pow(2, attempts - 1));
  await db.query(
    `UPDATE email_outbox
        SET attempts = $2, last_error_code = $3,
            not_before = NOW() + make_interval(secs => $4::double precision),
            updated_at = NOW()
      WHERE id = $1 AND status = 'pending'`,
    [row.id, attempts, code, backoffSeconds],
  );
}

async function processRow(db, row) {
  const recipientId = Number(row.recipient_id);
  if (!Number.isInteger(recipientId) || recipientId <= 0) {
    await markCancelled(db, row, "invalid_recipient");
    return;
  }

  let email = null;

  if (row.recipient_type === "admin") {
    const r = await db.query(
      `SELECT id, username, email, email_notify, is_active, rumah_sakit
         FROM admins WHERE id = $1`,
      [recipientId],
    );
    const admin = r.rows[0];
    if (!admin || !admin.is_active) {
      await markCancelled(db, row, "recipient_inactive");
      return;
    }
    if (!admin.email_notify) {
      await markCancelled(db, row, "recipient_opt_out");
      return;
    }
    email = mailer.normalizeEmail(admin.email);
    if (!email) {
      await markCancelled(db, row, "invalid_email");
      return;
    }
    if (presence.isHospitalAdminVisible(admin.rumah_sakit)) {
      await markCancelled(db, row, "recipient_online");
      return;
    }
    // Admin harus masih punya pesan belum dibaca pada room ini.
    if (row.room_id) {
      const unread = await db.query(
        `SELECT unread_count FROM room_unread
          WHERE admin_name = $1 AND room_id = $2`,
        [admin.username, row.room_id],
      );
      if (
        !unread.rows.length ||
        Number(unread.rows[0].unread_count) <= 0
      ) {
        await markCancelled(db, row, "already_read");
        return;
      }
    }
  } else if (row.recipient_type === "patient") {
    const r = await db.query(
      "SELECT id, email, email_notify, chat_ended_at FROM patients WHERE id = $1",
      [recipientId],
    );
    const patient = r.rows[0];
    if (!patient) {
      await markCancelled(db, row, "recipient_deleted");
      return;
    }
    if (patient.chat_ended_at) {
      await markCancelled(db, row, "chat_ended");
      return;
    }
    if (!patient.email_notify) {
      await markCancelled(db, row, "recipient_opt_out");
      return;
    }
    email = mailer.normalizeEmail(patient.email);
    if (!email) {
      await markCancelled(db, row, "invalid_email");
      return;
    }
    if (presence.isPatientVisible(recipientId)) {
      await markCancelled(db, row, "recipient_online");
      return;
    }
  } else {
    await markCancelled(db, row, "invalid_recipient_type");
    return;
  }

  // Batas jumlah email per penerima per jam: tunda, jangan kirim.
  const cap = getMaxPerHour();
  const sent = await db.query(
    `SELECT COUNT(*)::int AS n FROM email_outbox
      WHERE recipient_type = $1 AND recipient_id = $2
        AND status = 'sent' AND sent_at > NOW() - INTERVAL '1 hour'`,
    [row.recipient_type, recipientId],
  );
  if (Number(sent.rows[0].n) >= cap) {
    await db.query(
      `UPDATE email_outbox
          SET not_before = NOW() + INTERVAL '5 minutes', updated_at = NOW()
        WHERE id = $1 AND status = 'pending'`,
      [row.id],
    );
    return;
  }

  if (isDryRun()) {
    await markSent(db, row);
    console.log(
      `[EMAIL][DRY RUN] outbox #${row.id} (${row.recipient_type}) ditandai terkirim.`,
    );
    return;
  }

  let result;
  try {
    result = await mailer.sendNewMessageEmail(email, {
      count: Number(row.message_count) || 1,
      url: getNotifyUrl(),
      attempts: 1,
    });
  } catch (err) {
    await retryOrFail(db, row, "mailer_exception");
    return;
  }

  if (result && result.skipped) {
    // SMTP tidak tersedia: jangan ulangi tanpa batas.
    await retryOrFail(db, row, "smtp_not_configured");
    return;
  }
  if (result && result.error) {
    await retryOrFail(db, row, "smtp_error");
    return;
  }

  await markSent(db, row);
  console.log(
    `[EMAIL] outbox #${row.id} (${row.recipient_type}) terkirim, count=${row.message_count || 1}.`,
  );
}

async function cleanup(db) {
  const retentionDays = envInt("EMAIL_RETENTION_DAYS", 30, 1, 3650);
  await db.query(
    `DELETE FROM email_outbox
      WHERE status IN ('sent','failed','cancelled')
        AND updated_at < NOW() - make_interval(days => $1::int)`,
    [retentionDays],
  );
  // Baris pending yang tertinggal terlalu lama (mis. server sering mati) dibatalkan.
  await db.query(
    `UPDATE email_outbox
        SET status = 'cancelled', last_error_code = 'expired', updated_at = NOW()
      WHERE status = 'pending' AND created_at < NOW() - INTERVAL '24 hours'`,
  );
}

let timer = null;
let running = false;
let lastCleanupAt = 0;

async function runOnce(db) {
  if (running) return;
  running = true;
  try {
    const batch = envInt("EMAIL_WORKER_BATCH", 50, 1, 200);
    const r = await db.query(
      `SELECT * FROM email_outbox
        WHERE status = 'pending' AND not_before <= NOW()
        ORDER BY not_before
        LIMIT $1`,
      [batch],
    );
    for (const row of r.rows) {
      try {
        await processRow(db, row);
      } catch (err) {
        console.error(
          `[EMAIL] gagal memproses outbox #${row.id} (${row.recipient_type}):`,
          err.message,
        );
      }
    }

    // Retensi cukup dijalankan sekali sehari.
    if (Date.now() - lastCleanupAt > 24 * 60 * 60 * 1000) {
      lastCleanupAt = Date.now();
      await cleanup(db).catch((err) =>
        console.error("[EMAIL] gagal cleanup outbox:", err.message),
      );
    }
  } finally {
    running = false;
  }
}

function startEmailWorker({ db } = {}) {
  if (!db) return null;
  if (!isEnabled()) {
    console.log("[EMAIL] Notifikasi email nonaktif (EMAIL_NOTIFY_ENABLED).");
    return null;
  }
  if (!isDryRun() && !mailer.mailerConfigured()) {
    console.warn(
      "[EMAIL] SMTP belum dikonfigurasi -> worker notifikasi email nonaktif.",
    );
    return null;
  }
  if (timer) return timer;

  const intervalSeconds = envInt("EMAIL_WORKER_INTERVAL_SECONDS", 20, 5, 3600);
  timer = setInterval(() => {
    runOnce(db).catch((err) =>
      console.error("[EMAIL] worker error:", err.message),
    );
  }, intervalSeconds * 1000);
  if (typeof timer.unref === "function") timer.unref();

  // Jalankan sekali saat startup untuk melanjutkan outbox setelah restart.
  runOnce(db).catch((err) =>
    console.error("[EMAIL] worker error:", err.message),
  );

  console.log(
    `[EMAIL] Worker notifikasi email aktif (interval ${intervalSeconds}s, jeda ${getDelaySeconds()}s${
      isDryRun() ? ", DRY RUN" : ""
    }).`,
  );
  return timer;
}

function stopEmailWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  queueEmailForMessage,
  startEmailWorker,
  stopEmailWorker,
  runOnce,
  isEnabled,
  isDryRun,
  featureReady,
  getNotifyUrl,
};
