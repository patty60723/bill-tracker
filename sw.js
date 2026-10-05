// 離線快取:app 本體先用快取、背景更新;OCR 等外部 CDN 資源不快取(交給瀏覽器)。
const CACHE = 'bill-tracker-v1';
const ASSETS = [
  './', 'index.html', 'style.css', 'manifest.webmanifest', 'icon.svg',
  'src/app.js', 'src/db.js', 'src/dates.js', 'src/parse.js', 'src/schedule.js', 'src/ics.js', 'src/scan.js',
  'vendor/zxing-reader.js', 'vendor/zxing_reader.wasm',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request).then((res) => {
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    }).catch(() => cached);
    return cached || fresh;
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((list) => (
    list.length ? list[0].focus() : self.clients.openWindow('./')
  )));
});
