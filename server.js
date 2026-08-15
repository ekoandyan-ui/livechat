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
  })
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
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
    );
    res.json({
      status: "OK",
      databaseUrl: urlCheck,
      waktu: result.rows[0].waktu,
      tabel: tables.rows.map((r) => r.table_name),
    });
  } catch (err) {
    res.json({ status: "ERROR", pesan: err.message, databaseUrl: process.env.DATABASE_URL ? "ADA" : "TIDAK ADA" });
  }
});

// =============================================
// ROUTE: Halaman Utama - Input Data Pasien
// =============================================
app.get("/", (req, res) => {
  res.render("index", { title: "TAMBAH PASIEN BARU", rumahSakitList: RUMAH_SAKIT_LIST });
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
      'INSERT INTO patients (nama, alamat, nomor_wa, rumah_sakit) VALUES ($1, $2, $3, $4) RETURNING id',
      [nama, alamat, nomor_wa, rumah_sakit]
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
    const userId = lastUnderscore > -1 ? roomId.substring(lastUnderscore + 1) : roomId;
    const rumahSakit = lastUnderscore > -1 ? roomId.substring(0, lastUnderscore) : "";

    // Jika ID pasien tidak valid, kembali ke form pendaftaran
    if (!/^\d+$/.test(userId)) return res.redirect("/");

    const userResult = await db.query("SELECT * FROM patients WHERE id = $1", [
      userId,
    ]);
    const user = userResult.rows[0];

    // Jika pasien sudah dihapus admin (total chat dihapus), otomatis kembali ke form awal
    if (!user) return res.redirect("/");

    const msgResult = await db.query(
      "SELECT id, room_id, sender_name, message, message_type, file_name, file_mime, file_size, created_at FROM messages WHERE room_id = $1 ORDER BY created_at ASC LIMIT 200",
      [roomId]
    );

    res.render("chat", {
      roomId,
      userName: user.nama,
      alamat: user.alamat,
      nomorWa: user.nomor_wa,
      rumahSakit,
      messages: msgResult.rows,
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
      [username, password]
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
      "SELECT * FROM patients WHERE rumah_sakit = $1 ORDER BY id ASC",
      [rumahSakit]
    );
    const rooms = [];

    for (const user of usersResult.rows) {
      const room_id = `${user.rumah_sakit}_${user.id}`;
      const msgCount = await db.query(
        "SELECT COUNT(*) as total FROM messages WHERE room_id = $1",
        [room_id]
      );
      const lastMsg = await db.query(
        "SELECT id, room_id, sender_name, message, message_type, file_name, file_mime, file_size, created_at FROM messages WHERE room_id = $1 ORDER BY created_at DESC LIMIT 1",
        [room_id]
      );
      rooms.push({
        id: user.id,
        nama: user.nama,
        alamat: user.alamat,
        nomor_wa: user.nomor_wa,
        rumah_sakit: user.rumah_sakit,
        roomId: room_id,
        totalPesan: parseInt(msgCount.rows[0].total),
        lastMessage: lastMsg.rows.length > 0 ? lastMsg.rows[0] : null,
      });
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
    const userResult = await db.query("SELECT * FROM patients WHERE id = $1", [patientId]);
    const user = userResult.rows[0];

    if (!user) {
      return res.status(404).send("Pasien tidak ditemukan.");
    }

    if (user.rumah_sakit !== rumahSakit) {
      return res.status(403).send("Akses ditolak: Room ini bukan milik rumah sakit Anda.");
    }

    const roomId = `${user.rumah_sakit}_${user.id}`;

    const messagesResult = await db.query(
      "SELECT id, room_id, sender_name, message, message_type, file_name, file_mime, file_size, created_at FROM messages WHERE room_id = $1 ORDER BY created_at ASC",
      [roomId]
    );

    res.render("admin-room", {
      roomId,
      user,
      messages: messagesResult.rows,
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
    const userResult = await db.query("SELECT * FROM patients WHERE id = $1", [patientId]);
    const user = userResult.rows[0];

    if (!user) {
      return res.status(404).send("Pasien tidak ditemukan.");
    }

    if (user.rumah_sakit !== rumahSakit) {
      return res.status(403).send("Akses ditolak: Data ini bukan milik rumah sakit Anda.");
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
    const userResult = await db.query("SELECT * FROM patients WHERE id = $1", [patientId]);
    const user = userResult.rows[0];
    if (!user) return res.status(404).send("Pasien tidak ditemukan.");
    if (user.rumah_sakit !== rumahSakit) return res.status(403).send("Akses ditolak: Room ini bukan milik rumah sakit Anda.");

    const roomId = `${user.rumah_sakit}_${user.id}`;
    await db.query("DELETE FROM messages WHERE room_id = $1", [roomId]);
    await db.query("DELETE FROM patients WHERE id = $1", [patientId]);

    // Beri tahu pasien di room tersebut agar otomatis kembali ke form awal
    io.to(roomId).emit("chat-deleted");

    res.redirect("/admin");
  } catch (err) {
    console.error("Error hapus total chat:", err.message);
    res.redirect("/admin");
  }
});

// =============================================
// API: Ambil pesan per room (untuk auto-refresh)
// =============================================
app.get("/api/messages/:roomId", async (req, res) => {
  const roomId = req.params.roomId;
  const after = req.query.after;
  try {
    let query, params;
    if (after) {
      query =
        "SELECT id, room_id, sender_name, message, message_type, file_name, file_mime, file_size, created_at FROM messages WHERE room_id = $1 AND id > $2 ORDER BY created_at ASC";
      params = [roomId, after];
    } else {
      query =
        "SELECT id, room_id, sender_name, message, message_type, file_name, file_mime, file_size, created_at FROM messages WHERE room_id = $1 ORDER BY created_at ASC LIMIT 200";
      params = [roomId];
    }
    const result = await db.query(query, params);
    res.json({ messages: result.rows });
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
    const userId = lastUnderscore > -1 ? roomId.substring(lastUnderscore + 1) : roomId;
    if (!/^\d+$/.test(userId)) return res.json({ exists: false });
    const result = await db.query("SELECT id FROM patients WHERE id = $1", [userId]);
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
    const userId = lastUnderscore > -1 ? roomId.substring(lastUnderscore + 1) : roomId;
    if (!/^\d+$/.test(userId)) return res.status(400).json({ error: "Room tidak valid." });
    const patientCheck = await db.query("SELECT id FROM patients WHERE id = $1", [userId]);
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

    const result = await db.query(
      "INSERT INTO messages (room_id, sender_name, message, message_type, file_name, file_mime, file_data, file_size) VALUES ($1, $2, $3, 'file', $4, $5, $6, $7) RETURNING *",
      [roomId, senderName || "Anonim", name, name, mime || "application/octet-stream", base64, parseInt(size, 10) || base64.length]
    );
    const m = result.rows[0];

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
    });

    res.json({ ok: true, id: m.id });
  } catch (err) {
    console.error("Gagal simpan lampiran:", err.message);
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
      [req.params.id]
    );
    const row = result.rows[0];
    if (!row || !row.file_data) return res.status(404).send("File tidak ditemukan.");

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
      "SELECT * FROM patients WHERE rumah_sakit = $1 ORDER BY id ASC",
      [rumahSakit]
    );
    const rooms = [];
    for (const user of usersResult.rows) {
      const room_id = `${user.rumah_sakit}_${user.id}`;
      const msgCount = await db.query(
        "SELECT COUNT(*) as total FROM messages WHERE room_id = $1",
        [room_id]
      );
      rooms.push({
        id: user.id,
        nama: user.nama,
        alamat: user.alamat,
        nomor_wa: user.nomor_wa,
        roomId: room_id,
        totalPesan: parseInt(msgCount.rows[0].total),
      });
    }
    res.json({ rooms });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// SOCKET.IO: Room-based Realtime Chat (hospital-scoped)
// =============================================
const onlineUsers = {}; // { roomId: Set of socket ids }

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  // Join ke room tertentu (roomId sekarang termasuk prefix rumah_sakit)
  socket.on("join-room", (roomId) => {
    socket.join(roomId);
    socket.roomId = roomId;

    if (!onlineUsers[roomId]) onlineUsers[roomId] = new Set();
    onlineUsers[roomId].add(socket.id);

    // Beri tahu semua di room jumlah user online
    io.to(roomId).emit("user-count", onlineUsers[roomId].size);
    console.log(`Socket ${socket.id} joined room ${roomId}`);
  });

  // Kirim pesan
  socket.on("message", async (data) => {
    const { roomId, senderName, message } = data;
    if (!roomId || !message) return;

    try {
      const result = await db.query(
        "INSERT INTO messages (room_id, sender_name, message) VALUES ($1, $2, $3) RETURNING *",
        [roomId, senderName || "Anonim", message]
      );
      const savedMsg = result.rows[0];

      io.to(roomId).emit("room-message", {
        id: savedMsg.id,
        room_id: savedMsg.room_id,
        sender_name: savedMsg.sender_name,
        message: savedMsg.message,
        created_at: savedMsg.created_at,
      });
    } catch (err) {
      console.error("Gagal simpan pesan:", err.message);
    }
  });

  // Disconnect
  socket.on("disconnect", () => {
    const roomId = socket.roomId;
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
