// Offline cache. J2's basement has no signal and the app has to open anyway.
const CACHE = 'utdining-v7'
const SHELL = [
  './', 'index.html', 'style.css', 'app.js',
  'recommend.mjs', 'cronometer.mjs', 'nutrition.mjs', 'label.mjs', 'manifest.json',
]

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

/**
 * Whether a response is really the JSON that was asked for.
 *
 * Campus guest WiFi and any login gate in front of this site answer EVERY request with
 * their own page — 200 OK, HTML, usually after a redirect. Caching that as menu.json
 * replaces the menu with a login form until the cache is cleared by hand, and the failure
 * lands exactly when the app is needed: standing in the servery with bad signal.
 *
 * Only JSON is checked this strictly. A navigation must be allowed through even when it
 * returns a login page, or there would be no way to log in.
 */
function isRealJson(request, res) {
  if (!new URL(request.url).pathname.endsWith('.json')) return true
  if (!res.ok || res.redirected) return false
  return (res.headers.get('content-type') ?? '').includes('json')
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return

  // The menu changes daily, so always prefer the network and fall back to the last
  // copy. Never serve a stale menu when a fresh one is reachable.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        // Falls through to the cache: the last good menu beats a captive portal's HTML.
        if (!isRealJson(e.request, res)) throw new Error('not the JSON we asked for')
        const copy = res.clone()
        caches.open(CACHE).then((c) => c.put(e.request, copy))
        return res
      })
      .catch(() => caches.match(e.request).then((hit) => {
        if (hit) return hit
        // index.html is the right last resort for a navigation and the wrong one for data:
        // handing HTML to a JSON fetch produces "Unexpected token '<'", which reads like a
        // parser bug rather than "you are offline".
        if (new URL(e.request.url).pathname.endsWith('.json')) {
          return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } })
        }
        return caches.match('index.html')
      })),
  )
})
