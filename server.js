const express = require("express");
const { Pool } = require("pg");
const BodyParser = require("body-parser");
const session = require("express-session");

const app = express();
const http = require("http");
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

app.use(BodyParser.urlencoded({ extended: true }));
app.use(BodyParser.json());
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
// MIDDLEWARE: Cek login admin
// =============================================
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.redirect("/admin/login");
}

// =============================================
// ROUTE: Halaman Utama - Daftar Pasien
// =============================================
app.get("/", async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM "user" ORDER BY id ASC');
    res.render("index", { users: result.rows, title: "DAFTAR PASIEN" });
  } catch (err) {
    console.error("Error ambil data user:", err.message);
    res.status(500).send("Gagal mengambil data.");
  }
});

// =============================================
// ROUTE: Tambah Pasien Baru
// =============================================
app.post("/tambah", async (req, res) => {
  try {
    const { nama, kelas } = req.body;
    await db.query('INSERT INTO "user" (nama, kelas) VALUES ($1, $2)', [
      nama,
      kelas,
    ]);
    res.redirect("/");
  } catch (err) {
    console.error("Error tambah data:", err.message);
    res.status(500).send("Gagal menyimpan data.");
  }
});

// =============================================
// ROUTE: Chat Publik (per room)
// =============================================
app.get("/chat/:roomId", async (req, res) => {
  const { roomId } = req.params;
  try {
    const userResult = await db.query('SELECT * FROM "user" WHERE id = $1', [
      roomId,
    ]);
    const userName = userResult.rows.length > 0 ? userResult.rows[0].nama : "Anonim";

    const msgResult = await db.query(
      "SELECT * FROM messages WHERE room_id = $1 ORDER BY created_at ASC LIMIT 200",
      [roomId]
    );

    res.render("chat", {
      roomId,
      userName,
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
// ROUTE: Admin - Dashboard
// =============================================
app.get("/admin", requireAdmin, async (req, res) => {
  try {
    const usersResult = await db.query('SELECT * FROM "user" ORDER BY id ASC');
    const rooms = [];

    for (const user of usersResult.rows) {
      const msgCount = await db.query(
        "SELECT COUNT(*) as total FROM messages WHERE room_id = $1",
        [user.id.toString()]
      );
      const lastMsg = await db.query(
        "SELECT * FROM messages WHERE room_id = $1 ORDER BY created_at DESC LIMIT 1",
        [user.id.toString()]
      );
      rooms.push({
        id: user.id,
        nama: user.nama,
        kelas: user.kelas,
        totalPesan: parseInt(msgCount.rows[0].total),
        lastMessage: lastMsg.rows.length > 0 ? lastMsg.rows[0] : null,
      });
    }

    res.render("admin", {
      rooms,
      adminUser: req.session.adminUser,
    });
  } catch (err) {
    console.error("Error admin dashboard:", err.message);
    res.status(500).send("Gagal memuat dashboard.");
  }
});

// =============================================
// ROUTE: Admin - Lihat Chat Room
// =============================================
app.get("/admin/room/:roomId", requireAdmin, async (req, res) => {
  const { roomId } = req.params;
  try {
    const userResult = await db.query('SELECT * FROM "user" WHERE id = $1', [
      roomId,
    ]);
    const messagesResult = await db.query(
      "SELECT * FROM messages WHERE room_id = $1 ORDER BY created_at ASC",
      [roomId]
    );

    res.render("admin-room", {
      roomId,
      user: userResult.rows[0] || null,
      messages: messagesResult.rows,
      adminUser: req.session.adminUser,
    });
  } catch (err) {
    console.error("Error admin room:", err.message);
    res.status(500).send("Gagal memuat room.");
  }
});

// =============================================
// ROUTE: Admin - Hapus Pesan
// =============================================
app.post("/admin/message/delete", requireAdmin, async (req, res) => {
  const { messageId, roomId } = req.body;
  try {
    await db.query("DELETE FROM messages WHERE id = $1", [messageId]);
    res.redirect(`/admin/room/${roomId}`);
  } catch (err) {
    console.error("Error hapus pesan:", err.message);
    res.redirect(`/admin/room/${roomId}`);
  }
});

// =============================================
// API: Ambil pesan per room (untuk auto-refresh)
// =============================================
app.get("/api/messages/:roomId", async (req, res) => {
  const { roomId } = req.params;
  const after = req.query.after;
  try {
    let query, params;
    if (after) {
      query =
        "SELECT * FROM messages WHERE room_id = $1 AND id > $2 ORDER BY created_at ASC";
      params = [roomId, after];
    } else {
      query =
        "SELECT * FROM messages WHERE room_id = $1 ORDER BY created_at ASC LIMIT 200";
      params = [roomId];
    }
    const result = await db.query(query, params);
    res.json({ messages: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// API: Daftar semua room (untuk admin sidebar)
// =============================================
app.get("/api/rooms", async (req, res) => {
  try {
    const usersResult = await db.query('SELECT * FROM "user" ORDER BY id ASC');
    const rooms = [];
    for (const user of usersResult.rows) {
      const msgCount = await db.query(
        "SELECT COUNT(*) as total FROM messages WHERE room_id = $1",
        [user.id.toString()]
      );
      rooms.push({
        id: user.id,
        nama: user.nama,
        kelas: user.kelas,
        totalPesan: parseInt(msgCount.rows[0].total),
      });
    }
    res.json({ rooms });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// SOCKET.IO: Room-based Realtime Chat
// =============================================
const onlineUsers = {}; // { roomId: Set of socket ids }

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  // Join ke room tertentu
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
      // Simpan ke database (PERMANEN)
      const result = await db.query(
        "INSERT INTO messages (room_id, sender_name, message) VALUES ($1, $2, $3) RETURNING *",
        [roomId, senderName || "Anonim", message]
      );
      const savedMsg = result.rows[0];

      // Kirim ke semua di room termasuk pengirim
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
