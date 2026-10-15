// 版本號:前端檔案有改就要加 1。service worker 的快取名稱用它(換版本才會清掉舊快取),
// 設定頁最下面也會顯示,方便確認手機上已經是新版。
export const VERSION = 'v44';

// OCR 模型與引擎(vendor/)的快取:不跟著 VERSION 清掉;vendor/ 的檔案換了才改名字(vendor 是 cache-first)。
export const VENDOR_CACHE = 'bill-tracker-vendor-v1';
