// Studio service worker: the app works offline once loaded, and installs as an app.
//
// `cargo xtask web` fills in the build's file list and version. Every file is precached into a
// cache named after the version, served cache-first (responses keep the server's headers, so
// the page stays cross-origin isolated: COOP/COEP), and old versions are dropped once the new
// one activates. Anything else same-origin is fetched from the network and cached for next time.
const VERSION = "__EC_VERSION__";
const FILES = __EC_FILES__;
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
      // The page itself regardless of its query (?empty, ?demo…).
      const key = req.mode === "navigate" ? new URL("./", self.registration.scope).href : req;
      const hit = await cache.match(key, { ignoreSearch: req.mode === "navigate" });
      if (hit) return hit;
      const res = await fetch(req);
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
