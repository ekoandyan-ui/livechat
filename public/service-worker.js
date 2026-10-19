/* =============================================
 * Service Worker - Web Push notifikasi pesan baru
 * - Menampilkan notifikasi generik (tanpa data pasien/PHI).
 * - Bila ada tab aplikasi yang terlihat, kirim pesan ke tab (real-time
 *   sudah menangani UI) dan TIDAK menampilkan notifikasi OS.
 * - Tidak meng-cache halaman chat/admin/API.
 * ============================================= */

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Titik masuk push dari server
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = {};
  }

  const title = payload.title || "Live Chat";
  const body = payload.body || "Ada pesan baru di Live Chat";
  const url = typeof payload.url === "string" ? payload.url : "/";
  const tag = typeof payload.tag === "string" ? payload.tag : "live-chat";

  event.waitUntil(
    (async () => {
      // Bila ada tab aplikasi yang terlihat, jangan tampilkan notifikasi OS;
      // cukup beri tahu tab (badge/refresh sudah jalan lewat Socket.IO).
      let visibleClients = [];
      try {
        const all = await self.clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        });
        visibleClients = all.filter((c) => c.visibilityState === "visible");
        // Kirim sinyal ke semua tab (yang terlihat maupun tidak).
        all.forEach((c) =>
          c.postMessage({ type: "push-message", tag, url }),
        );
      } catch (e) {
        visibleClients = [];
      }

      if (visibleClients.length > 0) return; // tab aktif -> tanpa notifikasi OS

      await self.registration.showNotification(title, {
        body,
        tag,
        data: { url },
        icon: "/icon.svg",
        badge: "/icon.svg",
      });
    })(),
  );
});

// Klik notifikasi -> fokus tab yang sudah terbuka atau buka URL chat
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target =
    (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // Fokuskan tab same-origin yang sudah ada bila memungkinkan.
      for (const client of all) {
        if ("focus" in client) {
          try {
            await client.focus();
            if ("navigate" in client) {
              try {
                await client.navigate(target);
              } catch (e) {}
            }
            return;
          } catch (e) {}
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(target);
    })(),
  );
});
