// Offline cache. J2's basement has no signal and the app has to open anyway.
const CACHE = 'utdining-v4'
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'recommend.mjs', 'cronometer.mjs', 'manifest.json']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return

  // The menu changes daily, so always prefer the network and fall back to the last
  // copy. Never serve a stale menu when a fresh one is reachable.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone()
        caches.open(CACHE).then((c) => c.put(e.request, copy))
        return res
      })
      .catch(() => caches.match(e.request).then((hit) => hit ?? caches.match('index.html'))),
  )
})
