// 拿走從別的 app 分享過來的檔案(sw.js 的 receiveShare 放在 SHARE_CACHE)。拿了就刪,避免重新整理又辨識一次。

import { SHARE_CACHE } from '../version.js';

/** @returns {Promise<File[]>} */
export async function takeSharedFiles() {
  if (!('caches' in self)) return [];
  const cache = await caches.open(SHARE_CACHE);
  const files = [];
  for (const req of await cache.keys()) {
    const res = await cache.match(req);
    if (res) {
      const blob = await res.blob();
      const name = decodeURIComponent(res.headers.get('X-File-Name') || 'shared');
      files.push(new File([blob], name, { type: blob.type || res.headers.get('Content-Type') || '' }));
    }
    await cache.delete(req);
  }
  return files;
}
