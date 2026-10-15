// 自製對話框,取代瀏覽器原生的 confirm / alert / prompt(樣式跟 app 一致、深淺色都對,
// 按鈕直接寫動作,例如「離開」「另一張帳單」,不用再解釋「確定代表什麼」)。

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

/**
 * 通用對話框。
 * @param title    標題
 * @param message  內文(純文字,換行會保留)
 * @param actions  [{ label, value, kind?: 'primary' | 'danger', desc? }],由上而下(或由左而右)排列
 * @param cancelValue  按 Esc、點外面時回傳的值
 * @param stacked  按鈕直排(選項有說明文字時用)
 * @returns Promise<any> 被按的 action 的 value
 */
export function ask({ title, message = '', actions, cancelValue = null, stacked = false, extra = '' }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'modal';
    dlg.innerHTML = `
      <form method="dialog" class="modal-body">
        ${title ? `<h3 class="modal-title">${esc(title)}</h3>` : ''}
        ${message ? `<p class="modal-message">${esc(message)}</p>` : ''}
        ${extra}
        <div class="modal-actions ${stacked || actions.length > 2 ? 'stacked' : ''}">
          ${actions.map((a, i) => `<button type="button" class="btn ${a.kind || ''} ${a.desc ? 'with-desc' : ''}" data-i="${i}">
            <span>${esc(a.label)}</span>${a.desc ? `<small>${esc(a.desc)}</small>` : ''}
          </button>`).join('')}
        </div>
      </form>`;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      dlg.close();
      dlg.remove();
      resolve(value);
    };
    // value 可以是函式:按下時才算(例如讀對話框裡輸入框的值)
    const valueOf = (a) => (typeof a.value === 'function' ? a.value(dlg) : a.value);
    dlg.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-i]');
      if (btn) finish(valueOf(actions[Number(btn.dataset.i)]));
      else if (e.target === dlg) finish(cancelValue); // 點到對話框外面(backdrop)
    });
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(cancelValue); });
    // 在輸入框按 Enter:等於按主要按鈕
    dlg.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const primary = actions.find((a) => a.kind === 'primary');
      if (primary) finish(valueOf(primary));
    });
    document.body.append(dlg);
    dlg.showModal();
    // 有輸入框就先聚焦輸入框;危險動作時,預設焦點放在「取消」那一顆,避免誤按 Enter
    const input = dlg.querySelector('input:not([type=checkbox])');
    const safe = actions.findIndex((a) => a.value === cancelValue);
    (input || dlg.querySelector(`[data-i="${safe >= 0 ? safe : 0}"]`))?.focus();
  });
}

/** 確認:回傳 true / false。danger 時確認鈕是紅色。 */
export function confirmDialog({ title, message, ok = '確定', cancel = '取消', danger = false }) {
  return ask({
    title,
    message,
    cancelValue: false,
    actions: [
      { label: cancel, value: false },
      { label: ok, value: true, kind: danger ? 'danger-solid' : 'primary' },
    ],
  });
}

/** 提示:只有一顆「知道了」。 */
export function alertDialog({ title, message, ok = '知道了' }) {
  return ask({ title, message, cancelValue: undefined, actions: [{ label: ok, value: undefined, kind: 'primary' }] });
}

/** 顯示一段文字讓使用者自己長按複製(剪貼簿不能用時)。 */
export function copyDialog({ title, text }) {
  const p = ask({
    title,
    message: '長按下面的文字選取後複製。',
    extra: `<input class="modal-copy" readonly value="${esc(text)}">`,
    cancelValue: undefined,
    actions: [{ label: '關閉', value: undefined, kind: 'primary' }],
  });
  document.querySelector('dialog.modal:last-of-type .modal-copy')?.select();
  return p;
}

/**
 * 輸入密碼(PDF 電子帳單)。回傳 { password, remember },取消回傳 null。
 * 「記住這個密碼」預設不勾:要不要把密碼存在手機上由使用者決定。
 */
export function passwordDialog({ title, message, ok = '開啟' }) {
  return ask({
    title,
    message,
    extra: `<input type="password" class="modal-input" autocomplete="off" autocapitalize="characters" aria-label="密碼">
      <label class="switch modal-remember"><input type="checkbox"> 記住這個密碼(只存在這支手機,不會進備份)</label>`,
    actions: [
      { label: '取消', value: null },
      {
        label: ok,
        kind: 'primary',
        value: (dlg) => ({ password: dlg.querySelector('.modal-input').value, remember: dlg.querySelector('.modal-remember input').checked }),
      },
    ],
  });
}
