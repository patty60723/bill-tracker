// Service worker(以 module 形式註冊):
// 1. 離線可用:app 檔案先走網路(每次都跟伺服器確認)、失敗才用快取(這樣更新後馬上是新版)。
//    版本號在 src/version.js,前端有改就要加 1。
//    OCR 的大檔(vendor/paddle/、vendor/tesseract/)不預先下載,第一次用到時存進 VENDOR_CACHE(不隨版本清掉)。
// 2. 背景提醒:Android Chrome 把 app 加到主畫面後,瀏覽器會定期(大約一天一次以上,時間由瀏覽器決定)
//    用 periodicsync 叫醒這裡,有快截止、逾期、該拿繳費單的帳單就跳通知。
import { notifyReminders, SYNC_TAG } from './src/notify.js';
import { VENDOR_CACHE, VERSION } from './src/version.js';

const CACHE = `bill-tracker-${VERSION}`;
// vendor/(OCR 模型、引擎)放在另一個快取 VENDOR_CACHE(src/version.js),不跟著 app 版本清掉。
// 實測:放在一起時每次發新版,手機都要重新下載 22 MB 的 PaddleOCR 模型。
const ASSETS = [
  './', 'index.html', 'style.css', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png',
  'icon-maskable-512.png', 'badge-96.png',
  'src/app.js', 'src/backup.js', 'src/dates.js', 'src/db.js', 'src/enhance.js', 'src/ics.js',
  'src/livescan.js', 'src/modal.js', 'src/notify.js', 'src/pages/bill-form.js', 'src/pages/bills.js',
  'src/pages/home.js', 'src/pages/settings.js', 'src/pages/templates.js', 'src/paddle.js', 'src/parse.js', 'src/pdf.js', 'src/profiles.js', 'src/scan.js',
  'src/schedule.js', 'src/stats.js', 'src/ui/actions.js', 'src/ui/components.js', 'src/ui/dom.js',
  'src/ui/notifications.js', 'src/ui/router.js', 'src/ui/scan-view.js', 'src/version.js',
  'vendor/zxing-reader.js', 'vendor/zxing_reader.wasm',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== VENDOR_CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// 加上 COOP/COEP:頁面變成 crossOriginIsolated,PaddleOCR(onnxruntime-web)才能用多執行緒(實測快 2–3 倍)。
// GitHub Pages 不能自訂標頭,所以由 service worker 補。app 沒有用任何外站資源,require-corp 不會擋到東西。
function withIsolation(res) {
  if (!res || res.type === 'opaque' || res.status === 0) return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/vendor/')) {
    e.respondWith(vendorFile(e));
    return;
  }
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      // 一律跟伺服器確認是不是最新的(沒變只回 304,很省):GitHub Pages 讓瀏覽器快取 10 分鐘,
      // 不加的話更新後可能還拿到舊檔,甚至新舊檔混用。
      const res = e.request.mode === 'navigate'
        ? await fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' })
        : await fetch(e.request, { cache: 'no-cache' });
      if (res.ok) e.waitUntil(cache.put(e.request, res.clone()));
      return withIsolation(res);
    } catch (err) {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      if (cached) return withIsolation(cached);
      throw err;
    }
  })());
});

/**
 * vendor/ 的檔案不會變:先用快取(任何一個,app shell 預先快取的 zxing 也算),沒有才下載並存進 VENDOR_CACHE。
 * 寫快取用 waitUntil:不然瀏覽器可能在 22 MB 的模型寫完前就把 service worker 停掉,下次又要重新下載。
 */
async function vendorFile(e) {
  const cached = await caches.match(e.request, { ignoreSearch: true });
  if (cached) return withIsolation(cached);
  const res = await fetch(e.request);
  if (res.ok) e.waitUntil(caches.open(VENDOR_CACHE).then((c) => c.put(e.request, res.clone())));
  return withIsolation(res);
}

self.addEventListener('periodicsync', (e) => {
  if (e.tag === SYNC_TAG) e.waitUntil(notifyReminders(self.registration, { background: true }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => (
    list.length ? list[0].focus() : self.clients.openWindow('./')
  )));
});
