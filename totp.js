"use strict";

// =============================================
// TOTP (RFC 6238) + Base32 + kode pemulihan.
// Tanpa dependensi eksternal; hanya memakai modul crypto bawaan Node.
// =============================================

const crypto = require("crypto");

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str || "")
    .toUpperCase()
    .replace(/[\s=-]/g, "");
  if (!clean) return Buffer.alloc(0);
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("Karakter base32 tidak valid.");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// Secret default 20 byte (160 bit) -> 32 karakter base32.
function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

function hotp(secret, counter, { digits = 6, algo = "sha1" } = {}) {
  const key = Buffer.isBuffer(secret) ? secret : base32Decode(secret);
  if (!key || key.length === 0) throw new Error("Secret TOTP kosong.");
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac(algo, key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 10 ** digits).padStart(digits, "0");
}

function counterFor(timeMs, step) {
  return Math.floor(timeMs / 1000 / step);
}

function totp(secret, { t = Date.now(), step = 30, digits = 6, algo = "sha1" } = {}) {
  return hotp(secret, counterFor(t, step), { digits, algo });
}

// Verifikasi kode TOTP. Mengembalikan nomor step yang cocok, atau null.
// window=1 -> menerima step sekarang, sebelum, dan sesudah (toleransi jam).
function verifyTotp(secret, token, { t = Date.now(), step = 30, digits = 6, algo = "sha1", window = 1 } = {}) {
  const code = String(token || "").replace(/\D/g, "");
  if (code.length !== digits) return null;
  try {
    if (base32Decode(secret).length === 0) return null;
  } catch (e) {
    return null;
  }
  const now = counterFor(t, step);
  for (let i = -window; i <= window; i += 1) {
    const c = now + i;
    const expected = hotp(secret, c, { digits, algo });
    if (timingSafeEqual(code, expected)) return c;
  }
  return null;
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// --- Kode pemulihan (recovery codes) ---
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // tanpa karakter ambigu

function generateRecoveryCodes(count = 10, groupLen = 5) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    let raw = "";
    for (let j = 0; j < groupLen * 2; j++) {
      raw += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
    }
    codes.push(raw.slice(0, groupLen) + "-" + raw.slice(groupLen));
  }
  return codes;
}

function normalizeRecoveryCode(code) {
  return String(code || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

// URI otpauth:// untuk aplikasi autentikator.
function otpauthUri({ secret, label = "Admin", issuer = "Live Chat Dinkes" }) {
  const enc = encodeURIComponent;
  return (
    "otpauth://totp/" +
    enc(issuer) +
    ":" +
    enc(label) +
    "?secret=" +
    enc(secret) +
    "&issuer=" +
    enc(issuer) +
    "&algorithm=SHA1&digits=6&period=30"
  );
}

module.exports = {
  base32Encode,
  base32Decode,
  generateSecret,
  hotp,
  totp,
  verifyTotp,
  generateRecoveryCodes,
  normalizeRecoveryCode,
  otpauthUri,
};
