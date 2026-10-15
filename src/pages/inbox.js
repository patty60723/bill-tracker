// 收件匣頁:Gmail 標籤「帳單」裡還沒記錄的電子帳單(tools/gmail-inbox/Code.gs 提供)。
// 「全部記錄」會依序打開每一張的新增帳單,有把握的自動存、沒把握的停下來給使用者看。

import { formatDate } from '../dates.js';
import { ackInbox, cachedInboxItems, getInboxUrl, listInbox } from '../inbox.js';
import { confirmDialog } from '../modal.js';
import { $, esc, toast, view } from '../ui/dom.js';
import { go } from '../ui/router.js';

const sender = (from) => (from || '').replace(/<[^>]*>/, '').replace(/"/g, '').trim() || from;

export async function renderInbox() {
  const url = await getInboxUrl();
  view.innerHTML = `
    <header class="page-head"><a class="back" href="#/" aria-label="返回">‹</a><h1>📬 收件匣</h1></header>
    ${url ? '<div id="inbox-list"><p class="muted">讀取中…</p></div>' : `
      <section class="card col">
        <p>還沒設定 Gmail 收件匣。</p>
        <p class="muted small">設定好之後,Gmail 裡標了「帳單」的電子帳單會自動出現在這裡,有把握的會直接記錄。</p>
        <a class="btn primary" href="#/settings">到設定頁設定</a>
      </section>`}`;
  if (!url) return;
  let items;
  try {
    items = await listInbox();
  } catch (e) {
    items = await cachedInboxItems();
    toast(`收件匣連不上,先顯示上次的清單(${e.message})`);
  }
  const box = $('#inbox-list');
  if (!box) return;
  if (!items.length) {
    box.innerHTML = '<div class="empty">沒有新的電子帳單 🎉<br><span class="small">Gmail 裡標了「帳單」、還沒記錄的 PDF 會出現在這裡</span></div>';
    return;
  }
  box.innerHTML = `
    <p class="muted small">${items.length} 張待記錄。「全部記錄」會依序辨識:認得出是哪個固定繳費、條碼或 PDF 文字讀得到金額和截止日的,會自動存;其他的停下來讓你確認。</p>
    <button class="btn primary big" id="inbox-all">全部記錄(${items.length} 張)</button>
    ${items.map((i) => `
      <div class="card row inbox-item">
        <div class="icon">${/pdf/i.test(i.type) || /\.pdf$/i.test(i.name) ? '📄' : '🖼️'}</div>
        <div class="grow">
          <div class="title one-line">${esc(i.subject || i.name)}</div>
          <div class="sub one-line">${esc(sender(i.from))} · ${formatDate(i.date.slice(0, 10))} · ${esc(i.name)}</div>
        </div>
        <div class="actions">
          <a class="btn small primary" href="#/bill/new?inbox=${encodeURIComponent(i.id)}">記錄</a>
          <button class="btn small" data-skip="${esc(i.id)}">略過</button>
        </div>
      </div>`).join('')}`;
  $('#inbox-all').onclick = () => go(`#/bill/new?inbox=${encodeURIComponent(items[0].id)}&chain=1`);
  box.addEventListener('click', async (e) => {
    const id = e.target.closest('[data-skip]')?.dataset.skip;
    if (!id) return;
    if (!(await confirmDialog({ title: '略過這張?', message: '標成已處理,之後不會再出現在收件匣(Gmail 裡的信不會刪)。', ok: '略過' }))) return;
    try {
      await ackInbox(id);
      toast('已略過');
    } catch (err) {
      toast(err.message);
    }
    renderInbox();
  });
}

/** 首頁卡片:收件匣有待記錄的帳單。 */
export function inboxCard(items) {
  if (!items?.length) return '';
  return `<a class="card row reminder info" href="#/inbox">
    <div class="icon">📬</div>
    <div class="grow"><div class="title">收件匣有 ${items.length} 張電子帳單</div><div class="sub">${esc(items.slice(0, 2).map((i) => i.subject || i.name).join('、'))}</div></div>
    <span class="btn small primary">記錄</span>
  </a>`;
}
