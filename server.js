const express = require("express");
const { Pool } = require("pg");
const BodyParser = require("body-parser");
const session = require("express-session");
const http = require("http");
const { Server } = require("socket.io");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Middleware
app.use(BodyParser.urlencoded({ extended: true }));
app.use(BodyParser.json());

// Session setup
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dinkes_super_secret_key_2026",
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }, // 1 hari
  })
);

app.set("view engine", "ejs");
app.set("views", "views");

// =============================================
// KONEKSI DATABASE SUPABASE (PostgreSQL)
// =============================================
let db = null;
if (process.env.DATABASE_URL) {
  db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false, // wajib untuk Supabase
    },
  });

  // Test & Auto Migration saat server start
  db.connect(async (err, client, release) => {
    if (err) {
      console.error("❌ Gagal koneksi ke database Supabase:", err.message);
      return;
    }
    release();
    console.log("✅ Database Supabase berhasil terhubung!");

    // Auto-create tables jika belum ada
    try {
      await db.query(`
        CREATE TABLE IF NOT EXISTS "user" (
          id SERIAL PRIMARY KEY,
          nama VARCHAR(100) NOT NULL,
          kelas VARCHAR(50) NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS "admin_users" (
          id SERIAL PRIMARY KEY,
          username VARCHAR(50) UNIQUE NOT NULL,
          password VARCHAR(255) NOT NULL,
          role VARCHAR(20) DEFAULT 'admin',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        INSERT INTO "admin_users" (username, password, role)
        VALUES ('admin', 'admin123', 'admin')
        ON CONFLICT (username) DO NOTHING;
      `);
      console.log("✅ Auto-migration tabel Supabase selesai!");
    } catch (migErr) {
      console.error("⚠️ Migration notice:", migErr.message);
    }
  });
} else {
  console.warn("⚠️ DATABASE_URL tidak ditemukan. Mohon setel di file .env atau Railway environment variables.");
}

// Middleware Helper: Proteksi Halaman Admin
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) {
    return next();
  }
  return res.redirect("/admin/login?error=Silakan login terlebih dahulu");
}

// =============================================
// ROUTES: LANDING & LOGIN
// =============================================

// Halaman Utama: Menampilkan Daftar Pasien / User
app.get("/", async (req, res) => {
  try {
    let users = [];
    if (db) {
      const result = await db.query('SELECT * FROM "user" ORDER BY id DESC');
      users = result.rows;
    }
    res.render("index", {
      users,
      title: "PORTAL DATA PASIEN & USER DINKES",
      session: req.session,
    });
  } catch (err) {
    console.error("Error ambil data user:", err.message);
    res.render("index", { users: [], title: "PORTAL DATA PASIEN", session: req.session, error: err.message });
  }
});

// GET: Halaman Login Admin & Form Entry Nama/Kelas
app.get("/admin/login", (req, res) => {
  const error = req.query.error || null;
  const success = req.query.success || null;
  const mode = req.query.mode || "credentials"; // 'credentials' or 'form'
  res.render("admin-login", { error, success, mode, session: req.session });
});

// POST: Login Admin dengan Username & Password
app.post("/admin/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.redirect("/admin/login?error=Username dan Password wajib diisi&mode=credentials");
  }

  try {
    if (db) {
      const result = await db.query('SELECT * FROM "admin_users" WHERE username = $1', [username]);
      const admin = result.rows[0];

      if (admin && admin.password === password) { // untuk produksi disarankan hash bcrypt
        req.session.isAdmin = true;
        req.session.adminUser = admin.username;
        return res.redirect("/admin/dashboard");
      }
    } else {
      // Fallback lokal jika DB belum dikonfigurasi
      if (username === "admin" && password === "admin123") {
        req.session.isAdmin = true;
        req.session.adminUser = "admin";
        return res.redirect("/admin/dashboard");
      }
    }

    return res.redirect("/admin/login?error=Username atau Password salah!&mode=credentials");
  } catch (err) {
    console.error("Error login admin:", err.message);
    return res.redirect("/admin/login?error=Terjadi kesalahan pada database&mode=credentials");
  }
});

// POST: Entry Form Nama & Kelas (Login Cepat User / Petugas)
app.post("/admin/entry", async (req, res) => {
  const { nama, kelas, redirect_to } = req.body;

  if (!nama || !kelas) {
    return res.redirect("/admin/login?error=Nama dan Kelas wajib diisi!&mode=form");
  }

  try {
    if (db) {
      await db.query('INSERT INTO "user" (nama, kelas) VALUES ($1, $2)', [nama, kelas]);
    }
    
    req.session.userName = nama;
    req.session.userKelas = kelas;

    if (redirect_to === "chat") {
      return res.redirect("/chat");
    }
    return res.redirect("/admin/dashboard?success=Data Nama & Kelas berhasil disimpan!");
  } catch (err) {
    console.error("Error Simpan Form Entry:", err.message);
    return res.redirect("/admin/login?error=Gagal menyimpan data ke database&mode=form");
  }
});

// GET: Admin Dashboard (Hanya bisa diakses jika sudah login Admin)
app.get("/admin/dashboard", async (req, res) => {
  // Jika admin belum login, tampilkan pemberitahuan atau proteksi (bisa fleksibel)
  const isAdmin = req.session && req.session.isAdmin;
  const success = req.query.success || null;
  const error = req.query.error || null;

  try {
    let users = [];
    let totalUsers = 0;
    if (db) {
      const result = await db.query('SELECT * FROM "user" ORDER BY id DESC');
      users = result.rows;
      totalUsers = users.length;
    }
    res.render("admin-dashboard", {
      users,
      totalUsers,
      isAdmin,
      session: req.session,
      success,
      error,
    });
  } catch (err) {
    console.error("Error load dashboard:", err.message);
    res.render("admin-dashboard", {
      users: [],
      totalUsers: 0,
      isAdmin,
      session: req.session,
      error: "Gagal mengambil data dari Supabase database.",
      success: null,
    });
  }
});

// POST: Tambah User / Pasien Baru dari Dashboard
app.post("/tambah", async (req, res) => {
  try {
    const { nama, kelas } = req.body;
    if (db && nama && kelas) {
      await db.query('INSERT INTO "user" (nama, kelas) VALUES ($1, $2)', [nama, kelas]);
    }
    res.redirect("/admin/dashboard?success=Pasien/User berhasil ditambahkan!");
  } catch (err) {
    console.error("Error tambah data:", err.message);
    res.redirect("/admin/dashboard?error=Gagal menambah data pasien");
  }
});

// POST: Hapus Data User / Pasien
app.post("/admin/delete/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    if (db) {
      await db.query('DELETE FROM "user" WHERE id = $1', [id]);
    }
    res.redirect("/admin/dashboard?success=Data berhasil dihapus!");
  } catch (err) {
    console.error("Error hapus data:", err.message);
    res.redirect("/admin/dashboard?error=Gagal menghapus data");
  }
});

// GET: Logout Session Admin / User
app.get("/admin/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/admin/login?success=Anda telah keluar dari sesi.");
  });
});

// =============================================
// ROUTE: Halaman Chat Realtime
// =============================================
app.get("/chat", (req, res) => {
  res.render("chat", {
    loginTitle: "MASUK FORUM DISKUSI",
    chatroomTitle: "DISKUSI TERBUKA DINKES",
    session: req.session,
  });
});

// =============================================
// SOCKET.IO: Realtime Chat
// =============================================
io.on("connection", (socket) => {
  console.log("⚡ Socket Terhubung:", socket.id);

  socket.on("message", (data) => {
    const { id, sender, message } = data;
    socket.broadcast.emit("message", id, sender || "Anonim", message);
  });

  socket.on("disconnect", () => {
    console.log("🔌 Socket Terputus:", socket.id);
  });
});

// =============================================
// JALANKAN SERVER
// =============================================
const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
  console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
});
