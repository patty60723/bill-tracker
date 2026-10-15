/**
 * 繳費小幫手:Gmail 帳單收件匣(Google Apps Script)
 *
 * 在你自己的 Google 帳號裡執行,不經過任何第三方伺服器。app 用「網址 + 金鑰」來取件:
 *   ?key=…&action=list        列出 Gmail 標籤「帳單」裡、還沒記錄過的 PDF / 圖片附件
 *   ?key=…&action=get&id=…    下載一個附件(base64)
 *   ?key=…&action=ack&id=…    標成已記錄(之後不會再列出)
 * 設定步驟見同目錄的 README.md。
 */

const LABEL = '帳單'; // Gmail 標籤名稱:用篩選器把電子帳單自動加上這個標籤
const DAYS = 60; // 只看最近幾天的信
const MAX_THREADS = 30;
const MIN_IMAGE_BYTES = 30 * 1024; // 比這小的圖片多半是信裡的 logo,不算帳單

/** 第一次:執行這個函式產生金鑰,在「執行記錄」裡看。 */
function setup() {
  const key = getKey_();
  Logger.log('金鑰:' + key);
  Logger.log('接著「部署 → 新增部署作業 → 網頁應用程式」,執行身分選「我」,存取權選「所有人」。');
  Logger.log('把部署得到的網址後面加上 ?key=' + key + ' 貼到 app 的設定頁。');
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.key !== getKey_()) return json_({ error: 'unauthorized' });
  try {
    if (p.action === 'list') return json_({ items: list_() });
    if (p.action === 'get') return json_(get_(p.id));
    if (p.action === 'ack') {
      ack_(p.id);
      return json_({ ok: true });
    }
    return json_({ ok: true, app: 'bill-tracker-inbox', version: 1, label: LABEL });
  } catch (err) {
    return json_({ error: String(err && err.message || err) });
  }
}

function getKey_() {
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('KEY');
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '');
    props.setProperty('KEY', key);
  }
  return key;
}

function acked_() {
  return JSON.parse(PropertiesService.getScriptProperties().getProperty('ACKED') || '[]');
}

function isBillAttachment_(a) {
  const type = a.getContentType() || '';
  const name = a.getName() || '';
  if (type === 'application/pdf' || /\.pdf$/i.test(name)) return true;
  return type.indexOf('image/') === 0 && a.getSize() >= MIN_IMAGE_BYTES;
}

function list_() {
  const done = acked_();
  const items = [];
  const threads = GmailApp.search('label:' + LABEL + ' has:attachment newer_than:' + DAYS + 'd', 0, MAX_THREADS);
  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (msg) {
      msg.getAttachments({ includeInlineImages: false }).forEach(function (a, i) {
        const id = msg.getId() + ':' + i;
        if (done.indexOf(id) >= 0 || !isBillAttachment_(a)) return;
        items.push({
          id: id,
          subject: msg.getSubject(),
          from: msg.getFrom(),
          date: msg.getDate().toISOString(),
          name: a.getName(),
          type: a.getContentType(),
          size: a.getSize(),
        });
      });
    });
  });
  return items.sort(function (x, y) { return x.date < y.date ? -1 : 1; });
}

function attachment_(id) {
  const parts = String(id || '').split(':');
  const msg = GmailApp.getMessageById(parts[0]);
  const a = msg && msg.getAttachments({ includeInlineImages: false })[Number(parts[1])];
  if (!a) throw new Error('找不到附件 ' + id);
  return a;
}

function get_(id) {
  const a = attachment_(id);
  return { id: id, name: a.getName(), type: a.getContentType(), data: Utilities.base64Encode(a.getBytes()) };
}

function ack_(id) {
  attachment_(id); // 確認存在
  const done = acked_();
  if (done.indexOf(id) < 0) done.push(id);
  // 只留最近 500 筆(更早的信已經超過 DAYS,不會再被列出)
  PropertiesService.getScriptProperties().setProperty('ACKED', JSON.stringify(done.slice(-500)));
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
