/**
 * Service worker, so the app opens offline.
 *  - Same-origin files are network-first with a cached fallback, so online
 *    students always get today's code.
 *  - The Supabase client from the CDN is cached too; without it offline was blank.
 *  - Only good responses are cached. Supabase and Gemini are never cached.
 * Bump CACHE on every release.
 */

const CACHE = "markwise-v7";

const CDN = "https://cdn.jsdelivr.net/";

const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./src/css/app.css",
  "./src/css/chat.css",
  "./src/css/workspace.css",
  "./src/assets/fonts/geist-regular.ttf",
  "./src/assets/fonts/geist-semibold.ttf",
  "./src/assets/markwise-icon.svg",
  "./src/assets/markwise-mark.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // Add files one by one so a single missing file can't fail the install.
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Keep a copy of a good response. Never throws. */
function remember(request, response) {
  if (!response || !response.ok) return;
  const copy = response.clone();
  caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;
  const cdn = request.url.startsWith(CDN);
  if (!sameOrigin && !cdn) return;   // Supabase, Gemini, anything else

  event.respondWith(
    fetch(request)
      .then((response) => {
        remember(request, response);
        return response;
      })
      .catch(async () => {
        const hit = await caches.match(request);
        if (hit) return hit;
        // A page navigation with nothing cached falls back to the shell.
        if (request.mode === "navigate") return (await caches.match("./index.html")) ?? Response.error();
        return Response.error();
      }),
  );
});
