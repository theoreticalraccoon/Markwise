/**
 * Markwise service worker.
 *
 * Lets the app open without a network, on a train or in a school with one access
 * point between four hundred students. It is deliberately narrow:
 *
 *  - Same-origin files (the page, the stylesheets, every module) are
 *    NETWORK-FIRST with a cached fallback. The first version served the modules
 *    from cache and only ever refreshed the page, so after a deploy a returning
 *    student got the new index.html running old modules: a mismatched app that
 *    fails in ways nobody can reproduce. Preferring the network means a student
 *    who is online always gets today's code, and the cache only matters when
 *    they are not.
 *  - The Supabase client library is imported from a CDN and is the one thing
 *    the app cannot start without, so that single origin is cached too.
 *    Without it, opening the app offline gave a blank page.
 *  - Only successful responses are cached. A 404 or a 500 must never replace
 *    a good copy.
 *  - Nothing else cross-origin is touched. Supabase and Gemini requests go
 *    straight to the network, because a cached answer to "what do I owe this
 *    week" is worse than an honest failure.
 *
 * Offline you get the app and your session; anything that needs the database
 * says so and fails honestly.
 *
 * Bump CACHE on every release. It is what retires the previous release's files.
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
      // One missing file must not fail the whole install, so each is added
      // individually and a failure is shrugged off.
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
