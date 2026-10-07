// 多個頁面共用的畫面片段與常數:類別、帳單列、提醒卡、帳號欄位、月統計方塊。

import { diffDays, formatDate, formatPeriod } from '../dates.js';
import { REMINDER_TEXT } from '../notify.js';
import { cycleName } from '../schedule.js';
import { esc, money } from './dom.js';

export const CATEGORIES = [
  ['water', '💧', '水費'], ['power', '⚡', '電費'], ['gas', '🔥', '瓦斯'], ['telecom', '📱', '電信/網路'],
  ['card', '💳', '信用卡'], ['insurance', '🛡️', '保險'], ['tax', '🏛️', '稅金/規費'], ['rent', '🏠', '房租/管理費'],
  ['loan', '🏦', '貸款'], ['school', '🎓', '學費'], ['other', '🧾', '其他'],
];

export const catIcon = (c) => (CATEGORIES.find(([k]) => k === c) || CATEGORIES.at(-1))[1];

export const catLabel = (c) => (CATEGORIES.find(([k]) => k === c) || CATEGORIES.at(-1))[2];

export const PAY_METHODS = ['超商', 'ATM 轉帳', '網路/行動銀行', '信用卡', '行動支付', '郵局/臨櫃', '自動扣繳', '其他'];

export const CYCLES = [[1, '每月'], [2, '每兩個月'], [3, '每季'], [6, '每半年'], [12, '每年']];

export const dayLabel = (d) => (d >= 31 ? '月底' : `${d} 號`);

export const dayOptions = (selected) => Array.from({ length: 28 }, (_, i) => i + 1).concat(31)
  .map((d) => `<option value="${d}" ${d === selected ? 'selected' : ''}>${dayLabel(d)}</option>`).join('');

/** 繳費帳號欄位:銀行代碼 + 帳號 + 複製按鈕。 */
export function accountFields(o) {
  return `<div class="account-field">
    <span class="label-text">繳費帳號 / 銷帳編號 <span class="muted small">(ATM、網銀繳費用,可不填)</span></span>
    <div class="account-row">
      <input name="bankCode" inputmode="numeric" maxlength="5" placeholder="代碼" value="${esc(o.bankCode)}" aria-label="銀行代碼或繳款類別">
      <input name="accountNo" inputmode="numeric" placeholder="帳號或銷帳編號" value="${esc(o.accountNo)}" aria-label="繳費帳號或銷帳編號">
      <button type="button" class="btn small" data-copy-account>📋 複製</button>
    </div>
    <span class="muted small">轉帳:銀行代碼 + 帳號。繳稅:繳款類別(5 碼)+ 銷帳編號</span>
  </div>`;
}

export function reminderCard(r, bill) {
  const copy = bill?.accountNo ? `<button class="btn small" data-copy="${esc(bill.accountNo)}">📋 帳號</button>` : '';
  const actions = r.billId
    ? `<button class="btn small outline" data-pay="${r.billId}">標記已繳</button>
       ${copy}<a class="btn small" href="#/bill/${r.billId}">查看</a>`
    : `<a class="btn small primary" href="#/bill/new?template=${r.templateId}&period=${r.period}">登記帳單</a>`;
  return `<div class="card reminder ${r.level}">
    <div class="grow">
      <div class="title">${esc(r.name)} <span class="muted">${formatPeriod(r.period || '')}</span></div>
      <div class="sub">${esc(REMINDER_TEXT[r.kind](r))}${r.amount ? ` · ${money(r.amount)}` : ''}</div>
    </div>
    <div class="actions">${actions}</div>
  </div>`;
}

// ---------- 新手引導 ----------

export function notifyBanner(hasData) {
  if (!hasData || !('Notification' in window) || Notification.permission !== 'default') return '';
  return `<div class="card reminder info">
    <div class="grow"><div class="title">🔔 開啟通知</div><div class="sub">快截止、逾期、該去拿繳費單時,手機會跳通知提醒你</div></div>
    <div class="actions"><button class="btn small primary" data-enable-notify>開啟</button></div>
  </div>`;
}

export function summaryBlock(s) {
  return `<div class="stats">
    <div><div class="label">總額</div><div class="value">${money(s.total)}</div></div>
    <div><div class="label">已繳</div><div class="value ok">${money(s.paid)}</div></div>
    <div><div class="label">未繳 (${s.unpaidCount})</div><div class="value ${s.unpaid ? 'bad' : ''}">${money(s.unpaid)}</div></div>
  </div>`;
}

// ---------- 帳單列表 ----------

export const byStatusThenDue = (a, b) => (a.status === 'paid') - (b.status === 'paid') || (a.dueDate || '').localeCompare(b.dueDate || '');

/** 依帳單月份(新到舊)分組的列表。 */
export function groupedRows(list, tById, today, monthHref) {
  const groups = new Map();
  for (const b of [...list].sort((x, y) => y.period.localeCompare(x.period) || byStatusThenDue(x, y))) {
    if (!groups.has(b.period)) groups.set(b.period, []);
    groups.get(b.period).push(b);
  }
  return groups.size
    ? [...groups].map(([p, rows]) => `<h2 class="group-head"><a href="${monthHref(p)}">${formatPeriod(p)}</a></h2>
        ${rows.map((b) => billRow(b, tById.get(b.templateId), today)).join('')}`).join('')
    : '<div class="empty">沒有符合的帳單</div>';
}

export function billRow(b, t, today) {
  const paid = b.status === 'paid';
  const left = b.dueDate ? diffDays(today, b.dueDate) : null;
  const [cls, label] = paid ? ['ok', `已繳 ${formatDate(b.paidDate)}`]
    : left == null ? ['warn', '未繳']
      : left < 0 ? ['bad', `逾期 ${-left} 天`]
        : left === 0 ? ['bad', '今天截止']
          : left <= 7 ? ['warn', `剩 ${left} 天`]
            : ['warn', '未繳'];
  const meta = [b.dueDate ? `${formatDate(b.dueDate)} ${b.autoPaid ? '扣款' : '截止'}` : '未填截止日'];
  if (b.autoPaid) meta.push('自動扣款');
  if (b.cycleMonths > 1) meta.push(`${cycleName(b.cycleMonths)}帳單`);
  const files = [];
  if (b.billFiles?.length) files.push('🧾 有繳費單');
  if (b.proofFiles?.length) files.push('📎 有繳費證明');
  return `<a class="card row bill-row" href="#/bill/${b.id}">
    <div class="icon">${catIcon(b.category || t?.category)}</div>
    <div class="grow">
      <div class="title one-line">${esc(b.name)}</div>
      <div class="sub">${meta.join(' · ')}</div>
      ${files.length ? `<div class="sub files-note">${files.join('　')}</div>` : ''}
    </div>
    <div class="right">
      <div class="amount">${money(b.amount)}</div>
      <span class="status ${cls}">${label}</span>
      ${paid ? '' : `<button class="btn small outline" data-pay="${b.id}">標記已繳</button>`}
    </div>
  </a>`;
}

export function cycleText(t) {
  const cycle = CYCLES.find(([n]) => n === t.cycleMonths)?.[1] || `每 ${t.cycleMonths} 個月`;
  const due = t.dueDay >= t.arrivalDay ? dayLabel(t.dueDay) : `隔月 ${dayLabel(t.dueDay)}`;
  return `${cycle} · ${dayLabel(t.arrivalDay)}左右到單 · ${due}截止${t.autoPay ? ' · 自動扣款' : ''}`;
}
