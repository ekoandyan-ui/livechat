const express = require("express");
const { Pool } = require("pg");
const BodyParser = require("body-parser");

const app = express();

const http = require("http");
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

app.use(BodyParser.urlencoded({ extended: true }));

app.set("view engine", "ejs");
app.set("views", "views");

// =============================================
// KONEKSI DATABASE SUPABASE (PostgreSQL)
// DATABASE_URL diambil dari environment variable
// =============================================
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // wajib untuk Supabase
  },
});

// Test koneksi database saat server pertama kali jalan
db.connect((err, client, release) => {
  if (err) {
    console.error("❌ Gagal koneksi ke database:", err.message);
    return;
  }
  release();
  console.log("✅ Database Supabase berhasil terhubung!");
});

// =============================================
// ROUTE: Halaman Utama - Daftar Pasien
// =============================================
app.get("/", async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM "user" ORDER BY id ASC');
    res.render("index", { users: result.rows, title: "DAFTAR PASIEN" });
  } catch (err) {
    console.error("Error ambil data user:", err.message);
    res.status(500).send("Gagal mengambil data. Periksa koneksi database.");
  }
});

// =============================================
// ROUTE: Halaman Chat
// =============================================
app.get("/chat", (req, res) => {
  res.render("chat", {
    loginTitle: "MASUK FORUM",
    chatroomTitle: "DISKUSI TERBUKA",
  });
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
    res.status(500).send("Gagal menyimpan data. Periksa koneksi database.");
  }
});

// =============================================
// SOCKET.IO: Realtime Chat
// =============================================
io.on("connection", (socket) => {
  console.log("User terhubung:", socket.id);

  socket.on("message", (data) => {
    const { id, message } = data;
    socket.broadcast.emit("message", id, message);
  });

  socket.on("disconnect", () => {
    console.log("User keluar:", socket.id);
  });
});

// =============================================
// JALANKAN SERVER
// PORT diambil dari environment variable (Railway inject otomatis)
// Kalau tidak ada, gunakan 8000 untuk development lokal
// =============================================
const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
  console.log(`🚀 Server berjalan di port ${PORT}`);
});
