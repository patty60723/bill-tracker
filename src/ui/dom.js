// DOM 與格式化的小工具:選取元素、轉義、金額、提示列、下載、複製、縮圖 URL。

import { copyDialog } from '../modal.js';

export const $ = (sel, root = document) => root.querySelector(sel);

export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

export const money = (n) => (n == null || n === '' ? '—' : `$${Number(n).toLocaleString('zh-TW')}`);

export const view = $('#view');

export const digits = (v) => String(v ?? '').replace(/\D/g, '');

export const accountText = (o) => (o.accountNo ? `${o.bankCode ? `(${o.bankCode}) ` : ''}${o.accountNo}` : '');

export async function copyText(text, label, { preview = true } = {}) {
  if (!text) return toast(`還沒有${label}`);
  try {
    await navigator.clipboard.writeText(text);
    toast(preview ? `已複製${label}:${text}` : `已複製${label}`);
  } catch {
    copyDialog({ title: `複製${label}`, text });
  }
}

export let objectUrls = [];

/** 換頁時釋放上一頁產生的縮圖 URL。 */
export function revokeObjectUrls() {
  objectUrls.forEach(URL.revokeObjectURL);
  objectUrls = [];
}

export function fileUrl(blob) {
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  return url;
}

/** 底部提示;可以帶一個動作按鈕(例如「復原」),有按鈕時停留久一點。 */
export function toast(msg, action) {
  const el = $('#toast');
  el.textContent = msg;
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = action.label;
    btn.onclick = () => {
      el.classList.remove('show');
      action.onClick();
    };
    el.append(btn);
  }
  el.classList.toggle('has-action', !!action);
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), action ? 6000 : 2400);
}

export function showImage(src) {
  const dlg = $('#viewer');
  $('img', dlg).src = src;
  dlg.showModal();
}

// ---------- 固定繳費 ----------

export function download(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
