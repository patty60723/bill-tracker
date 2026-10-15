// 版本號:前端檔案有改就要加 1。service worker 的快取名稱用它(換版本才會清掉舊快取),
// 設定頁最下面也會顯示,方便確認手機上已經是新版。
export const VERSION = 'v46';

// OCR 模型與引擎(vendor/)的快取:不跟著 VERSION 清掉;vendor/ 的檔案換了才改名字(vendor 是 cache-first)。
export const VENDOR_CACHE = 'bill-tracker-vendor-v1';

// 從別的 app「分享」過來的檔案(Gmail 的 PDF 附件等),service worker 先放這裡,帳單表單再拿走。
export const SHARE_CACHE = 'bill-tracker-share';

// Gmail 收件匣下載下來、還沒記錄的帳單附件(src/inbox.js)。背景同步先下載,打開 app 時就不用等。
export const INBOX_CACHE = 'bill-tracker-inbox';
