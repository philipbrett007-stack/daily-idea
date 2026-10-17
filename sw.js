/* Daily Idea service worker: keeps the app working offline.
   App files: cache first (bump VERSION when they change). Idea files: network first, cached copy when offline. */
const VERSION = "daily-idea-v2";
const SHELL = ["./", "index.html", "styles.css", "app.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "icons/apple-touch-icon.png"];
const RUNTIME = "daily-idea-runtime";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== RUNTIME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request) {
  const cache = await caches.open(RUNTIME);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;
  const fresh = await fetch(request);
  if (fresh && (fresh.ok || fresh.type === "opaque")) {
    const cache = await caches.open(RUNTIME);
    cache.put(request, fresh.clone());
  }
  return fresh;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.includes("/ideas/")) { event.respondWith(networkFirst(req)); return; }
    if (req.mode === "navigate") {
      event.respondWith(fetch(req).catch(() => caches.match("index.html")));
      return;
    }
    event.respondWith(cacheFirst(req));
    return;
  }

  // Fonts and video thumbnails: keep a copy so they show offline.
  if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname) || url.hostname === "i.ytimg.com") {
    event.respondWith(cacheFirst(req));
  }
});
