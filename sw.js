// Service worker(以 module 形式註冊):
// 1. 離線可用:app 檔案先走網路、失敗才用快取(這樣更新後馬上是新版)。
//    OCR 的大檔(vendor/tesseract/)不預先下載,第一次用到時由 fetch 順便快取。
// 2. 背景提醒:Android Chrome 把 app 加到主畫面後,瀏覽器會定期(大約一天一次以上,時間由瀏覽器決定)
//    用 periodicsync 叫醒這裡,有快截止、逾期、該拿繳費單的帳單就跳通知。
import { notifyReminders, SYNC_TAG } from './src/notify.js';

const CACHE = 'bill-tracker-v3';
const ASSETS = [
  './', 'index.html', 'style.css', 'manifest.webmanifest', 'icon.svg',
  'src/app.js', 'src/db.js', 'src/dates.js', 'src/parse.js', 'src/schedule.js', 'src/ics.js', 'src/scan.js',
  'src/notify.js', 'vendor/zxing-reader.js', 'vendor/zxing_reader.wasm',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(e.request);
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch (err) {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      if (cached) return cached;
      throw err;
    }
  })());
});

self.addEventListener('periodicsync', (e) => {
  if (e.tag === SYNC_TAG) e.waitUntil(notifyReminders(self.registration, { background: true }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => (
    list.length ? list[0].focus() : self.clients.openWindow('./')
  )));
});
