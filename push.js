// =============================================
// WEB PUSH (Web Push API) - pengiriman notifikasi pesan baru
//
// - Konfigurasi VAPID dari environment (private key = secret).
// - Best effort: kegagalan push tidak boleh mengganggu chat/Socket.IO.
// - Subscription kedaluwarsa (404/410) dihapus otomatis.
// - Tidak mencatat isi pesan / credential ke log.
// =============================================
const webpush = require("web-push");

let enabled = false;

function initPush() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:admin@example.com";
  if (publicKey && privateKey) {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    enabled = true;
    console.log("Web Push (VAPID) aktif.");
  } else {
    console.warn(
      "[PUSH] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY belum diset -> Web Push nonaktif.",
    );
  }
  return enabled;
}

function isEnabled() {
  return enabled;
}

function getPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

// Kirim ke sekumpulan baris push_subscriptions. `db` = pg Pool.
async function sendToSubscriptions(db, subs, payload) {
  if (!enabled || !subs || !subs.length) return;
  const body = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (s) => {
      const subscription = {
        endpoint: s.endpoint,
        keys: { p256dh: s.p256dh, auth: s.auth },
      };
      try {
        await webpush.sendNotification(subscription, body, { TTL: 60 * 60 });
        db.query("UPDATE push_subscriptions SET last_used_at = NOW() WHERE id = $1", [
          s.id,
        ]).catch(() => {});
      } catch (err) {
        const code = err && err.statusCode;
        if (code === 404 || code === 410) {
          // Subscription tidak lagi valid -> hapus.
          db.query("DELETE FROM push_subscriptions WHERE id = $1", [s.id]).catch(
            () => {},
          );
        } else {
          console.error(
            "[PUSH] gagal kirim (status " + (code || "?") + "):",
            (err && err.message) || err,
          );
        }
      }
    }),
  );
}

// Ambil subscription pasien tertentu.
async function getPatientSubscriptions(db, patientId) {
  const r = await db.query(
    `SELECT id, endpoint, p256dh, auth FROM push_subscriptions
      WHERE owner_type = 'patient' AND owner_id = $1 AND revoked_at IS NULL`,
    [patientId],
  );
  return r.rows;
}

// Ambil subscription seluruh admin pada rumah sakit tertentu.
async function getHospitalAdminSubscriptions(db, rumahSakit) {
  const r = await db.query(
    `SELECT ps.id, ps.endpoint, ps.p256dh, ps.auth
       FROM push_subscriptions ps
       JOIN admins a ON a.id = ps.owner_id
      WHERE ps.owner_type = 'admin' AND ps.revoked_at IS NULL
        AND a.rumah_sakit = $1 AND a.is_active = TRUE`,
    [rumahSakit],
  );
  return r.rows;
}

module.exports = {
  initPush,
  isEnabled,
  getPublicKey,
  sendToSubscriptions,
  getPatientSubscriptions,
  getHospitalAdminSubscriptions,
};
