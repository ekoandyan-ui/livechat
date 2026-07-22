require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const BodyParser = require("body-parser");
const session = require("express-session");

const app = express();

const http = require("http");
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

// Middleware
app.use(BodyParser.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "livechat_secret_key_2026",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }, // 1 hari
  })
);

app.set("view engine", "ejs");
app.set("views", "views");

// =============================================
// KONEKSI DATABASE SUPABASE (PostgreSQL)
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

// Middleware Proteksi Admin
function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) {
    return next();
  }
  return res.redirect("/admin/login");
}

// =============================================
// ROUTE PUBLIK
// =============================================

// Halaman Utama Publik: Form Nama & Kelas
app.get("/", (req, res) => {
  if (req.session.user) {
    return res.redirect("/chat");
  }
  res.render("public_login", { error: null });
});

// Form Submit Publik: Simpan Data & Set Session User
app.post("/masuk", async (req, res) => {
  try {
    const { nama, kelas } = req.body;
    if (!nama || !kelas) {
      return res.render("public_login", {
        error: "Nama dan Kelas wajib diisi!",
      });
    }

    // Simpan data pasien ke database Supabase
    await db.query('INSERT INTO "user" (nama, kelas) VALUES ($1, $2)', [
      nama,
      kelas,
    ]);

    // Simpan identitas pengguna di session
    req.session.user = {
      nama,
      kelas,
      isAdmin: false,
    };

    res.redirect("/chat");
  } catch (err) {
    console.error("Error simpan data publik:", err.message);
    res.render("public_login", {
      error: "Gagal menyimpan data ke database. Silakan coba lagi.",
    });
  }
});

// Route Keluar dari Chat Publik
app.get("/keluar-chat", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/");
  });
});

// =============================================
// ROUTE ADMIN
// =============================================

// Halaman Awal Admin -> Redirect ke Dashboard jika sudah login
app.get("/admin", (req, res) => {
  if (req.session && req.session.admin) {
    return res.redirect("/admin/dashboard");
  }
  res.redirect("/admin/login");
});

// Form Login Admin (GET)
app.get("/admin/login", (req, res) => {
  if (req.session && req.session.admin) {
    return res.redirect("/admin/dashboard");
  }
  res.render("admin_login", { error: null });
});

// Proses Login Admin (POST)
app.post("/admin/login", (req, res) => {
  const { username, password } = req.body;
  const adminUser = process.env.ADMIN_USERNAME || "admin";
  const adminPass = process.env.ADMIN_PASSWORD || "admin123";

  if (username === adminUser && password === adminPass) {
    req.session.admin = {
      nama: "Administrator",
      isAdmin: true,
    };
    return res.redirect("/admin/dashboard");
  }

  res.render("admin_login", {
    error: "Username atau Password yang Anda masukkan salah!",
  });
});

// Halaman Dashboard Admin (Daftar Pasien)
app.get("/admin/dashboard", requireAdmin, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM "user" ORDER BY id DESC');
    res.render("admin_dashboard", {
      users: result.rows,
      title: "DAFTAR PASIEN / PENGUNJUNG",
      success: req.query.deleted ? "Data pasien berhasil dihapus!" : null,
    });
  } catch (err) {
    console.error("Error ambil data admin:", err.message);
    res.status(500).send("Gagal mengambil data pasien.");
  }
});

// Hapus Data Pasien (Khusus Admin)
app.post("/admin/delete/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await db.query('DELETE FROM "user" WHERE id = $1', [id]);
    res.redirect("/admin/dashboard?deleted=true");
  } catch (err) {
    console.error("Error hapus data pasien:", err.message);
    res.status(500).send("Gagal menghapus data pasien.");
  }
});

// Logout Admin
app.get("/admin/logout", (req, res) => {
  if (req.session) {
    delete req.session.admin;
  }
  res.redirect("/admin/login");
});

// =============================================
// ROUTE: Halaman Chat (Bisa diakses Publik & Admin)
// =============================================
app.get("/chat", (req, res) => {
  const currentUser = req.session.user || req.session.admin;

  if (!currentUser) {
    return res.redirect("/");
  }

  res.render("chat", {
    chatroomTitle: "RUANG LIVE CHAT DISKUSI",
    currentUser: currentUser,
  });
});

// =============================================
// SOCKET.IO: Realtime Chat
// =============================================
io.on("connection", (socket) => {
  console.log("⚡ User terhubung ke Socket.io:", socket.id);

  socket.on("message", (data) => {
    // Broadcast data pesan ke pengguna lain
    socket.broadcast.emit("message", data);
  });

  socket.on("disconnect", () => {
    console.log("🔌 User terputus:", socket.id);
  });
});

// =============================================
// JALANKAN SERVER
// =============================================
const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
  console.log(`🚀 Server berjalan di port ${PORT}`);
  console.log(`📍 Halaman Publik: http://localhost:${PORT}/`);
  console.log(`📍 Halaman Admin:  http://localhost:${PORT}/admin`);
});
