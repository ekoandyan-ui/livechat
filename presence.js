// =============================================
// PRESENCE: status online/offline per pasien & admin
//
// Dipakai oleh notifikasi email untuk memutuskan apakah penerima sedang
// membuka aplikasi/web. Registry ini in-memory (satu instance server):
//   - Setiap koneksi Socket.IO yang punya identitas dicatat.
//   - Client mengirim event "presence" { visible } saat connect dan saat
//     document.visibilityState berubah.
//   - Bila client lama tidak pernah mengirim "presence", socket dianggap
//     visible selama tersambung (konservatif: jangan salah kirim email).
//
// Catatan: untuk deployment multi-instance, registry ini perlu diganti
// Redis/tabel heartbeat agar konsisten lintas instance.
// =============================================

const sockets = new Map(); // socket.id -> { type, patientId, adminId, rumahSakit, visible }

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function patientIdFromRoom(roomId) {
  if (!roomId) return null;
  const i = String(roomId).lastIndexOf("_");
  const tail = i > -1 ? String(roomId).slice(i + 1) : String(roomId);
  return /^\d+$/.test(tail) ? Number(tail) : null;
}

function normalizeVisible(value) {
  if (value === false || value === 0 || value === "0" || value === "false") {
    return false;
  }
  return true;
}

// Catat socket saat connect. `identity` berasal dari socketIdentity(socket).
function track(socket, identity) {
  if (!socket || !identity) return;
  const entry = {
    type: identity.type === "admin" ? "admin" : "patient",
    patientId:
      identity.type === "patient"
        ? patientIdFromRoom(identity.roomId)
        : null,
    adminId:
      identity.type === "admin" ? toPositiveInt(identity.adminId) : null,
    rumahSakit: identity.rumahSakit || null,
    visible: true,
  };
  sockets.set(socket.id, entry);
}

function untrack(socket) {
  if (socket && socket.id) sockets.delete(socket.id);
}

function setVisible(socket, visible) {
  if (!socket || !socket.id) return;
  const entry = sockets.get(socket.id);
  if (!entry) return;
  entry.visible = normalizeVisible(visible);
}

function isPatientVisible(patientId) {
  const id = toPositiveInt(patientId);
  if (!id) return false;
  for (const entry of sockets.values()) {
    if (entry.type === "patient" && entry.patientId === id && entry.visible) {
      return true;
    }
  }
  return false;
}

function isAdminVisible(adminId) {
  const id = toPositiveInt(adminId);
  if (!id) return false;
  for (const entry of sockets.values()) {
    if (entry.type === "admin" && entry.adminId === id && entry.visible) {
      return true;
    }
  }
  return false;
}

// Apakah ada admin mana pun pada rumah sakit tersebut yang sedang membuka
// aplikasi (dashboard atau room). Bila ada, email ke admin RS ditahan.
function isHospitalAdminVisible(rumahSakit) {
  if (!rumahSakit) return false;
  for (const entry of sockets.values()) {
    if (
      entry.type === "admin" &&
      entry.rumahSakit === rumahSakit &&
      entry.visible
    ) {
      return true;
    }
  }
  return false;
}

function size() {
  return sockets.size;
}

// Hanya untuk pengujian.
function clear() {
  sockets.clear();
}

module.exports = {
  track,
  untrack,
  setVisible,
  isPatientVisible,
  isAdminVisible,
  isHospitalAdminVisible,
  patientIdFromRoom,
  size,
  clear,
};
