require("dotenv").config({ override: true }); // Load .env file, override existing env vars
const express = require("express");
const { Pool } = require("pg");
const BodyParser = require("body-parser");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = require("express-rate-limit");
const helmet = require("helmet");
const { RedisStore: SessionRedisStore } = require("connect-redis");
const { RedisStore: LimiterRedisStore } = require("rate-limit-redis");
const { createClient } = require("redis");
const fs = require("fs");
const path = require("path");
const mailer = require("./mailer");
const push = require("./push");

const app = express();
const http = require("http");
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

const IS_PRODUCTION = process.env.NODE_ENV === "production";
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  (IS_PRODUCTION
    ? ""
    : "insecure-dev-secret-change-me-in-env");

if (!SESSION_SECRET) {
  throw new Error("SESSION_SECRET wajib diisi pada environment production.");
}

app.disable("x-powered-by"); // Kurangi fingerprinting Express
app.set("trust proxy", 1); // Di belakang reverse-proxy (Vercel, dll.)

// Security headers global (Helmet). CSP global dimatikan agar tidak bentrok
// dengan inline script pada EJS; CSP ketat khusus file tetap di /api/file/:id.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }),
);

// File statis publik (manifest, service worker, ikon). Diletakkan sebelum
// session/rate-limit agar aset tidak membuat sesi atau termakan limiter.
app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith("service-worker.js")) {
        res.set("Cache-Control", "no-cache, no-store, must-revalidate");
      }
    },
  }),
);

app.use(BodyParser.urlencoded({ extended: true, limit: "20mb" }));
app.use(BodyParser.json({ limit: "20mb" }));

// =============================================
// REDIS (session store + rate-limit store, opsional via REDIS_URL)
// =============================================
let sessionStore;
let limiterStore;

if (process.env.REDIS_URL) {
  const redisClient = createClient({ url: process.env.REDIS_URL });
  redisClient.on("error", (err) => console.error("Redis error:", err.message));
  redisClient
    .connect()
    .then(() => console.log("Redis terhubung! Session & rate-limit memakai Redis."))
    .catch((err) => console.error("Gagal koneksi Redis:", err.message));

  sessionStore = new SessionRedisStore({ client: redisClient, prefix: "lc:sess:" });
  limiterStore = () =>
    new LimiterRedisStore({
      sendCommand: (...args) => redisClient.sendCommand(args),
      prefix: "lc:rl:",
    });
} else {
  console.warn(
    "[PERINGATAN] REDIS_URL tidak diset -> memakai MemoryStore. " +
      "Tidak disarankan untuk production / multi-instance.",
  );
}

const sessionMiddleware = session({
  name: "lc_sid", // hindari nama default "connect.sid"
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: {
    httpOnly: true,
    secure: IS_PRODUCTION || process.env.COOKIE_SECURE === "true",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
});

app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

// =============================================
// RATE LIMIT (global + endpoint sensitif)
// =============================================
function makeStoreOpts() {
  return limiterStore ? { store: limiterStore() } : {};
}

// Global: melindungi seluruh endpoint dari flooding / bot / scanner.
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Terlalu banyak permintaan. Coba lagi nanti." },
  // Socket.IO polling punya kanal sendiri (jangan ikut dibatasi di sini).
  skip: (req) => req.path.startsWith("/socket.io"),
  ...makeStoreOpts(),
});

// Registrasi pasien: batasi ketat anti-spam.
const registerLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Terlalu banyak pendaftaran. Coba lagi beberapa saat." },
  ...makeStoreOpts(),
});

// Upload file: batasi agar tidak dipakai abuse/DoS.
const uploadLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Terlalu banyak unggahan. Coba lagi beberapa saat." },
  ...makeStoreOpts(),
});

app.use(globalLimiter);

app.set("view engine", "ejs");
app.set("views", "views");

// =============================================
// IDENTITAS SESSION (pasien / admin)
// =============================================
// Pasien: { type:'patient', roomId, name, rumahSakit }
// Admin : { type:'admin', name, rumahSakit }
function sessionIdentity(req) {
  const s = req.session;
  if (!s) return null;
  if (s.isAdmin && s.adminUser) {
    return { type: "admin", name: s.adminUser, rumahSakit: s.adminRumahSakit };
  }
  if (s.patientRoomId) {
    return {
      type: "patient",
      roomId: s.patientRoomId,
      name: s.patientName,
      rumahSakit: s.patientRumahSakit,
    };
  }
  return null;
}

// Cek: identitas boleh mengakses room tertentu?
function identityCanAccessRoom(id, roomId) {
  if (!id || !roomId) return false;
  if (id.type === "patient") return roomId === id.roomId;
  if (id.type === "admin") return roomHospital(roomId) === id.rumahSakit;
  return false;
}

// =============================================
// WEB PUSH: konteks pemilik subscription dari sesi server (bukan dari body)
// =============================================
function pushOwnerFromSession(req) {
  const s = req.session;
  if (!s) return null;
  if (s.isAdmin && s.adminId && s.adminRumahSakit) {
    return {
      owner_type: "admin",
      owner_id: s.adminId,
      rumah_sakit: s.adminRumahSakit,
      room_id: null,
    };
  }
  if (s.patientRoomId) {
    const i = s.patientRoomId.lastIndexOf("_");
    const idPart = i > -1 ? s.patientRoomId.slice(i + 1) : "";
    if (!/^\d+$/.test(idPart)) return null;
    return {
      owner_type: "patient",
      owner_id: Number(idPart),
      rumah_sakit: s.patientRumahSakit || null,
      room_id: s.patientRoomId,
    };
  }
  return null;
}

// Hanya izinkan endpoint dari push service yang dikenal (cegah SSRF/proxy).
const PUSH_ENDPOINT_SUFFIXES = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "push.services.mozilla.com",
  "notify.windows.com",
  "push.apple.com",
];
function isValidPushEndpoint(endpoint) {
  if (
    typeof endpoint !== "string" ||
    endpoint.length < 12 ||
    endpoint.length > 2000
  )
    return false;
  let url;
  try {
    url = new URL(endpoint);
  } catch (e) {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return PUSH_ENDPOINT_SUFFIXES.some(
    (sfx) => host === sfx || host.endsWith("." + sfx),
  );
}
const BASE64URL_RE = /^[A-Za-z0-9\-_]+={0,2}$/;
function parsePushSubscription(body) {
  if (!body || typeof body !== "object") return null;
  const keys = body.keys || {};
  const endpoint = body.endpoint;
  const p256dh = keys.p256dh;
  const auth = keys.auth;
  if (!isValidPushEndpoint(endpoint)) return null;
  if (
    typeof p256dh !== "string" ||
    p256dh.length < 20 ||
    p256dh.length > 250 ||
    !BASE64URL_RE.test(p256dh)
  )
    return null;
  if (
    typeof auth !== "string" ||
    auth.length < 10 ||
    auth.length > 100 ||
    !BASE64URL_RE.test(auth)
  )
    return null;
  return { endpoint, p256dh, auth };
}

// =============================================
// CSRF PROTECTION (token per session)
// =============================================
app.use((req, res, next) => {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(16).toString("hex");
  }
  res.locals.csrfToken = req.session.csrfToken;
  next();
});

app.use((req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].indexOf(req.method) !== -1) return next();
  const token =
    req.get("x-csrf-token") || (req.body && req.body._csrf) || "";
  if (!token || token !== req.session.csrfToken) {
    return res.status(403).json({ error: "CSRF token tidak valid." });
  }
  next();
});

// =============================================
// MIDDLEWARE: Cegah browser cache halaman admin
// =============================================
app.use("/admin", (req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
});

// =============================================
// DATABASE
// =============================================
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

db.connect((err, client, release) => {
  if (err) {
    console.error("Gagal koneksi database:", err.message);
    return;
  }
  release();
  console.log("Database Supabase terhubung!");
});

// Pastikan kolom is_pinned (fitur sematkan room) tersedia.
db.query(
  "ALTER TABLE patients ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN NOT NULL DEFAULT FALSE;",
)
  .then(() => console.log("Kolom is_pinned siap."))
  .catch((err) => console.error("Gagal menambah kolom is_pinned:", err.message));

// Pastikan kolom patient_token (fitur identitas pasien tetap) tersedia.
db.query(
  `ALTER TABLE patients ADD COLUMN IF NOT EXISTS patient_token TEXT;
   CREATE UNIQUE INDEX IF NOT EXISTS idx_patients_token ON patients(patient_token) WHERE patient_token IS NOT NULL;`,
)
  .then(() => console.log("Kolom patient_token siap."))
  .catch((err) => console.error("Gagal menambah kolom patient_token:", err.message));

// Pastikan tabel notifikasi unread (badge pesan baru) tersedia.
db.query(
  `CREATE TABLE IF NOT EXISTS room_unread (
     admin_name TEXT NOT NULL,
     room_id TEXT NOT NULL,
     unread_count INTEGER NOT NULL DEFAULT 0,
     updated_at TIMESTAMPTZ DEFAULT NOW(),
     PRIMARY KEY (admin_name, room_id)
   );`,
)
  .then(() => console.log("Tabel room_unread siap."))
  .catch((err) => console.error("Gagal membuat tabel room_unread:", err.message));

// Pastikan tabel push_subscriptions (Web Push) tersedia (lihat migrate-push-subscriptions.js).
db.query(
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
   );`,
)
  .then(() => console.log("Tabel push_subscriptions siap."))
  .catch((err) => console.error("Gagal membuat tabel push_subscriptions:", err.message));

// Aktifkan Web Push (VAPID) bila kunci tersedia di environment.
push.initPush();

// =============================================
// KEAMANAN UPLOAD: magic bytes + whitelist MIME
// =============================================
// MIME dokumen yang diizinkan (disimpan apa adanya dari client).
const DOC_MIME_ALLOW = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/zip",
  "text/plain",
  "text/csv",
]);

// Deteksi tipe file dari isi byte (bukan dari klaim client).
function sniffUpload(buf) {
  if (!buf || buf.length < 4) return null;
  // Gambar
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
    return { kind: "media", mime: "image/jpeg" };
  if (buf.readUInt32BE(0) === 0x89504e47)
    return { kind: "media", mime: "image/png" };
  if (buf.toString("latin1", 0, 4) === "GIF8")
    return { kind: "media", mime: "image/gif" };
  if (
    buf.toString("latin1", 0, 4) === "RIFF" &&
    buf.toString("latin1", 8, 12) === "WEBP"
  )
    return { kind: "media", mime: "image/webp" };
  if (buf.toString("latin1", 0, 2) === "BM" && buf.length >= 14)
    return { kind: "media", mime: "image/bmp" };
  // Video
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3)
    return { kind: "media", mime: "video/webm" };
  if (buf.toString("latin1", 4, 8) === "ftyp") {
    const brand = buf.toString("latin1", 8, 12);
    if (brand === "qt  ") return { kind: "media", mime: "video/quicktime" };
    if (/^[a-zA-Z0-9]+$/.test(brand.trim()))
      return { kind: "media", mime: "video/mp4" };
  }
  // Dokumen
  if (buf.toString("latin1", 0, 4) === "%PDF")
    return { kind: "doc", mime: "application/pdf" };
  if (buf.readUInt32LE(0) === 0x04034b50)
    return { kind: "doc", mime: "application/zip" };
  if (
    buf[0] === 0xd0 &&
    buf[1] === 0xcf &&
    buf[2] === 0x11 &&
    buf[3] === 0xe0
  )
    return { kind: "doc", mime: "application/octet-stream" }; // doc/xls/ppt lama
  return null;
}

// =============================================
// UPGRADE PASSWORD ADMIN (plaintext -> bcrypt) saat start
// =============================================
async function upgradePlaintextPasswords() {
  const res = await db.query("SELECT id, password FROM admins WHERE password IS NOT NULL");
  for (const row of res.rows) {
    const pw = String(row.password || "");
    if (!pw) continue;
    if (pw.startsWith("$2a$") || pw.startsWith("$2b$") || pw.startsWith("$2y$")) {
      continue;
    }
    const hash = bcrypt.hashSync(pw, 10);
    await db.query("UPDATE admins SET password = $1 WHERE id = $2", [
      hash,
      row.id,
    ]);
    console.log(`Password admin id=${row.id} di-hash ke bcrypt.`);
  }
}

upgradePlaintextPasswords().catch((err) =>
  console.error("Gagal upgrade password admin:", err.message),
);

// =============================================
// BANTUAN: Pesan & visibilitas
// =============================================
const MSG_COLS =
  "id, room_id, sender_name, message, message_type, file_name, file_mime, file_size, created_at, reply_to";
const DELETE_ALL_WINDOW_SECS = 120; // 2 menit untuk "Hapus untuk Semua Orang"

// Lampirkan snapshot pesan yang dibalas (untuk fitur balas / reply)
async function attachReplyInfo(rows) {
  if (!rows || rows.length === 0) return rows;
  const replyIds = [
    ...new Set(rows.map((r) => r.reply_to).filter((id) => id != null)),
  ];
  if (replyIds.length === 0) {
    return rows.map((r) => {
      r.reply = null;
      return r;
    });
  }
  const res = await db.query(
    "SELECT id, sender_name, message, message_type, file_name, file_mime, file_size FROM messages WHERE id = ANY($1::int[])",
    [replyIds],
  );
  const byId = new Map(res.rows.map((r) => [r.id, r]));
  return rows.map((r) => {
    if (r.reply_to != null) {
      const t = byId.get(r.reply_to);
      r.reply = t
        ? {
            id: t.id,
            sender_name: t.sender_name,
            text: t.message,
            message_type: t.message_type,
            file_name: t.file_name,
            file_mime: t.file_mime,
            file_size: t.file_size,
          }
        : null;
    } else {
      r.reply = null;
    }
    return r;
  });
}

// Ambil pesan per room dengan filter "Hapus untuk Saya" untuk viewer tertentu
async function fetchRoomMessages(roomId, viewerName, limit) {
  let q = `SELECT ${MSG_COLS} FROM messages
           WHERE room_id = $1
             AND NOT EXISTS (
               SELECT 1 FROM message_visibility mv
               WHERE mv.message_id = messages.id AND mv.user_name = $2
             )
           ORDER BY created_at ASC`;
  const params = [roomId, viewerName || ""];
  if (limit && limit > 0) {
    q += " LIMIT $3";
    params.push(limit);
  }
  const result = await db.query(q, params);
  return attachReplyInfo(result.rows);
}

// Hapus total chat room (pasien + semua pesan), scoped per rumah sakit.
// Mengembalikan { ok: false, status, error } bila pasien tidak ditemukan
// atau bukan milik rumah sakit tersebut.
async function deletePatientFully(patientId, rumahSakit) {
  const userResult = await db.query("SELECT * FROM patients WHERE id = $1", [
    patientId,
  ]);
  const user = userResult.rows[0];
  if (!user) return { ok: false, status: 404, error: "Pasien tidak ditemukan." };
  if (user.rumah_sakit !== rumahSakit)
    return { ok: false, status: 403, error: "Akses ditolak." };

  const roomId = `${user.rumah_sakit}_${user.id}`;
  await db.query("DELETE FROM messages WHERE room_id = $1", [roomId]);
  await db.query("DELETE FROM message_visibility WHERE room_id = $1", [roomId]).catch(() => {});
  await db.query("DELETE FROM push_subscriptions WHERE room_id = $1", [roomId]).catch(() => {});
  await db.query("DELETE FROM room_unread WHERE room_id = $1", [roomId]).catch(() => {});
  await db.query("DELETE FROM patients WHERE id = $1", [patientId]);

  // Beri tahu pasien di room tersebut agar otomatis kembali ke form awal
  io.to(roomId).emit("chat-deleted");
  return { ok: true };
}

// =============================================
// DAFTAR RUMAH SAKIT
// =============================================
const RUMAH_SAKIT_LIST = [
  "RSUD Sunan Kalijaga",
  "RSI Nahdlatul Ulama",
  "RS Pelita Anugerah",
  "RSUD Sultan Fatah",
  "RS Hj. Fatimah Sulhan",
  "Charlie Hospital",
];

// =============================================
// KEAMANAN ADMIN: kebijakan password & token sekali pakai
// =============================================
const ACTIVATION_TTL_MS = 30 * 60 * 1000; // 30 menit
const RESET_TTL_MS = 30 * 60 * 1000; // 30 menit
const BCRYPT_ROUNDS = 12;

const COMMON_PASSWORDS = new Set([
  "password",
  "password123",
  "password1234",
  "123456789012",
  "qwerty123456",
  "qwertyuiop12",
  "admin1234567",
  "iloveyou1234",
  "letmein12345",
  "welcome12345",
  "p@ssw0rd1234",
]);
try {
  const extraPath = path.join(__dirname, "database", "common-passwords.txt");
  if (fs.existsSync(extraPath)) {
    fs.readFileSync(extraPath, "utf8")
      .split(/\r?\n/)
      .forEach((w) => {
        const s = w.trim().toLowerCase();
        if (s) COMMON_PASSWORDS.add(s);
      });
  }
} catch (e) {
  /* abaikan bila file blocklist tidak ada */
}

function validatePasswordPolicy(pw, { email, username } = {}) {
  if (typeof pw !== "string" || pw.length === 0) return "Password wajib diisi.";
  const chars = [...pw].length;
  if (chars < 12) return "Password minimal 12 karakter.";
  if (pw.length > 200) return "Password maksimal 200 karakter.";
  const low = pw.toLowerCase();
  if (COMMON_PASSWORDS.has(low)) return "Password terlalu umum, gunakan yang lain.";
  if (email && low === String(email).toLowerCase())
    return "Password tidak boleh sama dengan email.";
  if (username && low === String(username).toLowerCase())
    return "Password tidak boleh sama dengan username.";
  if (/^(.)\1+$/.test(pw)) return "Password terlalu lemah (karakter berulang).";
  if (/^(0123456789|1234567890|abcdefghijkl|123123123123)/.test(low))
    return "Password terlalu mudah ditebak.";
  return null;
}

function hashToken(raw) {
  return crypto.createHash("sha256").update(String(raw)).digest("hex");
}

// Buat password acak kuat (dijamin memuat huruf besar/kecil, angka, simbol).
function generateStrongPassword(len = 16) {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#$%^*-_=+";
  const all = upper + lower + digits + symbols;
  const pick = (set) => set[crypto.randomInt(set.length)];
  const chars = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  while (chars.length < len) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

// Terbitkan token baru (mentah dikembalikan; DB hanya menyimpan hash).
async function issueToken(adminId, purpose, ttlMs) {
  const raw = crypto.randomBytes(32).toString("hex");
  const hash = hashToken(raw);
  const expiresAt = new Date(Date.now() + ttlMs);
  // Batalkan token lama yang belum terpakai untuk tujuan yang sama.
  await db.query(
    "UPDATE admin_tokens SET used_at = NOW() WHERE admin_id = $1 AND purpose = $2 AND used_at IS NULL",
    [adminId, purpose],
  );
  await db.query(
    "INSERT INTO admin_tokens (admin_id, purpose, token_hash, expires_at) VALUES ($1,$2,$3,$4)",
    [adminId, purpose, hash, expiresAt],
  );
  return raw;
}

async function findValidToken(raw, purpose) {
  if (!raw || typeof raw !== "string" || raw.length < 32) return null;
  const r = await db.query(
    `SELECT * FROM admin_tokens
      WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > NOW()`,
    [hashToken(raw), purpose],
  );
  return r.rows[0] || null;
}

// Tandai token terpakai secara atomik; true hanya bagi pemanggil pertama.
async function consumeToken(id) {
  const r = await db.query(
    "UPDATE admin_tokens SET used_at = NOW() WHERE id = $1 AND used_at IS NULL RETURNING id",
    [id],
  );
  return r.rows.length === 1;
}

async function getAdminById(id) {
  const r = await db.query("SELECT * FROM admins WHERE id = $1", [id]);
  return r.rows[0] || null;
}

// Halaman berisi token: jangan di-cache & jangan bocorkan referrer.
function noStore(req, res, next) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Referrer-Policy", "no-referrer");
  next();
}

// =============================================
// MIDDLEWARE: Cek login admin (validasi sesi terkini)
// =============================================
async function requireAdmin(req, res, next) {
  if (!req.session || !req.session.isAdmin || !req.session.adminId) {
    return res.redirect("/admin/login");
  }
  try {
    const r = await db.query(
      "SELECT is_active, session_version FROM admins WHERE id = $1",
      [req.session.adminId],
    );
    const row = r.rows[0];
    // Akun nonaktif / versi sesi berubah (password diubah) -> cabut sesi.
    if (
      !row ||
      !row.is_active ||
      row.session_version !== req.session.adminSessionVersion
    ) {
      return req.session.destroy(() => res.redirect("/admin/login"));
    }
  } catch (err) {
    console.error("Error requireAdmin:", err.message);
    return res.redirect("/admin/login");
  }
  next();
}

// =============================================
// ROUTE: Test Database Connection
// Nonaktif secara default. Hanya aktif bila ALLOW_TEST_DB === "true"
// dan tidak berjalan di production.
// =============================================
app.get("/test-db", async (req, res) => {
  if (IS_PRODUCTION || process.env.ALLOW_TEST_DB !== "true") {
    return res.status(404).send("Not Found");
  }
  try {
    const urlCheck = process.env.DATABASE_URL ? "ADA" : "TIDAK ADA";
    const result = await db.query("SELECT NOW() as waktu");
    const tables = await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    res.json({
      status: "OK",
      databaseUrl: urlCheck,
      waktu: result.rows[0].waktu,
      tabel: tables.rows.map((r) => r.table_name),
    });
  } catch (err) {
    console.error("Error /test-db:", err.message);
    res.json({
      status: "ERROR",
      databaseUrl: process.env.DATABASE_URL ? "ADA" : "TIDAK ADA",
    });
  }
});

// =============================================
// COOKIE & PERSISTENT PATIENT SESSION HELPERS
// =============================================
function getCookie(req, name) {
  const header = req && req.headers && req.headers.cookie;
  if (!header) return null;
  const match = header.match(
    new RegExp("(?:^|;\\s*)" + name.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&") + "=([^;]*)"),
  );
  return match ? decodeURIComponent(match[1]) : null;
}

function setPatientCookie(res, token) {
  res.cookie("dinkes_patient_token", token, {
    httpOnly: true,
    maxAge: 365 * 24 * 60 * 60 * 1000, // 1 tahun
    secure: IS_PRODUCTION || process.env.COOKIE_SECURE === "true",
    sameSite: "lax",
    path: "/",
  });
}

function clearPatientCookie(res) {
  res.clearCookie("dinkes_patient_token", {
    path: "/",
  });
}

// Middleware: Auto-restore sesi pasien dari token persisten jika session server habis
app.use(async (req, res, next) => {
  if (req.session && !req.session.patientRoomId && !req.session.isAdmin) {
    const token = getCookie(req, "dinkes_patient_token");
    if (token && typeof token === "string" && token.length >= 32) {
      try {
        const result = await db.query(
          "SELECT id, nama, alamat, nomor_wa, rumah_sakit, patient_token FROM patients WHERE patient_token = $1",
          [token],
        );
        if (result.rows.length > 0) {
          const patient = result.rows[0];
          req.session.patientRoomId = `${patient.rumah_sakit}_${patient.id}`;
          req.session.patientName = patient.nama;
          req.session.patientRumahSakit = patient.rumah_sakit;
          req.session.patientToken = token;
        } else {
          // Token tidak ada di DB (misal karena admin sudah menghapus total data pasien)
          clearPatientCookie(res);
        }
      } catch (err) {
        console.error("Error auto-restore patient session:", err.message);
      }
    }
  }
  next();
});

// =============================================
// ROUTE: Halaman Utama - Input Data Pasien
// =============================================
app.get("/", async (req, res) => {
  let activePatient = null;

  // Cek apakah ada sesi pasien yang masih aktif
  if (req.session && req.session.patientRoomId) {
    const roomId = req.session.patientRoomId;
    const lastUnderscore = roomId.lastIndexOf("_");
    const userId =
      lastUnderscore > -1 ? roomId.substring(lastUnderscore + 1) : roomId;
    if (/^\d+$/.test(userId)) {
      try {
        const chk = await db.query(
          "SELECT id, nama, rumah_sakit FROM patients WHERE id = $1",
          [userId],
        );
        if (chk.rows.length > 0) {
          activePatient = {
            roomId,
            userName: chk.rows[0].nama || req.session.patientName,
          };
        } else {
          // Pasien sudah dihapus total oleh admin: bersihkan sesi & cookie
          clearPatientCookie(res);
          delete req.session.patientRoomId;
          delete req.session.patientName;
          delete req.session.patientRumahSakit;
          delete req.session.patientToken;
        }
      } catch (err) {
        console.error("Error cek active patient di /:", err.message);
      }
    }
  }

  res.render("index", {
    title: "TAMBAH PASIEN BARU",
    rumahSakitList: RUMAH_SAKIT_LIST,
    activePatient,
  });
});

// =============================================
// ROUTE: Tambah Pasien Baru & Langsung Masuk Chat
// =============================================
app.post("/tambah", registerLimiter, async (req, res) => {
  try {
    const { nama, alamat, nomor_wa, rumah_sakit } = req.body;
    if (!rumah_sakit || !RUMAH_SAKIT_LIST.includes(rumah_sakit)) {
      return res.status(400).send("Rumah sakit tidak valid.");
    }

    // 1. Cek apakah pengguna saat ini sudah memiliki pasien aktif di DB
    let existingPatient = null;

    // Cek berdasarkan token di cookie
    const tokenFromCookie = getCookie(req, "dinkes_patient_token");
    if (tokenFromCookie && tokenFromCookie.length >= 32) {
      const chkToken = await db.query(
        "SELECT id, nama, alamat, nomor_wa, rumah_sakit, patient_token FROM patients WHERE patient_token = $1",
        [tokenFromCookie],
      );
      if (chkToken.rows.length > 0) {
        existingPatient = chkToken.rows[0];
      }
    }

    // Cek berdasarkan session patientRoomId
    if (!existingPatient && req.session && req.session.patientRoomId) {
      const lastUnderscore = req.session.patientRoomId.lastIndexOf("_");
      const userId =
        lastUnderscore > -1
          ? req.session.patientRoomId.substring(lastUnderscore + 1)
          : req.session.patientRoomId;
      if (/^\d+$/.test(userId)) {
        const chkSess = await db.query(
          "SELECT id, nama, alamat, nomor_wa, rumah_sakit, patient_token FROM patients WHERE id = $1",
          [userId],
        );
        if (chkSess.rows.length > 0) {
          existingPatient = chkSess.rows[0];
        }
      }
    }

    // Cek berdasarkan nomor WhatsApp & Rumah Sakit yang sama yang belum dihapus
    if (!existingPatient && nomor_wa) {
      const chkWa = await db.query(
        "SELECT id, nama, alamat, nomor_wa, rumah_sakit, patient_token FROM patients WHERE nomor_wa = $1 AND rumah_sakit = $2 ORDER BY id DESC LIMIT 1",
        [nomor_wa, rumah_sakit],
      );
      if (chkWa.rows.length > 0) {
        existingPatient = chkWa.rows[0];
      }
    }

    // Jika pasien sudah ada dan belum dihapus admin: gunakan ID yang sama dan tetap!
    if (existingPatient) {
      const roomId = `${existingPatient.rumah_sakit}_${existingPatient.id}`;
      let token = existingPatient.patient_token;
      if (!token) {
        token = crypto.randomBytes(32).toString("hex");
        await db.query(
          "UPDATE patients SET patient_token = $1 WHERE id = $2",
          [token, existingPatient.id],
        );
      }
      setPatientCookie(res, token);
      req.session.patientRoomId = roomId;
      req.session.patientName = existingPatient.nama;
      req.session.patientRumahSakit = existingPatient.rumah_sakit;
      req.session.patientToken = token;
      return res.redirect(`/chat/${encodeURIComponent(roomId)}`);
    }

    // Pasien baru (belum pernah ada atau data lama telah dihapus total oleh admin)
    const newToken = crypto.randomBytes(32).toString("hex");
    const result = await db.query(
      "INSERT INTO patients (nama, alamat, nomor_wa, rumah_sakit, patient_token) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [nama, alamat, nomor_wa, rumah_sakit, newToken],
    );
    const newUserId = result.rows[0].id;
    const roomId = `${rumah_sakit}_${newUserId}`;

    // Beri tahu sidebar admin bahwa ada room/pasien baru (muncul di paling atas).
    io.to(ADMIN_CHAN(rumah_sakit)).emit("room-activity", {
      roomId,
      newRoom: true,
      patientName: nama,
    });

    setPatientCookie(res, newToken);
    req.session.regenerate((err) => {
      req.session.patientRoomId = roomId;
      req.session.patientName = nama;
      req.session.patientRumahSakit = rumah_sakit;
      req.session.patientToken = newToken;
      req.session.csrfToken = crypto.randomBytes(16).toString("hex");
      const target = `/chat/${encodeURIComponent(roomId)}`;
      if (err) return res.redirect(target);
      res.redirect(target);
    });
  } catch (err) {
    console.error("Error tambah data:", err.message);
    res.status(500).send("Gagal menyimpan data.");
  }
});

// =============================================
// ROUTE: Chat Publik (per room, hospital-scoped)
// =============================================
app.get("/chat/:roomId", async (req, res) => {
  const roomId = req.params.roomId;
  try {
    // Extract userId from roomId format: "rumahSakit_userId"
    const lastUnderscore = roomId.lastIndexOf("_");
    const userId =
      lastUnderscore > -1 ? roomId.substring(lastUnderscore + 1) : roomId;
    const rumahSakit =
      lastUnderscore > -1 ? roomId.substring(0, lastUnderscore) : "";

    // Jika ID pasien tidak valid, kembali ke form pendaftaran
    if (!/^\d+$/.test(userId)) return res.redirect("/");

    const userResult = await db.query("SELECT * FROM patients WHERE id = $1", [
      userId,
    ]);
    const user = userResult.rows[0];

    // Jika pasien sudah dihapus admin (total chat dihapus), otomatis kembali ke form awal
    if (!user) {
      clearPatientCookie(res);
      if (req.session) {
        delete req.session.patientRoomId;
        delete req.session.patientName;
        delete req.session.patientRumahSakit;
        delete req.session.patientToken;
      }
      return res.redirect("/");
    }

    // Jika sesi pasien belum tersinkron tapi token cookie cocok
    const token = getCookie(req, "dinkes_patient_token");
    if (token && user.patient_token && user.patient_token === token) {
      if (!req.session.patientRoomId || req.session.patientRoomId !== roomId) {
        req.session.patientRoomId = roomId;
        req.session.patientName = user.nama;
        req.session.patientRumahSakit = rumahSakit;
        req.session.patientToken = token;
      }
    }

    // Pastikan cookie tetap diset jika sesi pasien sah
    if (user.patient_token && (!token || token !== user.patient_token) && req.session.patientRoomId === roomId) {
      setPatientCookie(res, user.patient_token);
    }

    // Hanya pemilik room (identitas pasien dari session) yang boleh membuka chat
    const id = sessionIdentity(req);
    if (!id || id.type !== "patient" || id.roomId !== roomId) {
      return res.redirect("/");
    }

    const messages = await fetchRoomMessages(roomId, id.name, 200);

    res.render("chat", {
      roomId,
      userName: user.nama,
      alamat: user.alamat,
      nomorWa: user.nomor_wa,
      rumahSakit,
      messages,
    });
  } catch (err) {
    console.error("Error load chat:", err.message);
    res.status(500).send("Gagal memuat chat.");
  }
});

// =============================================
// ROUTE: Admin - Login
// =============================================
app.get("/admin/login", (req, res) => {
  let info = null;
  if (req.query.activated === "1")
    info = "Akun berhasil diaktivasi. Silakan login dengan email dan password baru Anda.";
  else if (req.query.reset === "1")
    info = "Password berhasil direset. Silakan login kembali.";
  res.render("admin-login", { error: null, info });
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Terlalu banyak percobaan login. Coba lagi nanti." },
  ...makeStoreOpts(),
});

// Limiter per-akun (berdasarkan email) selain limiter per-IP di atas.
const loginAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Terlalu banyak percobaan login. Coba lagi nanti." },
  keyGenerator: (req) => {
    const email = String((req.body && req.body.email) || "").trim().toLowerCase();
    return "acct:" + (email || ipKeyGenerator(req.ip));
  },
  ...makeStoreOpts(),
});

// Jeda progresif pada login gagal (per akun/IP) untuk memperlambat brute-force.
const loginFailures = new Map(); // key -> { count, at }
function loginFailDelay(key) {
  const rec = loginFailures.get(key);
  if (!rec) return 0;
  if (Date.now() - rec.at > 15 * 60 * 1000) {
    loginFailures.delete(key);
    return 0;
  }
  return Math.min(rec.count * 300, 3000);
}
function noteLoginFailure(key) {
  const rec = loginFailures.get(key) || { count: 0, at: 0 };
  rec.count += 1;
  rec.at = Date.now();
  loginFailures.set(key, rec);
}
const GENERIC_LOGIN_ERROR = "Email atau password salah!";

app.post("/admin/login", loginLimiter, loginAccountLimiter, async (req, res) => {
  const email = String((req.body && req.body.email) || "").trim().toLowerCase();
  const password = String((req.body && req.body.password) || "");
  const failKey = email || req.ip || "";

  // Jeda progresif sebelum memproses (menghambat percobaan beruntun).
  const wait = loginFailDelay(failKey);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));

  if (!email || !password) {
    noteLoginFailure(failKey);
    return res.status(200).render("admin-login", { error: GENERIC_LOGIN_ERROR });
  }

  try {
    const result = await db.query(
      "SELECT * FROM admins WHERE LOWER(email) = $1",
      [email],
    );
    const admin = result.rows[0];
    // Akun tak ada / belum aktivasi (is_active=false) / belum punya password
    // -> semua diberi pesan generik yang sama (anti-enumerasi).
    if (!admin || !admin.is_active || !admin.password) {
      noteLoginFailure(failKey);
      return res.status(200).render("admin-login", { error: GENERIC_LOGIN_ERROR });
    }

    const stored = String(admin.password || "");
    const isHashed =
      stored.startsWith("$2a$") || stored.startsWith("$2b$") || stored.startsWith("$2y$");
    if (!isHashed) {
      // Tidak menerima password plaintext di jalur login.
      console.warn(`Admin ${admin.username} punya password non-hash; login ditolak.`);
      noteLoginFailure(failKey);
      return res.status(200).render("admin-login", { error: GENERIC_LOGIN_ERROR });
    }

    const pwOk = bcrypt.compareSync(password, stored);
    if (!pwOk) {
      noteLoginFailure(failKey);
      return res.status(200).render("admin-login", { error: GENERIC_LOGIN_ERROR });
    }

    // Login sukses -> regenerasi sesi. Jika gagal, BATALKAN login
    // (jangan memberikan hak admin).
    req.session.regenerate((err) => {
      if (err) {
        console.error("Error regenerate session login:", err.message);
        return res
          .status(500)
          .render("admin-login", { error: "Gagal memulai sesi. Coba lagi." });
      }
      loginFailures.delete(failKey);
      req.session.isAdmin = true;
      req.session.adminId = admin.id;
      req.session.adminUser = admin.username;
      req.session.adminRumahSakit = admin.rumah_sakit;
      req.session.adminSessionVersion = admin.session_version;
      req.session.csrfToken = crypto.randomBytes(16).toString("hex");
      res.redirect("/admin");
    });
  } catch (err) {
    console.error("Error login:", err.message);
    res.status(500).render("admin-login", { error: "Terjadi kesalahan server." });
  }
});

// =============================================
// ROUTE: Aktivasi admin, ganti password, lupa/reset password (Fase 3-4)
// =============================================
const activateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Terlalu banyak percobaan. Coba lagi nanti." },
  ...makeStoreOpts(),
});
const forgotLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Terlalu banyak permintaan. Coba lagi nanti." },
  ...makeStoreOpts(),
});
const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Terlalu banyak percobaan. Coba lagi nanti." },
  ...makeStoreOpts(),
});
const changePwLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Terlalu banyak percobaan. Coba lagi nanti." },
  ...makeStoreOpts(),
});

const INVALID_LINK = {
  title: "Tautan tidak valid",
  message:
    "Tautan ini tidak valid, sudah dipakai, atau sudah kedaluwarsa. " +
    "Minta tautan baru kepada penanggung jawab akun.",
  loginHref: "/admin/login",
  loginText: "Ke Halaman Login",
};

// ---- Aktivasi (set password pertama kali) ----
app.get("/admin/activate", noStore, async (req, res) => {
  const token = String(req.query.token || "");
  try {
    const row = await findValidToken(token, "activation");
    const admin = row ? await getAdminById(row.admin_id) : null;
    if (!admin) return res.status(400).render("admin-message", INVALID_LINK);
    res.render("admin-activate", {
      error: null,
      token,
      email: admin.email,
      rumahSakit: admin.rumah_sakit,
    });
  } catch (err) {
    console.error("Error activate GET:", err.message);
    res.status(500).render("admin-message", {
      title: "Terjadi kesalahan",
      message: "Coba lagi nanti.",
      loginHref: "/admin/login",
      loginText: "Ke Halaman Login",
    });
  }
});

app.post("/admin/activate", activateLimiter, noStore, async (req, res) => {
  const token = String((req.body && req.body.token) || "");
  const pw = String((req.body && req.body.password) || "");
  const pw2 = String((req.body && req.body.password2) || "");
  try {
    const row = await findValidToken(token, "activation");
    const admin = row ? await getAdminById(row.admin_id) : null;
    if (!admin) return res.status(400).render("admin-message", INVALID_LINK);

    const renderForm = (error) =>
      res.status(200).render("admin-activate", {
        error,
        token,
        email: admin.email,
        rumahSakit: admin.rumah_sakit,
      });

    if (pw !== pw2) return renderForm("Konfirmasi password tidak sama.");
    const perr = validatePasswordPolicy(pw, {
      email: admin.email,
      username: admin.username,
    });
    if (perr) return renderForm(perr);

    if (!(await consumeToken(row.id)))
      return res.status(400).render("admin-message", INVALID_LINK);

    const hash = await bcrypt.hash(pw, BCRYPT_ROUNDS);
    await db.query(
      `UPDATE admins
          SET password = $1, is_active = TRUE, password_changed_at = NOW(),
              session_version = session_version + 1
        WHERE id = $2`,
      [hash, admin.id],
    );
    await db.query(
      "UPDATE admin_tokens SET used_at = NOW() WHERE admin_id = $1 AND used_at IS NULL",
      [admin.id],
    );
    res.redirect("/admin/login?activated=1");
  } catch (err) {
    console.error("Error activate POST:", err.message);
    res.status(500).render("admin-message", {
      title: "Terjadi kesalahan",
      message: "Coba lagi nanti.",
      loginHref: "/admin/login",
      loginText: "Ke Halaman Login",
    });
  }
});

// ---- Lupa password: kirim PASSWORD BARU ke email terdaftar ----
// (respons selalu sama -> anti-enumerasi)
const FORGOT_INFO = "Jika alamat terdaftar, password baru akan dikirim ke email tersebut.";

app.get("/admin/forgot-password", noStore, (req, res) => {
  res.render("admin-forgot", { info: null });
});

app.post("/admin/forgot-password", forgotLimiter, noStore, async (req, res) => {
  const email = String((req.body && req.body.email) || "").trim().toLowerCase();
  try {
    if (email) {
      const r = await db.query(
        "SELECT * FROM admins WHERE LOWER(email) = $1 AND is_active = TRUE",
        [email],
      );
      const admin = r.rows[0];
      if (admin) {
        const newPassword = generateStrongPassword(16);
        const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
        await db.query(
          `UPDATE admins
              SET password = $1, password_changed_at = NOW(),
                  session_version = session_version + 1
            WHERE id = $2`,
          [hash, admin.id],
        );
        const out = await mailer.sendNewPasswordEmail(admin.email, newPassword);
        if (out.skipped && !IS_PRODUCTION)
          console.log(`[DEV] Password baru untuk ${admin.email}: ${newPassword}`);
        if (out.error) console.error(`Gagal kirim password baru ke ${admin.email}:`, out.error);
      }
    }
  } catch (err) {
    console.error("Error forgot-password:", err.message);
  }
  res.status(200).render("admin-forgot", { info: FORGOT_INFO });
});

app.get("/admin/reset-password", noStore, async (req, res) => {
  const token = String(req.query.token || "");
  try {
    const row = await findValidToken(token, "reset");
    if (!row) return res.status(400).render("admin-message", INVALID_LINK);
    res.render("admin-reset", { error: null, token });
  } catch (err) {
    console.error("Error reset GET:", err.message);
    res.status(500).render("admin-message", {
      title: "Terjadi kesalahan",
      message: "Coba lagi nanti.",
      loginHref: "/admin/login",
      loginText: "Ke Halaman Login",
    });
  }
});

app.post("/admin/reset-password", resetLimiter, noStore, async (req, res) => {
  const token = String((req.body && req.body.token) || "");
  const pw = String((req.body && req.body.password) || "");
  const pw2 = String((req.body && req.body.password2) || "");
  try {
    const row = await findValidToken(token, "reset");
    const admin = row ? await getAdminById(row.admin_id) : null;
    if (!admin) return res.status(400).render("admin-message", INVALID_LINK);

    const renderForm = (error) =>
      res.status(200).render("admin-reset", { error, token });

    if (pw !== pw2) return renderForm("Konfirmasi password tidak sama.");
    const perr = validatePasswordPolicy(pw, {
      email: admin.email,
      username: admin.username,
    });
    if (perr) return renderForm(perr);

    if (!(await consumeToken(row.id)))
      return res.status(400).render("admin-message", INVALID_LINK);

    const hash = await bcrypt.hash(pw, BCRYPT_ROUNDS);
    await db.query(
      `UPDATE admins
          SET password = $1, password_changed_at = NOW(),
              session_version = session_version + 1
        WHERE id = $2`,
      [hash, admin.id],
    );
    await db.query(
      "UPDATE admin_tokens SET used_at = NOW() WHERE admin_id = $1 AND used_at IS NULL",
      [admin.id],
    );
    mailer.sendPasswordChangedEmail(admin.email).catch(() => {});
    res.redirect("/admin/login?reset=1");
  } catch (err) {
    console.error("Error reset POST:", err.message);
    res.status(500).render("admin-message", {
      title: "Terjadi kesalahan",
      message: "Coba lagi nanti.",
      loginHref: "/admin/login",
      loginText: "Ke Halaman Login",
    });
  }
});

// ---- Ganti password (butuh login) ----
app.get("/admin/change-password", requireAdmin, noStore, (req, res) => {
  res.render("admin-change-password", { error: null, done: false });
});

app.post(
  "/admin/change-password",
  requireAdmin,
  changePwLimiter,
  noStore,
  async (req, res) => {
    const current = String((req.body && req.body.current) || "");
    const pw = String((req.body && req.body.password) || "");
    const pw2 = String((req.body && req.body.password2) || "");
    try {
      const admin = await getAdminById(req.session.adminId);
      if (!admin || !admin.is_active || !admin.password) {
        return res.redirect("/admin/login");
      }
      const renderForm = (error) =>
        res.status(200).render("admin-change-password", { error, done: false });

      if (!bcrypt.compareSync(current, String(admin.password)))
        return renderForm("Password saat ini salah.");
      if (pw !== pw2) return renderForm("Konfirmasi password tidak sama.");
      const perr = validatePasswordPolicy(pw, {
        email: admin.email,
        username: admin.username,
      });
      if (perr) return renderForm(perr);
      if (bcrypt.compareSync(pw, String(admin.password)))
        return renderForm("Password baru tidak boleh sama dengan yang lama.");

      const hash = await bcrypt.hash(pw, BCRYPT_ROUNDS);
      const upd = await db.query(
        `UPDATE admins
            SET password = $1, password_changed_at = NOW(),
                session_version = session_version + 1
          WHERE id = $2 RETURNING session_version`,
        [hash, admin.id],
      );
      // Sesi ini tetap hidup; sesi lain otomatis dicabut (versi berbeda).
      req.session.adminSessionVersion = upd.rows[0].session_version;
      mailer.sendPasswordChangedEmail(admin.email).catch(() => {});
      res.status(200).render("admin-change-password", { error: null, done: true });
    } catch (err) {
      console.error("Error change-password:", err.message);
      res
        .status(500)
        .render("admin-change-password", { error: "Terjadi kesalahan server.", done: false });
    }
  },
);

app.get("/admin/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/admin/login");
});

// =============================================
// HELPER: Daftar room (pasien) satu rumah sakit, terurut untuk sidebar admin.
// Urutan: room yang disematkan (pin) selalu di atas, lalu berdasarkan
// aktivitas terakhir menurun (pesan terbaru; jika belum ada pesan, waktu
// pendaftaran pasien) sehingga room dengan aktivitas terbaru muncul di paling atas.
// =============================================
async function fetchAdminRooms(rumahSakit) {
  const usersResult = await db.query(
    "SELECT * FROM patients WHERE rumah_sakit = $1",
    [rumahSakit],
  );
  const rooms = [];
  for (const user of usersResult.rows) {
    const room_id = `${user.rumah_sakit}_${user.id}`;
    const msgCount = await db.query(
      "SELECT COUNT(*) as total FROM messages WHERE room_id = $1",
      [room_id],
    );
    const lastMsg = await db.query(
      "SELECT id, room_id, sender_name, message, message_type, file_name, file_mime, file_size, created_at FROM messages WHERE room_id = $1 ORDER BY created_at DESC LIMIT 1",
      [room_id],
    );
    const lastMessage = lastMsg.rows.length > 0 ? lastMsg.rows[0] : null;
    rooms.push({
      id: user.id,
      nama: user.nama,
      alamat: user.alamat,
      nomor_wa: user.nomor_wa,
      rumah_sakit: user.rumah_sakit,
      roomId: room_id,
      isPinned: !!user.is_pinned,
      totalPesan: parseInt(msgCount.rows[0].total),
      lastMessage,
      // Waktu aktivitas terakhir: pesan terbaru, atau waktu pendaftaran pasien.
      lastActivity: new Date(
        lastMessage ? lastMessage.created_at : user.created_at,
      ).getTime(),
    });
  }
  rooms.sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    return b.lastActivity - a.lastActivity;
  });
  return rooms;
}

// =============================================
// ROUTE: Admin - Dashboard (filtered by hospital)
// =============================================
app.get("/admin", requireAdmin, async (req, res) => {
  try {
    const rumahSakit = req.session.adminRumahSakit;
    const rooms = await fetchAdminRooms(rumahSakit);

    // Jumlah pesan belum dibaca per room untuk admin ini
    const unreadRes = await db.query(
      "SELECT room_id, unread_count FROM room_unread WHERE admin_name = $1 AND unread_count > 0",
      [req.session.adminUser],
    );
    const unreadMap = new Map(
      unreadRes.rows.map((r) => [r.room_id, Number(r.unread_count)]),
    );
    for (const room of rooms) {
      room.unread = unreadMap.get(room.roomId) || 0;
    }

    res.render("admin", {
      rooms,
      adminUser: req.session.adminUser,
      adminRumahSakit: rumahSakit,
    });
  } catch (err) {
    console.error("Error admin dashboard:", err.message);
    res.status(500).send("Gagal memuat dashboard.");
  }
});

// =============================================
// ROUTE: Admin - Lihat Chat Room (hospital-scoped)
// =============================================
app.get("/admin/room/:patientId", requireAdmin, async (req, res) => {
  const patientId = parseInt(req.params.patientId, 10);
  const rumahSakit = req.session.adminRumahSakit;
  try {
    const userResult = await db.query("SELECT * FROM patients WHERE id = $1", [
      patientId,
    ]);
    const user = userResult.rows[0];

    if (!user) {
      return res.status(404).send("Pasien tidak ditemukan.");
    }

    if (user.rumah_sakit !== rumahSakit) {
      return res
        .status(403)
        .send("Akses ditolak: Room ini bukan milik rumah sakit Anda.");
    }

    const roomId = `${user.rumah_sakit}_${user.id}`;

    const messages = await fetchRoomMessages(roomId, req.session.adminUser, 0);

    // Admin membuka room -> reset unread
    markRoomRead(roomId, req.session.adminUser);

    res.render("admin-room", {
      roomId,
      user,
      messages,
      adminUser: req.session.adminUser,
      adminRumahSakit: rumahSakit,
    });
  } catch (err) {
    console.error("Error admin room:", err.message);
    res.status(500).send("Gagal memuat room.");
  }
});

// =============================================
// ROUTE: Admin - Detail Data Pasien (hospital-scoped)
// =============================================
app.get("/admin/patient/:patientId", requireAdmin, async (req, res) => {
  const patientId = parseInt(req.params.patientId, 10);
  const rumahSakit = req.session.adminRumahSakit;
  try {
    const userResult = await db.query("SELECT * FROM patients WHERE id = $1", [
      patientId,
    ]);
    const user = userResult.rows[0];

    if (!user) {
      return res.status(404).send("Pasien tidak ditemukan.");
    }

    if (user.rumah_sakit !== rumahSakit) {
      return res
        .status(403)
        .send("Akses ditolak: Data ini bukan milik rumah sakit Anda.");
    }

    res.render("admin-patient", {
      user,
      adminUser: req.session.adminUser,
      adminRumahSakit: rumahSakit,
    });
  } catch (err) {
    console.error("Error admin patient detail:", err.message);
    res.status(500).send("Gagal memuat data pasien.");
  }
});

// =============================================
// ROUTE: Admin - Hapus Total Chat Pasien (pasien + semua pesan)
// =============================================
app.post("/admin/patient/delete", requireAdmin, async (req, res) => {
  const { patientId } = req.body;
  const rumahSakit = req.session.adminRumahSakit;
  try {
    await deletePatientFully(parseInt(patientId, 10), rumahSakit);
    res.redirect("/admin");
  } catch (err) {
    console.error("Error hapus total chat:", err.message);
    res.redirect("/admin");
  }
});

// =============================================
// API: Sematkan / lepas semat room (batch, hospital-scoped)
// =============================================
app.post("/api/room/pin", requireAdmin, async (req, res) => {
  const rumahSakit = req.session.adminRumahSakit;
  const { ids, pinned } = req.body || {};
  const list = (Array.isArray(ids) ? ids : [])
    .map((v) => parseInt(v, 10))
    .filter((v) => Number.isInteger(v) && v > 0);
  if (list.length === 0) {
    return res.status(400).json({ error: "Data tidak lengkap." });
  }
  try {
    const result = await db.query(
      "UPDATE patients SET is_pinned = $1 WHERE id = ANY($2::int[]) AND rumah_sakit = $3",
      [!!pinned, list, rumahSakit],
    );
    res.json({ ok: true, updated: result.rowCount || 0 });
  } catch (err) {
    console.error("Error sematkan room:", err.message);
    res.status(500).json({ error: "Terjadi kesalahan server." });
  }
});

// =============================================
// API: Hapus total chat room (batch, hospital-scoped)
// =============================================
app.post("/api/room/delete", requireAdmin, async (req, res) => {
  const rumahSakit = req.session.adminRumahSakit;
  const { ids } = req.body || {};
  const list = (Array.isArray(ids) ? ids : [])
    .map((v) => parseInt(v, 10))
    .filter((v) => Number.isInteger(v) && v > 0);
  if (list.length === 0) {
    return res.status(400).json({ error: "Data tidak lengkap." });
  }
  const deletedIds = [];
  try {
    for (const id of list) {
      const r = await deletePatientFully(id, rumahSakit);
      if (r.ok) deletedIds.push(id);
    }
    res.json({ ok: true, deletedIds });
  } catch (err) {
    console.error("Error hapus total chat room:", err.message);
    res.status(500).json({ error: "Terjadi kesalahan server." });
  }
});

// =============================================
// API: Ambil pesan per room (untuk auto-refresh)
// =============================================
app.get("/api/messages/:roomId", async (req, res) => {
  const roomId = req.params.roomId;
  const id = sessionIdentity(req);
  if (!id || !identityCanAccessRoom(id, roomId)) {
    return res.status(403).json({ error: "Akses ditolak." });
  }
  const viewer = id.name;
  const after = req.query.after ? parseInt(req.query.after, 10) : null;
  try {
    let query = `SELECT ${MSG_COLS} FROM messages
                 WHERE room_id = $1
                   AND NOT EXISTS (
                     SELECT 1 FROM message_visibility mv
                     WHERE mv.message_id = messages.id AND mv.user_name = $2
                   )`;
    const params = [roomId, viewer];
    if (after) {
      query += " AND id > $3";
      params.push(after);
    }
    query += " ORDER BY created_at ASC";
    if (!after) query += " LIMIT 200";
    const result = await db.query(query, params);
    const enriched = await attachReplyInfo(result.rows);
    res.json({ messages: enriched });
  } catch (err) {
    console.error("Error /api/messages:", err.message);
    res.status(500).json({ error: "Terjadi kesalahan server." });
  }
});

// =============================================
// API: Cek apakah pasien (room) masih ada (untuk resume chat)
// =============================================
app.get("/api/patient-exists/:roomId", async (req, res) => {
  const roomId = req.params.roomId;
  try {
    const lastUnderscore = roomId.lastIndexOf("_");
    const userId =
      lastUnderscore > -1 ? roomId.substring(lastUnderscore + 1) : roomId;
    if (!/^\d+$/.test(userId)) return res.json({ exists: false });

    const result = await db.query(
      "SELECT id, nama, rumah_sakit, patient_token FROM patients WHERE id = $1",
      [userId],
    );
    if (result.rows.length === 0) {
      clearPatientCookie(res);
      if (req.session) {
        delete req.session.patientRoomId;
        delete req.session.patientName;
        delete req.session.patientRumahSakit;
        delete req.session.patientToken;
      }
      return res.json({ exists: false });
    }

    const patient = result.rows[0];
    const expectedRoomId = `${patient.rumah_sakit}_${patient.id}`;
    if (expectedRoomId !== roomId) {
      return res.json({ exists: false });
    }

    const id = sessionIdentity(req);
    const token = getCookie(req, "dinkes_patient_token");
    const isOwnerByToken = Boolean(
      token && patient.patient_token && token === patient.patient_token,
    );
    const isOwnerBySession = Boolean(
      id && id.type === "patient" && id.roomId === roomId,
    );
    const isAdmin = Boolean(
      id && id.type === "admin" && id.rumahSakit === patient.rumah_sakit,
    );

    if (!isOwnerByToken && !isOwnerBySession && !isAdmin) {
      return res.json({ exists: false });
    }

    // Pulihkan sesi jika token cocok tapi sesi belum tersimpan di session server
    if (isOwnerByToken && (!req.session || !req.session.patientRoomId)) {
      req.session.patientRoomId = roomId;
      req.session.patientName = patient.nama;
      req.session.patientRumahSakit = patient.rumah_sakit;
      req.session.patientToken = token;
    }

    res.json({ exists: true, userName: patient.nama, roomId });
  } catch (err) {
    console.error("Error /api/patient-exists:", err.message);
    res.status(500).json({ error: "Terjadi kesalahan server." });
  }
});

// =============================================
// API: Upload Lampiran (foto / video / dokumen)
// Data dikirim sebagai base64, tersimpan di DB
// =============================================
app.post("/api/upload", uploadLimiter, async (req, res) => {
  const { roomId, mime, name, data, replyTo } = req.body || {};
  const id = sessionIdentity(req);
  if (!id || !identityCanAccessRoom(id, roomId)) {
    return res.status(403).json({ error: "Akses ditolak." });
  }
  try {
    if (!roomId || !name || !data || !/^data:.*;base64,/.test(data)) {
      return res.status(400).json({ error: "Data lampiran tidak lengkap." });
    }

    // Validasi pasien (room) masih ada
    const lastUnderscore = roomId.lastIndexOf("_");
    const userId =
      lastUnderscore > -1 ? roomId.substring(lastUnderscore + 1) : roomId;
    if (!/^\d+$/.test(userId))
      return res.status(400).json({ error: "Room tidak valid." });
    const patientCheck = await db.query(
      "SELECT id FROM patients WHERE id = $1",
      [userId],
    );
    if (patientCheck.rows.length === 0) {
      return res.status(404).json({ error: "Pasien tidak ditemukan." });
    }

    const base64 = data.split(",")[1];
    if (!base64) return res.status(400).json({ error: "Data kosong." });

    // Batas ukuran (base64 ~45MB agar hasil file tidak lebih dari ~34MB)
    const MAX_BASE64 = 45 * 1024 * 1024;
    if (base64.length > MAX_BASE64) {
      return res.status(413).json({ error: "File terlalu besar." });
    }

    // Validasi tipe dari isi byte (magic bytes), bukan dari MIME yang dikirim client
    const buf = Buffer.from(base64, "base64");
    if (!buf.length) return res.status(400).json({ error: "Data kosong." });
    const sniffed = sniffUpload(buf);
    if (!sniffed) {
      return res.status(415).json({ error: "Jenis file tidak diizinkan." });
    }
    let storedMime;
    if (sniffed.kind === "media") {
      storedMime = sniffed.mime;
    } else {
      const clientMime = String(mime || "").toLowerCase();
      storedMime = DOC_MIME_ALLOW.has(clientMime)
        ? clientMime
        : "application/octet-stream";
    }

    let storedReplyTo = null;
    if (
      replyTo != null &&
      Number.isInteger(Number(replyTo)) &&
      Number(replyTo) > 0
    ) {
      storedReplyTo = Number(replyTo);
      const chk = await db.query(
        "SELECT id FROM messages WHERE id = $1 AND room_id = $2",
        [storedReplyTo, roomId],
      );
      if (!chk.rows.length) storedReplyTo = null;
    }
    const senderName = id.name;

    const result = await db.query(
      "INSERT INTO messages (room_id, sender_name, message, message_type, file_name, file_mime, file_data, file_size, reply_to) VALUES ($1, $2, $3, 'file', $4, $5, $6, $7, $8) RETURNING *",
      [
        roomId,
        senderName,
        name,
        name,
        storedMime,
        base64,
        buf.length,
        storedReplyTo,
      ],
    );
    const [m] = await attachReplyInfo([result.rows[0]]);

    io.to(roomId).emit("room-message", {
      id: m.id,
      room_id: m.room_id,
      sender_name: m.sender_name,
      message: m.message,
      message_type: m.message_type,
      file_name: m.file_name,
      file_mime: m.file_mime,
      file_size: m.file_size,
      created_at: m.created_at,
      reply_to: m.reply_to,
      reply: m.reply,
    });

    bumpUnread(roomId);

    res.json({ ok: true, id: m.id });
  } catch (err) {
    console.error("Gagal simpan lampiran:", err.message);
    res.status(500).json({ error: "Terjadi kesalahan server." });
  }
});

// =============================================
// API: Hapus pesan (Hapus untuk Semua / Hapus untuk Saya)
// Dipakai dari tampilan pasien & admin (via konfirmasi hapus)
// =============================================
app.post("/api/message/delete", async (req, res) => {
  const { roomId, messageIds, mode } = req.body || {};
  const id = sessionIdentity(req);
  if (!id || !identityCanAccessRoom(id, roomId)) {
    return res.status(403).json({ error: "Akses ditolak." });
  }
  const viewerName = id.name;
  const ids = (Array.isArray(messageIds) ? messageIds : [])
    .map((v) => parseInt(v, 10))
    .filter((v) => Number.isInteger(v) && v > 0);
  if (!roomId || !viewerName || ids.length === 0) {
    return res.status(400).json({ error: "Data tidak lengkap." });
  }
  if (mode !== "all" && mode !== "me") {
    return res.status(400).json({ error: "Mode tidak valid." });
  }
  try {
    if (mode === "all") {
      // Hanya pesan sendiri yang berusia < 2 menit boleh dihapus untuk semua orang
      const ageRes = await db.query(
        `SELECT id, sender_name, EXTRACT(EPOCH FROM (NOW() - created_at)) AS age
         FROM messages WHERE id = ANY($1::int[]) AND room_id = $2`,
        [ids, roomId],
      );
      const eligible = ageRes.rows
        .filter(
          (r) =>
            Number(r.age) <= DELETE_ALL_WINDOW_SECS &&
            r.sender_name === viewerName,
        )
        .map((r) => r.id);
      if (eligible.length) {
        await db.query("DELETE FROM messages WHERE id = ANY($1::int[])", [
          eligible,
        ]);
      }
      const skipped = ids.filter((id) => eligible.indexOf(id) === -1);
      io.to(roomId).emit("messages-deleted", {
        ids: eligible,
        scope: "all",
        by: viewerName,
        room_id: roomId,
      });
      return res.json({ ok: true, deletedIds: eligible, skipped });
    }

    // mode 'me': sembunyikan hanya dari tampilan viewer ini
    await db.query(
      `INSERT INTO message_visibility (message_id, user_name, room_id)
       SELECT m.id, v.user_name, m.room_id
       FROM messages m
       JOIN UNNEST($1::int[], $2::text[]) AS v(message_id, user_name) ON m.id = v.message_id
       WHERE m.room_id = $3
       ON CONFLICT (message_id, user_name) DO NOTHING`,
      [ids, ids.map(() => viewerName), roomId],
    );
    io.to(roomId).emit("messages-deleted", {
      ids,
      scope: "me",
      by: viewerName,
      room_id: roomId,
    });
    return res.json({ ok: true, deletedIds: ids });
  } catch (err) {
    console.error("Error hapus pesan:", err.message);
    res.status(500).json({ error: "Terjadi kesalahan server." });
  }
});

// =============================================
// API: Ambil file lampiran (foto / video / dokumen)
// =============================================
app.get("/api/file/:id", async (req, res) => {
  try {
    const result = await db.query(
      "SELECT id, room_id, file_data, file_mime, file_name FROM messages WHERE id = $1 AND message_type = 'file'",
      [req.params.id],
    );
    const row = result.rows[0];
    if (!row || !row.file_data)
      return res.status(404).send("File tidak ditemukan.");

    // Hanya pemilik room / admin RS yang bisa mengambil file
    const id = sessionIdentity(req);
    if (!id || !identityCanAccessRoom(id, row.room_id)) {
      return res.status(403).send("Akses ditolak.");
    }

    const buf = Buffer.from(row.file_data, "base64");
    const safeName = (row.file_name || "file")
      .replace(/[\\"';&\r\n]/g, "")
      .replace(/[\u0000-\u001F\u007F]/g, "");
    const mime = String(row.file_mime || "application/octet-stream");
    const isMedia = mime.indexOf("image/") === 0 || mime.indexOf("video/") === 0;
    res.set("Content-Type", mime);
    res.set("X-Content-Type-Options", "nosniff");
    res.set(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; media-src 'self'",
    );
    res.set(
      "Content-Disposition",
      `${isMedia ? "inline" : "attachment"}; filename="${safeName}"`,
    );
    res.set("Cache-Control", "private, max-age=86400");
    res.send(buf);
  } catch (err) {
    console.error("Error /api/file:", err.message);
    res.status(500).send("Gagal memuat file.");
  }
});

// =============================================
// API: Daftar room per rumah sakit (untuk admin sidebar)
// =============================================
app.get("/api/rooms", requireAdmin, async (req, res) => {
  try {
    const rumahSakit = req.session.adminRumahSakit;
    const rooms = await fetchAdminRooms(rumahSakit);
    const unreadRes = await db.query(
      "SELECT room_id, unread_count FROM room_unread WHERE admin_name = $1 AND unread_count > 0",
      [req.session.adminUser],
    );
    const unreadMap = new Map(
      unreadRes.rows.map((r) => [r.room_id, Number(r.unread_count)]),
    );
    for (const room of rooms) {
      room.unread = unreadMap.get(room.roomId) || 0;
    }
    res.json({ rooms });
  } catch (err) {
    console.error("Error /api/rooms:", err.message);
    res.status(500).json({ error: "Terjadi kesalahan server." });
  }
});

// =============================================
// API: Web Push - kunci publik & subscription (terotorisasi)
// =============================================
const pushLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Terlalu banyak permintaan. Coba lagi nanti." },
  ...makeStoreOpts(),
});

app.get("/api/push/public-key", (req, res) => {
  if (!push.isEnabled()) {
    return res.status(503).json({ error: "Notifikasi push tidak tersedia." });
  }
  res.json({ publicKey: push.getPublicKey() });
});

app.post("/api/push/subscribe", pushLimiter, async (req, res) => {
  const owner = pushOwnerFromSession(req);
  if (!owner) return res.status(401).json({ error: "Tidak terautentikasi." });
  if (!push.isEnabled()) {
    return res.status(503).json({ error: "Notifikasi push tidak tersedia." });
  }
  const sub = parsePushSubscription(req.body);
  if (!sub) return res.status(400).json({ error: "Data subscription tidak valid." });
  try {
    await db.query(
      `INSERT INTO push_subscriptions
         (endpoint, p256dh, auth, owner_type, owner_id, rumah_sakit, room_id, revoked_at, last_used_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,NULL)
       ON CONFLICT (endpoint) DO UPDATE SET
         p256dh = EXCLUDED.p256dh,
         auth = EXCLUDED.auth,
         owner_type = EXCLUDED.owner_type,
         owner_id = EXCLUDED.owner_id,
         rumah_sakit = EXCLUDED.rumah_sakit,
         room_id = EXCLUDED.room_id,
         revoked_at = NULL,
         last_used_at = NULL`,
      [
        sub.endpoint,
        sub.p256dh,
        sub.auth,
        owner.owner_type,
        owner.owner_id,
        owner.rumah_sakit,
        owner.room_id,
      ],
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Error POST /api/push/subscribe:", err.message);
    res.status(500).json({ error: "Terjadi kesalahan server." });
  }
});

app.delete("/api/push/subscribe", pushLimiter, async (req, res) => {
  const owner = pushOwnerFromSession(req);
  if (!owner) return res.status(401).json({ error: "Tidak terautentikasi." });
  const endpoint = req.body && req.body.endpoint;
  if (
    typeof endpoint !== "string" ||
    endpoint.length < 12 ||
    endpoint.length > 2000
  ) {
    return res.status(400).json({ error: "Data subscription tidak valid." });
  }
  try {
    // Hanya boleh mencabut subscription milik sesi ini.
    await db.query(
      `UPDATE push_subscriptions SET revoked_at = NOW()
        WHERE endpoint = $1 AND owner_type = $2 AND owner_id = $3`,
      [endpoint, owner.owner_type, owner.owner_id],
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Error DELETE /api/push/subscribe:", err.message);
    res.status(500).json({ error: "Terjadi kesalahan server." });
  }
});

// =============================================
// NOTIFIKASI BELUM DIBACA (unread) per admin & room
// =============================================
const onlineAdmins = {}; // { roomId: Set of admin usernames yang sedang membuka (membaca) room }
const ADMIN_CHAN = (rumahSakit) => `admin-rs:${rumahSakit}`;

// Prefix rumah sakit dari roomId (format: "<rumah_sakit>_<id_pasien>")
function roomHospital(roomId) {
  const i = roomId.lastIndexOf("_");
  return i > -1 ? roomId.substring(0, i) : roomId;
}

// Tambah 1 hitung belum dibaca untuk setiap admin rumah sakit tsb
// yang sedang TIDAK membuka room (kecuali sedang dibaca).
async function bumpUnread(roomId) {
  const rumahSakit = roomHospital(roomId);
  const reading = onlineAdmins[roomId] ? Array.from(onlineAdmins[roomId]) : [];
  try {
    const res = await db.query(
      `INSERT INTO room_unread (admin_name, room_id, unread_count)
       SELECT username, $2, 1 FROM admins
       WHERE rumah_sakit = $1 AND username <> ALL($3::text[])
       ON CONFLICT (admin_name, room_id)
         DO UPDATE SET unread_count = room_unread.unread_count + 1, updated_at = NOW()
       RETURNING admin_name, unread_count`,
      [rumahSakit, roomId, reading],
    );
    for (const row of res.rows) {
      io.to(ADMIN_CHAN(rumahSakit)).emit("unread-update", {
        roomId,
        count: Number(row.unread_count),
      });
    }
  } catch (err) {
    console.error("Error bumpUnread:", err.message);
  }
}

// Reset hitung belum dibaca menjadi 0 untuk admin pada room tsb.
async function markRoomRead(roomId, adminName) {
  if (!roomId || !adminName) return;
  try {
    const res = await db.query(
      "UPDATE room_unread SET unread_count = 0, updated_at = NOW() WHERE admin_name = $1 AND room_id = $2",
      [adminName, roomId],
    );
    if (res.rowCount > 0) {
      io.to(ADMIN_CHAN(roomHospital(roomId))).emit("unread-update", {
        roomId,
        count: 0,
      });
    }
  } catch (err) {
    console.error("Error markRoomRead:", err.message);
  }
}

// Kirim Web Push setelah pesan tersimpan (best effort).
// Penerima:
//   - pesan pasien  -> admin aktif yang berwenang pada rumah sakit room tsb
//   - balasan admin -> pasien pemilik room
// Isi notifikasi generik (tanpa data pasien); tab yang terlihat ditangani SW.
async function sendPushForMessage(id, roomId, savedMsg) {
  if (!push.isEnabled()) return;
  const roomHash = crypto
    .createHash("sha1")
    .update(roomId)
    .digest("hex")
    .slice(0, 16);
  const tag = "lc-" + roomHash;
  const i = roomId.lastIndexOf("_");
  const patientId = i > -1 ? roomId.slice(i + 1) : "";

  if (id.type === "patient") {
    const subs = await push.getHospitalAdminSubscriptions(
      db,
      roomHospital(roomId),
    );
    if (!subs.length) return;
    await push.sendToSubscriptions(db, subs, {
      title: "Live Chat",
      body: "Ada pesan baru di Live Chat",
      url: "/admin/room/" + encodeURIComponent(patientId),
      tag,
    });
  } else if (id.type === "admin") {
    if (!/^\d+$/.test(patientId)) return;
    const subs = await push.getPatientSubscriptions(db, Number(patientId));
    if (!subs.length) return;
    await push.sendToSubscriptions(db, subs, {
      title: "Live Chat",
      body: "Ada pesan baru di Live Chat",
      url: "/chat/" + encodeURIComponent(roomId),
      tag,
    });
  }
}

// =============================================
// SOCKET.IO: Room-based Realtime Chat (hospital-scoped)
// =============================================
const onlineUsers = {}; // { roomId: Set of socket ids }

// Identitas dari session (disuntikkan express-session ke handshake socket)
function socketIdentity(socket) {
  const s = socket.request && socket.request.session;
  if (!s) return null;
  if (s.isAdmin && s.adminUser) {
    return { type: "admin", name: s.adminUser, rumahSakit: s.adminRumahSakit };
  }
  if (s.patientRoomId) {
    return {
      type: "patient",
      roomId: s.patientRoomId,
      name: s.patientName,
      rumahSakit: s.patientRumahSakit,
    };
  }
  return null;
}

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  // Throttle pengiriman pesan per-socket (anti-spam realtime).
  // Maks 10 pesan / detik (burst) dan maks 60 pesan / 10 detik (berkelanjutan).
  let msgBurst = [];
  let msgSustained = [];
  function messageAllowed() {
    const now = Date.now();
    msgBurst = msgBurst.filter((t) => now - t < 1000);
    msgSustained = msgSustained.filter((t) => now - t < 10000);
    if (msgBurst.length >= 10 || msgSustained.length >= 60) return false;
    msgBurst.push(now);
    msgSustained.push(now);
    return true;
  }

  // Join ke room tertentu (roomId sekarang termasuk prefix rumah_sakit)
  // Dari tampilan admin, payload berupa { roomId, adminName } untuk
  // menandai admin tersebut sedang membaca room (reset unread).
  socket.on("join-room", (payload) => {
    const id = socketIdentity(socket);
    if (!id) return;

    const roomId =
      payload && typeof payload === "object" ? payload.roomId : payload;
    if (!roomId) return;

    if (id.type === "patient") {
      if (roomId !== id.roomId) return;
    } else {
      if (roomHospital(roomId) !== id.rumahSakit) return;
    }

    socket.join(roomId);
    socket.roomId = roomId;
    socket.adminName = id.type === "admin" ? id.name : null;

    if (!onlineUsers[roomId]) onlineUsers[roomId] = new Set();
    onlineUsers[roomId].add(socket.id);

    // Beri tahu semua di room jumlah user online
    io.to(roomId).emit("user-count", onlineUsers[roomId].size);
    console.log(`Socket ${socket.id} joined room ${roomId}`);

    // Admin yang membuka room: tanda sedang membaca + reset unread
    if (id.type === "admin") {
      if (!onlineAdmins[roomId]) onlineAdmins[roomId] = new Set();
      onlineAdmins[roomId].add(id.name);
      socket.join(ADMIN_CHAN(id.rumahSakit));
      markRoomRead(roomId, id.name);
    }
  });

  // Halaman daftar room admin: subscribe ke channel badge unread
  socket.on("join-admin-badges", () => {
    const id = socketIdentity(socket);
    if (!id || id.type !== "admin") return;
    socket.join(ADMIN_CHAN(id.rumahSakit));
  });

  // Kirim pesan
  socket.on("message", async (data) => {
    const id = socketIdentity(socket);
    if (!id) return;

    const { roomId, message } = data || {};
    if (!roomId || !message) return;
    if (!identityCanAccessRoom(id, roomId)) return;
    if (!messageAllowed()) return; // throttled: abaikan diam-diam

    try {
      if (id.type === "patient") {
        // Pastikan pasien masih ada (tidak dihapus admin)
        const lastUnderscore = roomId.lastIndexOf("_");
        const userId =
          lastUnderscore > -1 ? roomId.substring(lastUnderscore + 1) : roomId;
        if (!/^\d+$/.test(userId)) return;
        const patientChk = await db.query(
          "SELECT id FROM patients WHERE id = $1",
          [userId],
        );
        if (!patientChk.rows.length) return;
      }

      let replyTo = null;
      if (data.replyTo != null && Number.isInteger(Number(data.replyTo)) && Number(data.replyTo) > 0) {
        replyTo = Number(data.replyTo);
        const chk = await db.query(
          "SELECT id FROM messages WHERE id = $1 AND room_id = $2",
          [replyTo, roomId],
        );
        if (!chk.rows.length) replyTo = null;
      }

      const result = await db.query(
        "INSERT INTO messages (room_id, sender_name, message, reply_to) VALUES ($1, $2, $3, $4) RETURNING id, room_id, sender_name, message, message_type, file_name, file_mime, file_size, created_at, reply_to",
        [roomId, id.name, message, replyTo],
      );
      const [savedMsg] = await attachReplyInfo([result.rows[0]]);

      io.to(roomId).emit("room-message", {
        id: savedMsg.id,
        room_id: savedMsg.room_id,
        sender_name: savedMsg.sender_name,
        message: savedMsg.message,
        created_at: savedMsg.created_at,
        reply_to: savedMsg.reply_to,
        reply: savedMsg.reply,
      });

      bumpUnread(roomId);

      // Kabari sidebar admin (halaman daftar room) agar room ini naik ke atas
      // dan pratinjau pesan terakhir ikut diperbarui (real-time).
      io.to(ADMIN_CHAN(roomHospital(roomId))).emit("room-activity", {
        roomId,
        senderName: savedMsg.sender_name,
        message: savedMsg.message,
        messageType: savedMsg.message_type,
        createdAt: savedMsg.created_at,
      });

      // Notifikasi Web Push (best effort; setelah pesan tersimpan).
      sendPushForMessage(id, roomId, savedMsg).catch((e) =>
        console.error("Error sendPushForMessage:", e.message),
      );
    } catch (err) {
      console.error("Gagal simpan pesan:", err.message);
    }
  });

  // Disconnect
  socket.on("disconnect", () => {
    const roomId = socket.roomId;
    if (roomId && socket.adminName && onlineAdmins[roomId]) {
      onlineAdmins[roomId].delete(socket.adminName);
      if (onlineAdmins[roomId].size === 0) delete onlineAdmins[roomId];
    }
    if (roomId && onlineUsers[roomId]) {
      onlineUsers[roomId].delete(socket.id);
      io.to(roomId).emit("user-count", onlineUsers[roomId].size);
      if (onlineUsers[roomId].size === 0) delete onlineUsers[roomId];
    }
    console.log("Socket disconnected:", socket.id);
  });
});

// =============================================
// JALANKAN SERVER
// =============================================
const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
});
