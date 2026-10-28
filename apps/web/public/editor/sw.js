// Studio service worker: the app works offline once loaded, and installs as an app.
//
// `cargo xtask web` fills in the build's file list and version. Every file is precached into a
// cache named after the version, served cache-first (responses keep the server's headers, so
// the page stays cross-origin isolated: COOP/COEP) — except the boot shell (index.html
// navigations), which is network-first so shell fixes reach returning users on the first
// reload after a deploy. Old versions are dropped once the new one activates. Network fetches
// use `cache: "reload"`: a browser whose HTTP cache still holds a year-long immutable entry
// for the stable-named engine files (the pre-fix deploy policy) must not serve those stale
// bytes THROUGH this worker's own fetch() — reload forces the origin roundtrip once per file
// per build, and this version-named cache absorbs every load after that. Anything else
// same-origin is fetched from the network and cached for next time.
const VERSION = "9bda4682a68c9a08";
const FILES = ["./", "./audio-worklet.js", "./favicon.svg", "./icon-256.png", "./icon-512.png", "./index.html", "./manifest.webmanifest", "./snippets/studio-web-a5ffdaaf7935c1bb/js/host.js", "./studio_web.js", "./worker.js"];
const CACHE = `studio-${VERSION}`;

// The engine wasm is far too large to precache reliably (browser quota per
// Cache API write caps out and the install fails with ERR_CACHE_WRITE_FAILURE):
// it is cached LAZILY by the fetch handler after the first successful load.
const PRECACHE = FILES.filter((f) => !/\.wasm$/.test(f));

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(PRECACHE.map((f) => new Request(f, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => (k.startsWith("effectcraft-") || k.startsWith("studio-")) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      // The boot shell (navigations, query ignored) is NETWORK-FIRST: a fixed
      // index.html must reach returning users on their first reload after a
      // deploy, not one service-worker update cycle later. The shell is
      // ~14 KB — the wasm stays the lazily-cached heavy asset. Offline (or a
      // non-ok response) falls back to the precached shell.
      if (req.mode === "navigate") {
        const shell = new URL("./", self.registration.scope).href;
        try {
          // cache:"reload" — never let a stale immutable HTTP-cache entry for the
          // stable-named shell answer what must be the freshest deploy.
          const fresh = await fetch(req, { cache: "reload" });
          if (fresh.ok) {
            try {
              await cache.put(new Request(shell, { cache: "reload" }), fresh.clone());
            } catch (e) {
              // A quota/write failure must never break the page load.
              console.warn("sw: shell cache write skipped:", e);
            }
            return fresh;
          }
        } catch {
          // Offline below — the precached shell answers.
        }
        const hit = await cache.match(shell, { ignoreSearch: true });
        if (hit) return hit;
        return fetch(req);
      }
      // Subresources stay cache-first; a miss re-downloads ONCE per build because
      // the worker's own fetch bypasses any poisoned immutable HTTP-cache entry
      // (cache:"reload" — the stable-named wasm + glue are the heavy assets here).
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req, { cache: "reload" });
      // Same-origin successes are cached for next time (the wasm rides this
      // lazy path — one full download, then cached).
      if (res.ok && res.type === "basic") {
        try {
          cache.put(req, res.clone());
        } catch (e) {
          // A quota/write failure must never break the page load.
          console.warn("sw: cache write skipped:", e);
        }
      }
      return res;
    })(),
  );
});
