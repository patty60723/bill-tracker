// Hash 路由與「離開前確認」(表單有沒存的變更時,任何離開方式都先問)。

import { confirmDialog } from '../modal.js';
import { $$, esc, revokeObjectUrls, view } from './dom.js';

export function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

// ---------- 離開前確認 ----------

// 表單頁設定 leaveGuard;有沒存的變更時,任何離開方式(‹ 返回、下方分頁、手機返回鍵)都先確認。
export let leaveGuard = null; // { isDirty: () => boolean, onLeave?: () => void }

export let currentHash = location.hash;

export let askingLeave = false;

/** 有沒存的變更就問要不要離開;確定離開會執行 onLeave(例如清掉沒存的照片)。 */
export async function confirmLeave() {
  return confirmDialog({
    title: '還沒儲存,確定要離開嗎?',
    message: '這張帳單還沒儲存,離開後掃描帶入的資料、輸入的內容和照片都會不見。',
    ok: '離開,不儲存',
    cancel: '繼續編輯',
    danger: true,
  });
}

/** 表單頁用:回傳 markDirty;儲存/刪除成功後呼叫 release() 再跳頁,就不會再問。 */
export function guardForm({ onLeave } = {}) {
  let dirty = false;
  leaveGuard = { isDirty: () => dirty, onLeave };
  return {
    markDirty: () => { dirty = true; },
    isDirty: () => dirty,
    release: () => { leaveGuard = null; },
  };
}

export function parseHash() {
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  return { parts: path.split('/').filter(Boolean), params: new URLSearchParams(query) };
}

export const routes = {};

/** 註冊頁面:{ 路徑第一段: ({ id, params }) => Promise },'' 是首頁(也是找不到時的預設)。 */
export function registerRoutes(table) {
  Object.assign(routes, table);
}

/** 換頁時網址的 query 改了但不想重繪(例如搜尋字)時用:不留瀏覽紀錄,也讓離開前確認知道目前網址。 */
export function replaceHash(hash) {
  history.replaceState(null, '', hash);
  currentHash = location.hash;
}

export async function render() {
  leaveGuard = null; // 每一頁自己決定要不要設
  currentHash = location.hash;
  revokeObjectUrls();
  const { parts, params } = parseHash();
  const [page = '', id] = parts;
  $$('nav.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === (page === 'bill' ? 'bills' : page === 'template' ? 'templates' : page)));
  try {
    await (routes[page] || routes[''])({ id, params });
  } catch (err) {
    console.error(err);
    view.innerHTML = `<div class="empty">發生錯誤:${esc(err.message)}</div>`;
  }
  window.scrollTo(0, 0);
}

/** 程式裡要換頁時用:有沒存的變更就先問。 */
export async function navigate(hash) {
  if (leaveGuard?.isDirty()) {
    if (askingLeave) return;
    askingLeave = true;
    const leave = await confirmLeave();
    askingLeave = false;
    if (!leave) return;
    leaveGuard.onLeave?.();
    leaveGuard = null;
  }
  go(hash);
}

/** 掛上路由需要的全域事件(連結點擊、網址變化、關閉頁面)。 */
export function startRouter() {
  // 點連結 / 下方分頁:在瀏覽器換頁「之前」攔下來問,這樣取消時不會多出一筆瀏覽紀錄
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a || !leaveGuard?.isDirty() || a.getAttribute('href') === location.hash) return;
    e.preventDefault();
    navigate(a.getAttribute('href'));
  }, true);

  // 手機返回鍵 / 返回手勢:網址已經變了,只能事後把它改回來再問
  window.addEventListener('hashchange', async () => {
    if (leaveGuard?.isDirty()) {
      // 先把網址改回來(不觸發 hashchange,畫面和資料都不動),再問要不要離開
      const target = location.hash;
      history.replaceState(null, '', currentHash || '#/');
      if (askingLeave) return;
      askingLeave = true;
      const leave = await confirmLeave();
      askingLeave = false;
      if (!leave) return;
      leaveGuard.onLeave?.();
      leaveGuard = null;
      location.hash = target; // 這次沒有 guard 了,會正常換頁
      return;
    }
    render();
  });
  // 重新整理 / 關掉分頁:瀏覽器只允許顯示它自己的確認視窗
  window.addEventListener('beforeunload', (e) => {
    if (leaveGuard?.isDirty()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}
