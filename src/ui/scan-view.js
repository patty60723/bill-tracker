// 掃描過程與結果的畫面(帳單表單用):步驟進度、帶入的欄位卡片、提醒,開發者模式才顯示辨識細節。

import { esc } from './dom.js';

/**
 * 步驟進度。steps:[{ id, label, state: 'pending'|'active'|'done'|'skip', note?, progress? }]
 * progress(0–1)只在 active 時顯示成進度條。
 */
export function progressHTML(steps) {
  const icon = { pending: '<span class="ss-dot"></span>', active: '<span class="spinner"></span>', done: '✓', skip: '–' };
  return `<ol class="scan-steps">${steps.map((s) => `
    <li class="ss ${s.state}">
      <span class="ss-icon">${icon[s.state]}</span>
      <div class="ss-body">
        <div class="ss-label">${esc(s.label)}</div>
        ${s.note ? `<div class="ss-note">${esc(s.note)}</div>` : ''}
        ${s.state === 'active' && s.progress != null ? `<progress max="1" value="${s.progress}"></progress>` : ''}
      </div>
    </li>`).join('')}</ol>`;
}

const SOURCE = {
  barcode: ['條碼', 'src-barcode'],
  printed: ['條碼數字', 'src-barcode'],
  qr: ['QR Code', 'src-barcode'],
  ocr: ['文字', 'src-ocr'],
  guess: ['推測', 'src-guess'],
  template: ['固定繳費', 'src-template'],
  sum: ['多頁加總', 'src-template'],
};

/**
 * 辨識結果。
 * fields:[{ label, value, source?, missing? }]:帶入的欄位(missing 的顯示「請手動填」)
 * notes / warnings:字串(可含 HTML,呼叫端負責 esc)
 * tip:灰色小字提示;detail:開發者模式的辨識細節(純文字)
 */
export function resultHTML({ fields, notes = [], warnings = [], tip = '', detail = null }) {
  const ok = !fields.some((f) => f.missing) && !warnings.length;
  const head = ok ? '✅ 辨識完成,已帶入下面的欄位' : '⚠️ 辨識完成,有些地方要你確認';
  const chip = (s) => (SOURCE[s] ? `<span class="src ${SOURCE[s][1]}">${SOURCE[s][0]}</span>` : '');
  return `
    <div class="scan-head ${ok ? 'ok' : 'warn'}">${head}</div>
    <div class="scan-fields">${fields.map((f) => `
      <div class="sf ${f.missing ? 'missing' : ''}">
        <span class="sf-label">${esc(f.label)}</span>
        <span class="sf-value">${f.missing ? '沒讀到,請手動填' : esc(f.value)}</span>
        ${f.missing ? '' : chip(f.source)}
      </div>`).join('')}
    </div>
    ${warnings.length ? `<ul class="scan-list scan-warnings">${warnings.map((w) => `<li>${w}</li>`).join('')}</ul>` : ''}
    ${notes.length ? `<ul class="scan-list scan-notes">${notes.map((n) => `<li>${n}</li>`).join('')}</ul>` : ''}
    ${tip ? `<p class="scan-tip">${tip}</p>` : ''}
    <p class="muted small">照片已存下。辨識偶爾會看錯,存檔前請核對。</p>
    ${detail == null ? '' : `<details class="scan-detail"><summary>🛠️ 辨識細節</summary>
      <button type="button" class="btn small" data-copy-detail>📋 複製辨識細節</button>
      <pre>${esc(detail)}</pre></details>`}`;
}
