// Gmail 帳單收件匣:跟使用者自己 Google 帳號裡的 Apps Script(tools/gmail-inbox/Code.gs)取件。
// 頁面和 service worker(背景同步)共用,所以不碰 DOM。
//   meta inboxUrl   :Apps Script 網頁應用程式網址(含 ?key=…)
//   meta inboxItems :上次列出的待記錄附件 [{ id, subject, from, date, name, type, size }]
//   meta inboxSeen  :已經通知過的 id(背景同步只通知新的)
//   INBOX_CACHE     :已下載的附件

import * as db from './db.js';
import { INBOX_CACHE } from './version.js';

const cacheKey = (id) => new URL(`inbox/${encodeURIComponent(id)}`, self.location.href).href;

async function call(base, params = {}) {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  // 不加任何自訂 header:Apps Script 只接受「簡單請求」的 CORS
  const res = await fetch(url.href, { cache: 'no-store' });
  if (!res.ok) throw new Error(`收件匣連不上(HTTP ${res.status})`);
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error('收件匣回傳的不是預期的格式,請確認網址是 Apps Script 部署出來的「網頁應用程式」網址');
  }
  if (body.error) throw new Error(body.error === 'unauthorized' ? '金鑰不對:網址後面的 ?key=… 要跟 Apps Script 的金鑰一樣' : body.error);
  return body;
}

export const getInboxUrl = async () => (await db.getMeta('inboxUrl')) || '';

/** 設定頁「測試連線」:成功回傳 { label, count }。 */
export async function testInbox(url) {
  const info = await call(url);
  if (info.app !== 'bill-tracker-inbox') throw new Error('這不是繳費小幫手的收件匣網址');
  const { items } = await call(url, { action: 'list' });
  return { label: info.label, count: items.length };
}

/** 列出待記錄的附件,存一份在 meta(首頁卡片、離線時用)。沒設定回傳 null。 */
export async function listInbox() {
  const url = await getInboxUrl();
  if (!url) return null;
  const { items } = await call(url, { action: 'list' });
  await db.setMeta('inboxItems', items);
  return items;
}

export const cachedInboxItems = async () => (await db.getMeta('inboxItems')) || [];

/** 拿一個附件(先看快取)。回傳 File。 */
export async function inboxFile(item) {
  const cache = await caches.open(INBOX_CACHE);
  let res = await cache.match(cacheKey(item.id));
  if (!res) {
    const { data, type, name } = await call(await getInboxUrl(), { action: 'get', id: item.id });
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    res = new Response(new Blob([bytes], { type: type || item.type || '' }), { headers: { 'X-File-Name': encodeURIComponent(name || item.name) } });
    await cache.put(cacheKey(item.id), res.clone());
  }
  const blob = await res.blob();
  const name = decodeURIComponent(res.headers.get('X-File-Name') || item.name || 'bill');
  return new File([blob], name, { type: blob.type || item.type || '' });
}

/** 標成已記錄(Gmail 那邊之後不會再列出),刪掉快取。 */
export async function ackInbox(id) {
  await call(await getInboxUrl(), { action: 'ack', id });
  await (await caches.open(INBOX_CACHE)).delete(cacheKey(id));
  await db.setMeta('inboxItems', (await cachedInboxItems()).filter((i) => i.id !== id));
}

/**
 * 背景同步用:列出、先下載還沒下載的,回傳這次新出現(還沒通知過)的附件。
 * 失敗(沒網路、沒設定)回傳 []。
 */
export async function syncInboxInBackground() {
  try {
    const items = await listInbox();
    if (!items?.length) return [];
    for (const item of items) await inboxFile(item).catch(() => {});
    const seen = (await db.getMeta('inboxSeen')) || [];
    const fresh = items.filter((i) => !seen.includes(i.id));
    await db.setMeta('inboxSeen', [...seen, ...fresh.map((i) => i.id)].slice(-500));
    return fresh;
  } catch {
    return [];
  }
}
