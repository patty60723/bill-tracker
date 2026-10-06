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
    dlg.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-i]');
      if (btn) finish(actions[Number(btn.dataset.i)].value);
      else if (e.target === dlg) finish(cancelValue); // 點到對話框外面(backdrop)
    });
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(cancelValue); });
    document.body.append(dlg);
    dlg.showModal();
    // 危險動作時,預設焦點放在「取消」那一顆,避免誤按 Enter
    const safe = actions.findIndex((a) => a.value === cancelValue);
    dlg.querySelector(`[data-i="${safe >= 0 ? safe : 0}"]`)?.focus();
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
