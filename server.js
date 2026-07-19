const express = require("express");
const BodyParser = require("body-parser");
const { createClient } = require("@supabase/supabase-js");
const path = require("path");

const app = express();

const http = require("http");
const server = http.createServer(app);
const { Server } = require("socket.io");

// Socket.IO dikonfigurasi dengan polling agar kompatibel dengan Vercel serverless
const io = new Server(server, {
  transports: ["polling"],
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.use(BodyParser.urlencoded({ extended: true }));
app.use(express.json());

// CORS headers untuk Vercel
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Supabase client - ambil dari environment variables
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// =============== ROUTES ===============

// Halaman utama - daftar user
app.get("/", async (req, res) => {
  try {
    const { data: users, error } = await supabase
      .from("user")
      .select("*")
      .order("id", { ascending: true });

    if (error) {
      console.error("Supabase error:", error.message);
      return res.render("index", { users: [], title: "DAFTAR PASIEN", error: error.message });
    }

    res.render("index", { users: users || [], title: "DAFTAR PASIEN", error: null });
  } catch (err) {
    console.error("Server error:", err.message);
    res.render("index", { users: [], title: "DAFTAR PASIEN", error: err.message });
  }
});

// Halaman chat
app.get("/chat", (req, res) => {
  res.render("chat", {
    loginTitle: "MASUK FORUM",
    chatroomTitle: "DISKUSI TERBUKA",
  });
});

// Tambah user baru
app.post("/tambah", async (req, res) => {
  try {
    const { nama, kelas } = req.body;

    if (!nama || !kelas) {
      return res.redirect("/");
    }

    const { error } = await supabase
      .from("user")
      .insert([{ nama, kelas }]);

    if (error) {
      console.error("Insert error:", error.message);
    }

    res.redirect("/");
  } catch (err) {
    console.error("Server error:", err.message);
    res.redirect("/");
  }
});

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// =============== SOCKET.IO ===============
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("message", (data) => {
    const { id, message } = data;
    socket.broadcast.emit("message", id, message);
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

// =============== SERVER START ===============
const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
});

module.exports = app;
