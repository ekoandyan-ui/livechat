#!/usr/bin/env node
// =============================================
// SMOKE TEST: Rate limit pendaftaran pasien (/tambah)
//
// Node 18+ (fetch bawaan), tanpa dependensi tambahan.
//
// Jalankan HANYA terhadap server lokal/dev dengan database DEV:
//   node scripts/smoke-register-limit.js
//   BASE_URL=http://127.0.0.1:8000 node scripts/smoke-register-limit.js
//
// Keamanan: skrip menolak berjalan bila BASE_URL bukan localhost/127.0.0.1,
// kecuali env ALLOW_REMOTE=1 diset.
//
// Catatan: skenario C memerlukan kuota register > 30 dalam satu window.
// Bila memakai store bersama (Redis) atau sudah ada trafik lain, hasil bisa
// berbeda. Untuk mengulang: restart server (MemoryStore) atau hapus kunci
// Redis berawalan "lc:rl:".
//
// Data uji memakai nama berawalan "[SMOKE]". Bersihkan setelah selesai (dev):
//   DELETE FROM patients WHERE nama LIKE '[SMOKE]%';
// =============================================

const RAW_BASE = process.env.BASE_URL || `http://localhost:${process.env.PORT || 8000}`;
const BASE = RAW_BASE.replace(/\/+$/, "");

function assertLocal() {
  let host;
  try {
    host = new URL(BASE).hostname;
  } catch {
    console.error(`BASE_URL tidak valid: ${BASE}`);
    process.exit(1);
  }
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (!isLocal && process.env.ALLOW_REMOTE !== "1") {
    console.error(
      `Menolak berjalan terhadap host non-lokal "${host}". ` +
        "Set ALLOW_REMOTE=1 bila memang diinginkan (tidak disarankan).",
    );
    process.exit(1);
  }
}

// ---------- Cookie jar sederhana ----------
function mergeCookies(jar, res) {
  const setCookies =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie")].filter(Boolean);
  for (const sc of setCookies) {
    if (!sc) continue;
    const pair = sc.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name) jar.set(name, value);
  }
}
function cookieHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function http(method, path, { jar, form, headers = {} } = {}) {
  const h = { ...headers };
  if (jar && jar.size) h.cookie = cookieHeader(jar);
  let body;
  if (form) {
    h["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(form).toString();
  }
  const res = await fetch(BASE + path, { method, headers: h, body, redirect: "manual" });
  if (jar) mergeCookies(jar, res);
  const text = await res.text();
  return { status: res.status, location: res.headers.get("location"), text, res };
}

function extractCsrf(html) {
  const m = html.match(/name="_csrf"\s+value="([^"]+)"/);
  return m ? m[1] : "";
}
function extractHospitals(html) {
  const opts = [...html.matchAll(/<option value="([^"]+)"[^>]*>([^<]*)<\/option>/g)]
    .map((m) => m[2].trim())
    .filter((v) => v && v !== "Pilih Rumah Sakit");
  return opts;
}

let randCounter = 0;
function uniqueWa() {
  randCounter += 1;
  const rnd = Math.floor(Math.random() * 1e12).toString().padStart(12, "0");
  return "08" + rnd.slice(0, 11) + String(randCounter % 10);
}

// Sesi baru: GET / -> jar + csrf
async function newSession() {
  const jar = new Map();
  const g = await http("GET", "/", { jar });
  const csrf = extractCsrf(g.text);
  const hospitals = extractHospitals(g.text);
  return { jar, csrf, hospitals };
}

async function postTambah(session, fields, extraHeaders = {}) {
  return http("POST", "/tambah", {
    jar: session.jar,
    headers: extraHeaders,
    form: { _csrf: session.csrf, ...fields },
  });
}

// Muat ulang GET / untuk menyegarkan CSRF pada jar yang sama (meniru reload
// halaman sebelum menekan tombol lagi). Sesi/cookie pasien tetap sama.
async function refreshCsrf(session) {
  const g = await http("GET", "/", { jar: session.jar });
  const csrf = extractCsrf(g.text);
  if (csrf) session.csrf = csrf;
  return csrf;
}

// ---------- Runner hasil ----------
const results = [];
function record(code, name, pass, detail = "") {
  results.push({ code, name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  [${code}] ${name}${detail ? "  -> " + detail : ""}`);
}

async function main() {
  assertLocal();
  console.log(`Smoke test limit pendaftaran terhadap ${BASE}\n`);

  const seed = await newSession();
  if (!seed.csrf) {
    console.error("Tidak bisa mengambil CSRF dari GET / — pastikan server berjalan.");
    process.exit(1);
  }
  if (seed.hospitals.length === 0) {
    console.error("Tidak ada opsi rumah sakit pada GET /.");
    process.exit(1);
  }
  const RS = seed.hospitals[0];
  console.log(`Rumah sakit uji: "${RS}"\n`);

  // Urutan eksekusi: A, D, E (netral kuota) lebih dulu, lalu B, C yang
  // benar-benar menghabiskan kuota registrasi. Ini menjaga skenario D/E tidak
  // "tertelan" 429 dari window yang sama saat dijalankan berurutan.

  // ---------- Skenario A ----------
  {
    const s = await newSession();
    const wa = uniqueWa();
    const first = await postTambah(s, {
      nama: `[SMOKE] A ${wa}`,
      alamat: "Alamat uji",
      nomor_wa: wa,
      rumah_sakit: RS,
    });
    const firstLoc = (first.location || "").replace(/\/$/, "");
    let ok = first.status === 302 && /\/chat\//.test(firstLoc);
    let allSame = true;
    let any429 = false;
    for (let i = 0; i < 10; i++) {
      await refreshCsrf(s); // meniru reload halaman (CSRF dirotasi saat regenerate)
      const r = await postTambah(s, {
        nama: `[SMOKE] A ${wa}`,
        alamat: "Alamat uji",
        nomor_wa: wa,
        rumah_sakit: RS,
      });
      if (r.status === 429) any429 = true;
      if (r.status !== 302 || r.location.replace(/\/$/, "") !== firstLoc) allSame = false;
    }
    record("A", "Pasien lama submit 10x (jar sama) tanpa 429", ok && allSame && !any429,
      `first=${first.status} same=${allSame} any429=${any429}`);
  }

  // ---------- Skenario D ----------
  {
    let all400 = true;
    let any429 = false;
    let failed = "";
    for (let i = 0; i < 40; i++) {
      const s = await newSession();
      const r = await postTambah(s, {
        nama: `[SMOKE] D ${i}`,
        alamat: "Alamat uji",
        nomor_wa: uniqueWa(),
        rumah_sakit: "RS Tidak Valid " + i,
      });
      if (r.status === 429) any429 = true;
      if (r.status !== 400) {
        all400 = false;
        failed = `i=${i} status=${r.status}`;
        break;
      }
    }
    record("D", "40 request rumah_sakit invalid -> semua 400, tanpa 429", all400 && !any429,
      failed || `any429=${any429}`);
  }

  // ---------- Skenario E ----------
  {
    const base = "0812345678" + Math.floor(Math.random() * 100).toString().padStart(2, "0");
    const plus = "+62" + base.slice(1);
    const intl = "62" + base.slice(1);

    const s1 = await newSession();
    const r1 = await postTambah(s1, { nama: `[SMOKE] E ${base}`, alamat: "Alamat uji", nomor_wa: base, rumah_sakit: RS });

    const s2 = await newSession();
    const r2 = await postTambah(s2, { nama: `[SMOKE] E ${plus}`, alamat: "Alamat uji", nomor_wa: plus, rumah_sakit: RS });

    const s3 = await newSession();
    const r3 = await postTambah(s3, { nama: `[SMOKE] E ${intl}`, alamat: "Alamat uji", nomor_wa: intl, rumah_sakit: RS });

    const l1 = (r1.location || "").replace(/\/$/, "");
    const l2 = (r2.location || "").replace(/\/$/, "");
    const l3 = (r3.location || "").replace(/\/$/, "");
    const same = l1 && l1 === l2 && l2 === l3;
    record("E", "Variasi nomor WA (0812/+62812/62812) -> room yang sama", same,
      `l1=${l1} l2=${l2} l3=${l3}`);
  }

  // ---------- Skenario B ----------
  {
    let all302 = true;
    let failed = "";
    for (let i = 0; i < 20; i++) {
      const s = await newSession();
      const wa = uniqueWa();
      const r = await postTambah(s, {
        nama: `[SMOKE] B ${i} ${wa}`,
        alamat: "Alamat uji",
        nomor_wa: wa,
        rumah_sakit: RS,
      });
      if (r.status !== 302 || !/\/chat\//.test(r.location || "")) {
        all302 = false;
        failed = `i=${i} status=${r.status} loc=${r.location}`;
        break;
      }
    }
    record("B", "20 pasien baru berbeda dari satu IP -> semua 302", all302, failed);
  }

  // ---------- Skenario C ----------
  {
    let limitHit = false;
    let htmlRes = null;
    let jsonRes = null;
    for (let i = 0; i < 20; i++) {
      const s = await newSession();
      const wa = uniqueWa();
      const r = await postTambah(s, {
        nama: `[SMOKE] C ${i} ${wa}`,
        alamat: "Alamat uji",
        nomor_wa: wa,
        rumah_sakit: RS,
      });
      if (r.status === 429) limitHit = true;
    }
    // Paksa satu request HTML dan satu JSON untuk memeriksa bentuk respons.
    const sHtml = await newSession();
    htmlRes = await postTambah(
      sHtml,
      { nama: `[SMOKE] C html ${uniqueWa()}`, alamat: "Alamat uji", nomor_wa: uniqueWa(), rumah_sakit: RS },
      { accept: "text/html" },
    );
    const sJson = await newSession();
    jsonRes = await postTambah(
      sJson,
      { nama: `[SMOKE] C json ${uniqueWa()}`, alamat: "Alamat uji", nomor_wa: uniqueWa(), rumah_sakit: RS },
      { accept: "application/json" },
    );

    const got429 = htmlRes.status === 429 || jsonRes.status === 429 || limitHit;
    const htmlFriendly =
      htmlRes.status === 429 &&
      htmlRes.text.includes("Terlalu banyak percobaan") &&
      /value="[^"]*"/.test(htmlRes.text); // field form terisi
    const jsonHasError =
      jsonRes.status === 429 &&
      /"error"\s*:\s*"/.test(jsonRes.text);

    record("C", "Setelah >30 pendaftaran muncul 429 ramah (HTML) & JSON", got429 && htmlFriendly && jsonHasError,
      `limitHit=${limitHit} html429=${htmlRes.status} htmlFriendly=${htmlFriendly} json429=${jsonRes.status} jsonErr=${jsonHasError}`);
  }

  // ---------- Ringkasan ----------
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n=== Ringkasan: ${passed}/${results.length} PASS ===`);
  for (const r of results) console.log(`  ${r.pass ? "PASS" : "FAIL"}  [${r.code}] ${r.name}`);

  console.log("\nBersihkan data uji di database DEV (jalankan manual):");
  console.log("  DELETE FROM patients WHERE nama LIKE '[SMOKE]%';");

  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error("Error smoke test:", err.message);
  process.exit(1);
});
