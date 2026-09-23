require("dotenv").config({ override: true }); // Load .env file, override existing env vars
const express = require("express");
const { Pool } = require("pg");
const BodyParser = require("body-parser");
const session = require("express-session");

const app = express();
const http = require("http");
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

app.use(BodyParser.urlencoded({ extended: true, limit: "50mb" }));
app.use(BodyParser.json({ limit: "50mb" }));
app.use(
  session({
    secret: "dinkes-chat-secret-2026",
    resave: false,
    saveUninitialized: false,
  }),
);

app.set("view engine", "ejs");
app.set("views", "views");

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
  ssl:
    process.env.DATABASE_SSL === "false"
      ? false
      : { rejectUnauthorized: false },
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
// MIDDLEWARE: Cek login admin
// =============================================
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.redirect("/admin/login");
}

// =============================================
// ROUTE: Test Database Connection
// =============================================
app.get("/test-db", async (req, res) => {
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
    res.json({
      status: "ERROR",
      pesan: err.message,
      databaseUrl: process.env.DATABASE_URL ? "ADA" : "TIDAK ADA",
    });
  }
});

// =============================================
// ROUTE: Halaman Utama - Input Data Pasien
// =============================================
app.get("/", (req, res) => {
  res.render("index", {
    title: "TAMBAH PASIEN BARU",
    rumahSakitList: RUMAH_SAKIT_LIST,
  });
});

// =============================================
// ROUTE: Tambah Pasien Baru & Langsung Masuk Chat
// =============================================
app.post("/tambah", async (req, res) => {
  try {
    const { nama, alamat, nomor_wa, rumah_sakit } = req.body;
    if (!rumah_sakit || !RUMAH_SAKIT_LIST.includes(rumah_sakit)) {
      return res.status(400).send("Rumah sakit tidak valid.");
    }
    const result = await db.query(
      "INSERT INTO patients (nama, alamat, nomor_wa, rumah_sakit) VALUES ($1, $2, $3, $4) RETURNING id",
      [nama, alamat, nomor_wa, rumah_sakit],
    );
    const newUserId = result.rows[0].id;
    const roomId = `${rumah_sakit}_${newUserId}`;
    res.redirect(`/chat/${encodeURIComponent(roomId)}`);
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
    if (!user) return res.redirect("/");

    const messages = await fetchRoomMessages(roomId, user.nama, 200);

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
  res.render("admin-login", { error: null });
});

app.post("/admin/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await db.query(
      "SELECT * FROM admins WHERE username = $1 AND password = $2",
      [username, password],
    );
    if (result.rows.length > 0) {
      req.session.isAdmin = true;
      req.session.adminUser = username;
      req.session.adminRumahSakit = result.rows[0].rumah_sakit;
      res.redirect("/admin");
    } else {
      res.render("admin-login", { error: "Username atau password salah!" });
    }
  } catch (err) {
    console.error("Error login:", err.message);
    res.render("admin-login", { error: "Terjadi kesalahan server." });
  }
});

app.get("/admin/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/admin/login");
});

// =============================================
// ROUTE: Admin - Dashboard (filtered by hospital)
// =============================================
app.get("/admin", requireAdmin, async (req, res) => {
  try {
    const rumahSakit = req.session.adminRumahSakit;
    // Only get users (patients) for this admin's hospital
    const usersResult = await db.query(
      "SELECT * FROM patients WHERE rumah_sakit = $1 ORDER BY is_pinned DESC, id ASC",
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
      rooms.push({
        id: user.id,
        nama: user.nama,
        alamat: user.alamat,
        nomor_wa: user.nomor_wa,
        rumah_sakit: user.rumah_sakit,
        roomId: room_id,
        isPinned: !!user.is_pinned,
        totalPesan: parseInt(msgCount.rows[0].total),
        lastMessage: lastMsg.rows.length > 0 ? lastMsg.rows[0] : null,
      });
    }

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
// ROUTE: Admin - Hapus Pesan
// =============================================
app.post("/admin/message/delete", requireAdmin, async (req, res) => {
  const { messageId, patientId } = req.body;
  try {
    await db.query("DELETE FROM messages WHERE id = $1", [messageId]);
    res.redirect(`/admin/room/${patientId}`);
  } catch (err) {
    console.error("Error hapus pesan:", err.message);
    res.redirect(`/admin/room/${patientId}`);
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// API: Ambil pesan per room (untuk auto-refresh)
// =============================================
app.get("/api/messages/:roomId", async (req, res) => {
  const roomId = req.params.roomId;
  const viewer = req.query.viewer || "";
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
    res.status(500).json({ error: err.message });
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
    const result = await db.query("SELECT id FROM patients WHERE id = $1", [
      userId,
    ]);
    res.json({ exists: result.rows.length > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// API: Upload Lampiran (foto / video / dokumen)
// Data dikirim sebagai base64, tersimpan di DB
// =============================================
app.post("/api/upload", async (req, res) => {
  const { roomId, senderName, mime, name, size, data } = req.body;
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

    let replyTo = null;
    if (req.body.replyTo != null && Number.isInteger(Number(req.body.replyTo)) && Number(req.body.replyTo) > 0) {
      replyTo = Number(req.body.replyTo);
      const chk = await db.query(
        "SELECT id FROM messages WHERE id = $1 AND room_id = $2",
        [replyTo, roomId],
      );
      if (!chk.rows.length) replyTo = null;
    }

    const result = await db.query(
      "INSERT INTO messages (room_id, sender_name, message, message_type, file_name, file_mime, file_data, file_size, reply_to) VALUES ($1, $2, $3, 'file', $4, $5, $6, $7, $8) RETURNING *",
      [
        roomId,
        senderName || "Anonim",
        name,
        name,
        mime || "application/octet-stream",
        base64,
        parseInt(size, 10) || base64.length,
        replyTo,
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
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// API: Hapus pesan (Hapus untuk Semua / Hapus untuk Saya)
// Dipakai dari tampilan pasien & admin (via konfirmasi hapus)
// =============================================
app.post("/api/message/delete", async (req, res) => {
  const { roomId, viewerName, messageIds, mode } = req.body || {};
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
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// API: Ambil file lampiran (foto / video / dokumen)
// =============================================
app.get("/api/file/:id", async (req, res) => {
  try {
    const result = await db.query(
      "SELECT file_data, file_mime, file_name FROM messages WHERE id = $1 AND message_type = 'file'",
      [req.params.id],
    );
    const row = result.rows[0];
    if (!row || !row.file_data)
      return res.status(404).send("File tidak ditemukan.");

    const buf = Buffer.from(row.file_data, "base64");
    const safeName = (row.file_name || "file").replace(/["\\]/g, "");
    res.set("Content-Type", row.file_mime || "application/octet-stream");
    res.set("Content-Disposition", `inline; filename="${safeName}"`);
    res.set("Cache-Control", "public, max-age=86400");
    res.send(buf);
  } catch (err) {
    res.status(500).send("Gagal memuat file.");
  }
});

// =============================================
// API: Daftar room per rumah sakit (untuk admin sidebar)
// =============================================
app.get("/api/rooms", requireAdmin, async (req, res) => {
  try {
    const rumahSakit = req.session.adminRumahSakit;
    const usersResult = await db.query(
      "SELECT * FROM patients WHERE rumah_sakit = $1 ORDER BY is_pinned DESC, id ASC",
      [rumahSakit],
    );
    const rooms = [];
    for (const user of usersResult.rows) {
      const room_id = `${user.rumah_sakit}_${user.id}`;
      const msgCount = await db.query(
        "SELECT COUNT(*) as total FROM messages WHERE room_id = $1",
        [room_id],
      );
      rooms.push({
        id: user.id,
        nama: user.nama,
        alamat: user.alamat,
        nomor_wa: user.nomor_wa,
        roomId: room_id,
        isPinned: !!user.is_pinned,
        totalPesan: parseInt(msgCount.rows[0].total),
      });
    }
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
    res.status(500).json({ error: err.message });
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

// =============================================
// SOCKET.IO: Room-based Realtime Chat (hospital-scoped)
// =============================================
const onlineUsers = {}; // { roomId: Set of socket ids }

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  // Join ke room tertentu (roomId sekarang termasuk prefix rumah_sakit)
  // Dari tampilan admin, payload berupa { roomId, adminName } untuk
  // menandai admin tersebut sedang membaca room (reset unread).
  socket.on("join-room", (payload) => {
    const roomId =
      payload && typeof payload === "object" ? payload.roomId : payload;
    const adminName =
      payload && typeof payload === "object" ? payload.adminName : null;
    if (!roomId) return;

    socket.join(roomId);
    socket.roomId = roomId;
    socket.adminName = adminName || null;

    if (!onlineUsers[roomId]) onlineUsers[roomId] = new Set();
    onlineUsers[roomId].add(socket.id);

    // Beri tahu semua di room jumlah user online
    io.to(roomId).emit("user-count", onlineUsers[roomId].size);
    console.log(`Socket ${socket.id} joined room ${roomId}`);

    // Admin yang membuka room: tanda sedang membaca + reset unread
    if (adminName) {
      if (!onlineAdmins[roomId]) onlineAdmins[roomId] = new Set();
      onlineAdmins[roomId].add(adminName);
      socket.join(ADMIN_CHAN(roomHospital(roomId)));
      markRoomRead(roomId, adminName);
    }
  });

  // Halaman daftar room admin: subscribe ke channel badge unread
  socket.on("join-admin-badges", (rumahSakit) => {
    if (rumahSakit) socket.join(ADMIN_CHAN(String(rumahSakit)));
  });

  // Kirim pesan
  socket.on("message", async (data) => {
    const { roomId, senderName, message } = data;
    if (!roomId || !message) return;

    try {
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
        [roomId, senderName || "Anonim", message, replyTo],
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
