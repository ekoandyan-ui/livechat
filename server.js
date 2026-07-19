const express = require("express");
const mysql = require("mysql");
const BodyParser = require("body-parser");
const path = require("path");

const app = express();
const isVercel = process.env.VERCEL === "1";

app.use(BodyParser.urlencoded({ extended: true }));
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

const db = mysql.createConnection({
  host: process.env.MYSQL_HOST || "localhost",
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD || "",
  database: process.env.MYSQL_DATABASE || "live-chat",
  port: process.env.MYSQL_PORT ? Number(process.env.MYSQL_PORT) : 3306,
});

db.connect((err) => {
  if (err) {
    console.error("Database connection failed:", err.message);
    return;
  }
  console.log("Database connected...");
});

app.get("/", (req, res) => {
  const sql = "SELECT * FROM user";
  db.query(sql, (err, result) => {
    if (err) {
      console.error("Query error:", err.message);
      return res.render("index", {
        users: [],
        title: "DAFTAR PASIEN",
        error: "Tidak dapat memuat daftar pasien. Pastikan database tersedia.",
      });
    }

    const users = JSON.parse(JSON.stringify(result));
    res.render("index", { users, title: "DAFTAR PASIEN", error: null });
  });
});

app.get("/chat", (req, res) => {
  res.render("chat", {
    loginTitle: "MASUK FORUM",
    chatroomTitle: "DISKUSI TERBUKA",
    socketEnabled: !isVercel,
  });
});

app.post("/tambah", (req, res) => {
  const { nama, kelas } = req.body;
  const insertSql = "INSERT INTO user (nama, kelas) VALUES (?, ?)";
  db.query(insertSql, [nama, kelas], (err) => {
    if (err) {
      console.error("Insert error:", err.message);
      return res.redirect("/");
    }
    res.redirect("/");
  });
});

if (!isVercel) {
  const http = require("http");
  const { Server } = require("socket.io");
  const server = http.createServer(app);
  const io = new Server(server);

  io.on("connection", (socket) => {
    socket.on("message", (data) => {
      const { id, message } = data;
      socket.broadcast.emit("message", id, message);
    });
  });

  const PORT = process.env.PORT || 8000;
  server.listen(PORT, () => {
    console.log(`server ready on port ${PORT}...`);
  });
} else {
  module.exports = app;
}
