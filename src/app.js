import * as db from './db.js';
import {
  addMonths, diffDays, formatDate, formatPeriod, parsePeriod, periodKey, todayISO,
} from './dates.js';
import { mergeScan, parseConvenienceBarcodes, scanComplete } from './parse.js';
import { liveScan } from './livescan.js';
import { alertDialog, ask, confirmDialog, copyDialog } from './modal.js';
import {
  AUTO_PAY_METHOD, buildReminders, CYCLES as BILL_CYCLES, cycleName, DEFAULT_REMIND_DAYS, monthSummary, nextPeriod,
  periodDates, planAutoPay, suggestTemplateDays,
} from './schedule.js';
import { buildICS } from './ics.js';
import { billsToCSV, billYears, matchBill, yearStats } from './stats.js';
import { backupStatus, backupSummary, describeBackup, SNOOZE_DAYS } from './backup.js';
import { compressImage, imageSize, readBarcodes, readText } from './scan.js';
import {
  notifyReminders, REMINDER_TEXT, sendTestNotification, SYNC_TAG, TEST_TAG,
} from './notify.js';

// ---------- 小工具 ----------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const money = (n) => (n == null || n === '' ? '—' : `$${Number(n).toLocaleString('zh-TW')}`);
const view = $('#view');

export const CATEGORIES = [
  ['water', '💧', '水費'], ['power', '⚡', '電費'], ['gas', '🔥', '瓦斯'], ['telecom', '📱', '電信/網路'],
  ['card', '💳', '信用卡'], ['insurance', '🛡️', '保險'], ['tax', '🏛️', '稅金/規費'], ['rent', '🏠', '房租/管理費'],
  ['loan', '🏦', '貸款'], ['school', '🎓', '學費'], ['other', '🧾', '其他'],
];
const catIcon = (c) => (CATEGORIES.find(([k]) => k === c) || CATEGORIES.at(-1))[1];
const catLabel = (c) => (CATEGORIES.find(([k]) => k === c) || CATEGORIES.at(-1))[2];
const PAY_METHODS = ['超商', 'ATM 轉帳', '網路/行動銀行', '信用卡', '行動支付', '郵局/臨櫃', '自動扣繳', '其他'];
const CYCLES = [[1, '每月'], [2, '每兩個月'], [3, '每季'], [6, '每半年'], [12, '每年']];
const dayLabel = (d) => (d >= 31 ? '月底' : `${d} 號`);
const dayOptions = (selected) => Array.from({ length: 28 }, (_, i) => i + 1).concat(31)
  .map((d) => `<option value="${d}" ${d === selected ? 'selected' : ''}>${dayLabel(d)}</option>`).join('');

const digits = (v) => String(v ?? '').replace(/\D/g, '');
const accountText = (o) => (o.accountNo ? `${o.bankCode ? `(${o.bankCode}) ` : ''}${o.accountNo}` : '');

/** 繳費帳號欄位:銀行代碼 + 帳號 + 複製按鈕。 */
function accountFields(o) {
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

async function copyText(text, label) {
  if (!text) return toast(`還沒有${label}`);
  try {
    await navigator.clipboard.writeText(text);
    toast(`已複製${label}:${text}`);
  } catch {
    copyDialog({ title: `複製${label}`, text });
  }
}

let objectUrls = [];
function fileUrl(blob) {
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  return url;
}

/** 底部提示;可以帶一個動作按鈕(例如「復原」),有按鈕時停留久一點。 */
function toast(msg, action) {
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

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

// ---------- 離開前確認 ----------
// 表單頁設定 leaveGuard;有沒存的變更時,任何離開方式(‹ 返回、下方分頁、手機返回鍵)都先確認。
let leaveGuard = null; // { isDirty: () => boolean, onLeave?: () => void }
let currentHash = location.hash;

let askingLeave = false;

/** 有沒存的變更就問要不要離開;確定離開會執行 onLeave(例如清掉沒存的照片)。 */
async function confirmLeave() {
  return confirmDialog({
    title: '還沒儲存,確定要離開嗎?',
    message: '這張帳單還沒儲存,離開後掃描帶入的資料、輸入的內容和照片都會不見。',
    ok: '離開,不儲存',
    cancel: '繼續編輯',
    danger: true,
  });
}

/** 表單頁用:回傳 markDirty;儲存/刪除成功後呼叫 release() 再跳頁,就不會再問。 */
function guardForm({ onLeave } = {}) {
  let dirty = false;
  leaveGuard = { isDirty: () => dirty, onLeave };
  return {
    markDirty: () => { dirty = true; },
    isDirty: () => dirty,
    release: () => { leaveGuard = null; },
  };
}

function parseHash() {
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  return { parts: path.split('/').filter(Boolean), params: new URLSearchParams(query) };
}

async function loadAll() {
  const [templates, bills] = await Promise.all([db.getAll('templates'), db.getAll('bills')]);
  templates.sort((a, b) => a.name.localeCompare(b.name, 'zh-TW'));
  return { templates, bills };
}

// ---------- 首頁 ----------


function reminderCard(r, bill) {
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

// Android Chrome 允許安裝時會發 beforeinstallprompt:先存起來,讓引導卡片可以直接顯示「安裝 app」按鈕
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  if (!location.hash || location.hash === '#/') render();
});
window.addEventListener('appinstalled', () => { installPrompt = null; });

const isInstalled = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

function onboardingCard({ hasData }) {
  const installed = isInstalled();
  const notifyOn = 'Notification' in window && Notification.permission === 'granted';
  const step = (done, n, title, body) => `<li class="${done ? 'done' : ''}">
      <span class="step-mark">${done ? '✓' : n}</span>
      <div class="grow"><b>${title}</b>${done ? '' : `<div class="step-body">${body}</div>`}</div>
    </li>`;
  const installBody = installPrompt
    ? '<button class="btn small primary" data-install>安裝 app</button><span class="muted small">裝好之後從主畫面的圖示開啟</span>'
    : isIOS()
      ? '<span class="small">用 <b>Safari</b> 開啟這個網址 → 點下方「分享」⬆️ → 「加入主畫面」,之後從主畫面的圖示開啟。</span>'
      : '<span class="small">Chrome 右上角 <b>⋮</b> → 「加到主畫面」或「安裝應用程式」,之後從主畫面的圖示開啟。沒開 app 也能收到提醒。</span>';
  const notifyBody = !('Notification' in window)
    ? `<span class="small muted">${isIOS() ? '先完成第 1 步,從主畫面開啟後才能開通知。' : '這個瀏覽器不支援通知,可以改用「設定 → 加到手機行事曆」。'}</span>`
    : '<button class="btn small primary" data-enable-notify>開啟通知</button><span class="muted small">快截止、逾期、該去拿單時提醒你</span>';
  const allDone = installed && notifyOn && hasData;
  return `<section class="card col onboarding">
    <div class="onboarding-head">
      <h3>${allDone ? '🎉 都設定好了' : '👋 開始使用'}</h3>
      <button type="button" class="btn small link-btn" data-dismiss-onboarding>${allDone ? '關閉' : '不用了'}</button>
    </div>
    <ol class="steps">
      ${step(installed, 1, '加到主畫面', installBody)}
      ${step(notifyOn, 2, '開啟通知', notifyBody)}
      ${step(hasData, 3, '建立第一筆',
    '<a class="btn small primary" href="#/template/new">＋ 固定繳費</a><a class="btn small" href="#/bill/new?scan=1">📷 掃帳單</a>'
    + '<div class="muted small">固定繳費(電費、管理費…)設好到單日和截止日,之後每期都會自動提醒。</div>')}
    </ol>
  </section>`;
}

async function getBackupStatus(templates, bills) {
  return backupStatus({
    lastBackupAt: await db.getMeta('lastBackupAt'),
    snoozeUntil: await db.getMeta('backupSnoozeUntil'),
    records: [...bills, ...templates],
  });
}

function backupCard(status) {
  return `<div class="card reminder warn backup-card">
    <div class="grow">
      <div class="title">💾 該備份了</div>
      <div class="sub">${esc(backupSummary(status))}。資料只存在這支手機裡,手機壞掉或清除瀏覽器資料時,備份檔可以把資料救回來。</div>
      <div class="btn-row backup-actions">
        <button class="btn small primary" data-backup-now>立即備份</button>
        <button class="btn small" data-backup-snooze>${SNOOZE_DAYS} 天後再提醒</button>
      </div>
    </div>
  </div>`;
}

async function renderHome() {
  const { templates, bills } = await loadAll();
  const showOnboarding = !(await db.getMeta('onboardingDismissed'));
  const backup = await getBackupStatus(templates, bills);
  const today = todayISO();
  const reminders = buildReminders(templates, bills, today);
  const [y, m] = today.split('-').map(Number);
  const s = monthSummary(bills, periodKey(y, m));

  view.innerHTML = `
    <header class="page-head"><h1>繳費小幫手</h1><span class="muted">${today}</span></header>
    <div class="quick">
      <a class="btn primary big" href="#/bill/new?scan=1">📷 掃描繳費單</a>
      <a class="btn big" href="#/bill/new">＋ 手動新增</a>
    </div>
    ${showOnboarding ? onboardingCard({ hasData: templates.length + bills.length > 0 }) : notifyBanner(templates.length + bills.length)}
    ${backup.due ? backupCard(backup) : ''}
    <section id="reminders">
      <h2>待辦提醒</h2>
      ${reminders.length ? reminders.map((r) => reminderCard(r, bills.find((b) => b.id === r.billId))).join('') : `<div class="empty">目前沒有要處理的帳單 🎉${templates.length || showOnboarding ? '' : '<br><a href="#/template/new">先設定固定繳費</a>,就會自動提醒你拿繳費單、繳費截止。'}</div>`}
    </section>
    <section>
      <h2>${m} 月帳單 <a class="link" href="#/bills">看全部 ›</a></h2>
      ${summaryBlock(s)}
    </section>`;
}

function notifyBanner(hasData) {
  if (!hasData || !('Notification' in window) || Notification.permission !== 'default') return '';
  return `<div class="card reminder info">
    <div class="grow"><div class="title">🔔 開啟通知</div><div class="sub">快截止、逾期、該去拿繳費單時,手機會跳通知提醒你</div></div>
    <div class="actions"><button class="btn small primary" data-enable-notify>開啟</button></div>
  </div>`;
}

function summaryBlock(s) {
  return `<div class="stats">
    <div><div class="label">總額</div><div class="value">${money(s.total)}</div></div>
    <div><div class="label">已繳</div><div class="value ok">${money(s.paid)}</div></div>
    <div><div class="label">未繳 (${s.unpaidCount})</div><div class="value ${s.unpaid ? 'bad' : ''}">${money(s.unpaid)}</div></div>
  </div>`;
}

// ---------- 帳單列表 ----------

async function renderBills(params) {
  const { templates, bills } = await loadAll();
  const today = todayISO();
  const view = params.get('view') === 'stats' ? 'stats' : params.get('month') === 'all' ? 'all' : 'month';
  const month = view === 'month' && params.get('month') ? params.get('month') : today.slice(0, 7);
  const filter = params.get('filter') || 'all';
  const tById = new Map(templates.map((t) => [t.id, t]));
  const link = (mk, f = filter) => `#/bills?month=${mk}&filter=${f}`;

  $('#view').innerHTML = `
    <header class="page-head"><h1>繳費紀錄</h1></header>
    <div class="search-box">
      <input type="search" id="bill-search" placeholder="🔍 搜尋名稱、金額、帳號、備註…" value="${esc(params.get('q') || '')}" enterkeyhint="search" autocomplete="off">
    </div>
    <div class="segmented three">
      <a class="${view === 'month' ? 'on' : ''}" href="${link(view === 'month' ? month : today.slice(0, 7))}">依月份</a>
      <a class="${view === 'all' ? 'on' : ''}" href="${link('all')}">所有帳單</a>
      <a class="${view === 'stats' ? 'on' : ''}" href="#/bills?view=stats">統計</a>
    </div>
    <div id="bills-body"></div>
    <a class="fab" href="#/bill/new?period=${month}" aria-label="新增帳單">＋</a>`;

  const body = $('#bills-body');
  const drawBody = (q) => {
    if (q.trim()) body.innerHTML = searchResults(bills, tById, q, today);
    else if (view === 'stats') body.innerHTML = statsView(bills, Number(params.get('year')) || Number(today.slice(0, 4)));
    else body.innerHTML = billsListBody({ bills, tById, view, month, filter, link, today });
  };
  drawBody(params.get('q') || '');

  // 搜尋:只重畫下面的清單,輸入框不會失去焦點;關鍵字記在網址,返回時還在
  const search = $('#bill-search');
  search.addEventListener('input', () => {
    const q = search.value;
    const p = new URLSearchParams(params);
    if (q.trim()) p.set('q', q); else p.delete('q');
    history.replaceState(null, '', `#/bills?${p}`);
    currentHash = location.hash;
    drawBody(q);
  });

  // 統計長條圖:點一個月份顯示明細
  body.addEventListener('click', (e) => {
    const bar = e.target.closest('[data-month-bar]');
    if (!bar) return;
    $$('[data-month-bar]', body).forEach((x) => x.classList.toggle('on', x === bar));
    $('#chart-detail').innerHTML = bar.dataset.detail;
  });
  body.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-export]');
    if (!btn) return;
    const year = btn.dataset.export;
    const list = year === 'all' ? bills : bills.filter((b) => b.period?.startsWith(`${year}-`));
    if (!list.length) return toast('沒有可以匯出的帳單');
    download(`bills-${year}.csv`, billsToCSV(list, catLabel), 'text/csv');
  });
}

function billsListBody({ bills, tById, view, month, filter, link, today }) {
  const byFilter = (b) => filter === 'all' || (filter === 'paid' ? b.status === 'paid' : b.status !== 'paid');
  const chips = (target) => `<div class="chips">
      ${[['all', '全部'], ['unpaid', '未繳'], ['paid', '已繳']].map(([k, label]) => `<a class="chip ${k === filter ? 'on' : ''}" href="${link(target, k)}">${label}</a>`).join('')}
    </div>`;
  if (view === 'all') {
    const list = bills.filter(byFilter);
    return `${chips('all')}${groupedRows(list, tById, today, (p) => link(p))}`;
  }
  const { year, month: mo } = parsePeriod(month);
  const prev = addMonths(year, mo, -1);
  const next = addMonths(year, mo, 1);
  const list = bills.filter((b) => b.period === month).filter(byFilter).sort(byStatusThenDue);
  const elsewhere = bills.filter((b) => b.period !== month).length;
  return `<div class="month-nav">
      <a class="btn small" href="${link(periodKey(prev.year, prev.month))}" aria-label="上個月">‹</a>
      <strong>${formatPeriod(month)}</strong>
      <a class="btn small" href="${link(periodKey(next.year, next.month))}" aria-label="下個月">›</a>
    </div>
    ${summaryBlock(monthSummary(bills, month))}
    ${chips(month)}
    ${list.length ? list.map((b) => billRow(b, tById.get(b.templateId), today)).join('')
    : `<div class="empty">這個月沒有帳單${elsewhere ? `<br><a href="${link('all')}">其他月份有 ${elsewhere} 筆,看全部 ›</a>` : ''}</div>`}`;
}

const byStatusThenDue = (a, b) => (a.status === 'paid') - (b.status === 'paid') || (a.dueDate || '').localeCompare(b.dueDate || '');

/** 依帳單月份(新到舊)分組的列表。 */
function groupedRows(list, tById, today, monthHref) {
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

function searchResults(bills, tById, q, today) {
  const list = bills.filter((b) => matchBill(b, q, catLabel));
  const sum = list.reduce((s, b) => s + (Number(b.amount) || 0), 0);
  return `<p class="muted small search-summary">找到 ${list.length} 筆${list.length ? `,合計 ${money(sum)}` : ''}</p>
    ${list.length ? groupedRows(list, tById, today, (p) => `#/bills?month=${p}`) : '<div class="empty">找不到符合的帳單<br><span class="small">可以搜尋名稱、金額(1286 或 1,286)、帳號、備註、類別、月份(2026-10)</span></div>'}`;
}

/** 統計頁:年度總覽、12 個月長條圖、類別排行、匯出 CSV。 */
function statsView(bills, year) {
  const [thisYear, thisMonth] = todayISO().split('-').map(Number);
  // 今年還沒過完:跟去年「同期」(1 月到本月)比
  const s = yearStats(bills, year, year === thisYear ? thisMonth : 12);
  const sameMonths = s.compareThrough < 12 ? `同期(1–${s.compareThrough} 月)` : '';
  const years = billYears(bills, thisYear);
  const hasPrev = years.includes(year - 1) || year - 1 >= Math.min(...years);
  const hasNext = year < Math.max(...years);
  const pct = (x) => `${Math.round(Math.abs(x) * 100)}%`;
  const flat = (x) => Math.round(Math.abs(x) * 100) === 0;
  const change = s.change == null
    ? `<span class="muted">去年${sameMonths}沒有紀錄</span>`
    : flat(s.change) ? `跟去年${sameMonths}差不多`
      : `比去年${sameMonths}${s.change > 0 ? '多' : '少'} <b>${pct(s.change)}</b> ${s.change > 0 ? '▲' : '▼'}`
        + `<span class="muted">(今年 ${money(s.compareTotal)}、去年 ${money(s.prevTotal)})</span>`;

  const max = Math.max(...s.byMonth.map((m) => m.total), 0);
  const peak = s.byMonth.reduce((a, m) => (m.total > a.total ? m : a), s.byMonth[0]);
  const bars = s.byMonth.map((m) => {
    const h = max ? Math.max(m.total ? 3 : 0, Math.round((m.total / max) * 100)) : 0;
    const p = periodKey(year, m.month);
    const detail = `<b>${m.month} 月</b>:${money(m.total)}${m.count ? `(已繳 ${money(m.paid)},${m.count} 筆)` : ''} <a href="#/bills?month=${p}">看這個月 ›</a>`;
    return `<button type="button" class="bar-col" data-month-bar data-detail="${esc(detail)}" aria-label="${m.month} 月 ${money(m.total)}">
        <span class="bar-value">${m === peak && m.total ? money(m.total) : ''}</span>
        <span class="bar-track"><span class="bar" style="height:${h}%"></span></span>
        <span class="bar-label">${m.month}</span>
      </button>`;
  }).join('');

  const catMax = Math.max(...s.byCategory.map((c) => c.total), 0);
  const cats = s.byCategory.map((c) => {
    const share = s.total ? Math.round((c.total / s.total) * 100) : 0;
    const d = c.prevTotal > 0 ? (c.compareTotal - c.prevTotal) / c.prevTotal : null;
    const vsPrev = d == null ? '' : flat(d) ? ` · 跟去年${sameMonths}差不多`
      : ` · 比去年${sameMonths}${d > 0 ? '多' : '少'} ${pct(d)}`;
    return `<div class="cat-row">
        <span class="icon">${catIcon(c.category)}</span>
        <div class="grow">
          <div class="cat-head"><span>${esc(catLabel(c.category))}</span><b>${money(c.total)}</b></div>
          <div class="cat-track"><span class="cat-bar" style="width:${catMax ? Math.max(2, (c.total / catMax) * 100) : 0}%"></span></div>
          <div class="sub">${share}% · ${c.count} 筆${vsPrev}</div>
        </div>
      </div>`;
  }).join('');

  return `
    <div class="month-nav">
      ${hasPrev ? `<a class="btn small" href="#/bills?view=stats&year=${year - 1}" aria-label="前一年">‹</a>` : '<span class="btn small disabled">‹</span>'}
      <strong>${year} 年</strong>
      ${hasNext ? `<a class="btn small" href="#/bills?view=stats&year=${year + 1}" aria-label="下一年">›</a>` : '<span class="btn small disabled">›</span>'}
    </div>
    ${s.count ? `
    <div class="stats">
      <div><div class="label">全年總額</div><div class="value">${money(s.total)}</div></div>
      <div><div class="label">已繳</div><div class="value ok">${money(s.paid)}</div></div>
      <div><div class="label">月平均</div><div class="value">${money(s.monthlyAvg)}</div></div>
    </div>
    <p class="yoy small">${change}</p>
    <section class="card col chart-card">
      <h3>每月金額</h3>
      <div class="bar-chart" role="group" aria-label="${year} 年每月繳費金額">${bars}</div>
      <div id="chart-detail" class="chart-detail small muted">點長條看當月明細</div>
    </section>
    <section class="card col">
      <h3>各類別</h3>
      ${cats}
    </section>` : `<div class="empty">${year} 年沒有帳單</div>`}
    <section class="card col">
      <h3>匯出 CSV</h3>
      <p class="muted small">用 Excel、Google 試算表、Numbers 都能直接開啟。</p>
      <div class="btn-row">
        <button class="btn" data-export="${year}">匯出 ${year} 年</button>
        <button class="btn" data-export="all">匯出全部</button>
      </div>
    </section>`;
}

function billRow(b, t, today) {
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

/** 開檔案選擇器(拍照或選檔);使用者取消時回傳 []。要在點擊等使用者動作之後呼叫。 */
function pickFiles({ camera = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = camera ? 'image/*' : 'image/*,application/pdf';
    if (camera) input.capture = 'environment';
    else input.multiple = true;
    input.onchange = () => resolve([...input.files]);
    input.oncancel = () => resolve([]);
    input.click();
  });
}

/**
 * 標記已繳,接著問要不要上傳繳費證明(拍照 / 選照片或 PDF / 之後再說),也可以在這裡復原。
 */
async function markPaid(id) {
  const before = await db.get('bills', id);
  const paid = { ...before, status: 'paid', paidDate: todayISO(), updatedAt: new Date().toISOString() };
  await db.put('bills', paid);
  await render();
  const choice = await ask({
    title: `「${before.name}」已標記為已繳`,
    message: '要順便上傳繳費證明嗎?(收據、轉帳截圖、PDF)',
    cancelValue: 'later',
    actions: [
      { label: '📷 拍照上傳', value: 'camera', kind: 'primary' },
      { label: '🖼️ 選照片或 PDF', value: 'pick' },
      { label: '之後再說', value: 'later' },
      { label: '復原(其實還沒繳)', value: 'undo', kind: 'link' },
    ],
  });
  if (choice === 'undo') {
    await db.put('bills', before);
    toast('已復原為未繳');
    return render();
  }
  if (choice !== 'camera' && choice !== 'pick') return toast('已標記為已繳,之後可以在帳單頁上傳證明');
  const files = await pickFiles({ camera: choice === 'camera' });
  if (!files.length) return toast('已標記為已繳,之後可以在帳單頁上傳證明');
  const ids = [];
  for (const f of files) ids.push(await db.saveFile(await compressImage(f), f.name));
  const latest = await db.get('bills', id);
  await db.put('bills', { ...latest, proofFiles: [...(latest.proofFiles || []), ...ids], updatedAt: new Date().toISOString() });
  toast(`已上傳 ${ids.length} 個繳費證明`);
  render();
}

// ---------- 帳單編輯 ----------

async function renderBillForm(id, params) {
  const { templates, bills } = await loadAll();
  const isNew = id === 'new';
  let bill;
  if (isNew) {
    const t = templates.find((x) => x.id === params.get('template'));
    const period = params.get('period') || todayISO().slice(0, 7);
    bill = {
      id: db.uid(), name: t?.name || '', templateId: t?.id || '', category: t?.category || 'other',
      period, cycleMonths: t?.cycleMonths || 1, amount: t?.amount ?? '', dueDate: t ? periodDates(t, period).due : '',
      accountNo: t?.accountNo || '', bankCode: t?.bankCode || '',
      status: 'unpaid', paidDate: '', paidMethod: '', notes: '', billFiles: [], proofFiles: [],
    };
  } else {
    bill = await db.get('bills', id);
    if (!bill) return go('#/bills');
  }
  const addedFiles = []; // 新增到一半取消時要刪掉的檔案

  view.innerHTML = `
    <header class="page-head">
      <a class="back" href="#/bills?month=${esc(bill.period)}" aria-label="返回">‹</a>
      <h1>${isNew ? '新增帳單' : '帳單內容'}</h1>
    </header>
    <form id="bill-form" class="form">
      <div class="scan-box">
        <div class="scan-tiles">
          <button type="button" class="scan-tile" id="scan-btn">
            <span class="tile-icon">📷</span><b>拍照辨識</b><span>拍整張繳費單</span>
          </button>
          <label class="scan-tile">
            <span class="tile-icon">🖼️</span><b>從相簿選</b><span>選拍好的照片</span>
            <input type="file" id="pick-input" accept="image/*" hidden>
          </label>
          <button type="button" class="scan-tile" id="live-btn">
            <span class="tile-icon">▦</span><b>對準條碼掃</b><span>鏡頭靠近條碼</span>
          </button>
        </div>
        <input type="file" id="scan-input" accept="image/*" capture="environment" hidden>
        <div id="scan-status" class="scan-status" hidden></div>
      </div>
      </div>

      <label>固定繳費項目
        <select name="templateId">
          <option value="">(單次帳單,不屬於固定繳費)</option>
          ${templates.map((t) => `<option value="${t.id}" ${t.id === bill.templateId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
        </select>
      </label>
      <label>名稱 <input name="name" required value="${esc(bill.name)}" placeholder="例如:台電電費"></label>
      <label>類別
        <select name="category">${CATEGORIES.map(([k, ic, label]) => `<option value="${k}" ${k === bill.category ? 'selected' : ''}>${ic} ${label}</option>`).join('')}</select>
      </label>
      <div class="two">
        <label>帳單月份 <input type="month" name="period" required value="${esc(bill.period)}"></label>
        <label>帳單週期
          <select name="cycleMonths">${BILL_CYCLES.map(([n, label]) => `<option value="${n}" ${n === (bill.cycleMonths || 1) ? 'selected' : ''}>${label}</option>`).join('')}</select>
        </label>
      </div>
      <div class="two">
        <label>金額 <input type="number" name="amount" inputmode="numeric" min="0" step="1" value="${esc(bill.amount)}" placeholder="0"></label>
        <label>繳費截止日 <input type="date" name="dueDate" value="${esc(bill.dueDate)}"></label>
      </div>
      ${accountFields(bill)}

      <fieldset id="save-template" ${bill.templateId ? 'hidden' : ''}>
        <label class="switch"><input type="checkbox" name="saveTemplate"> 同時存成固定繳費</label>
        <span class="muted small">之後每期會自動提醒你拿繳費單、繳費截止</span>
        <div id="tpl-fields" hidden>
          <div class="two">
            <label>繳費單大約幾號到 <select name="arrivalDay">${dayOptions(1)}</select></label>
            <label>每期截止日 <select name="dueDay">${dayOptions(15)}</select></label>
          </div>
          <label>截止前幾天提醒 <input type="number" name="remindDays" min="0" max="30" value="${DEFAULT_REMIND_DAYS}"></label>
          <label class="switch"><input type="checkbox" name="autoPay" > 自動扣款</label>
      <span class="muted small switch-hint">到截止日自動記成「已繳(自動扣繳)」,不再提醒拿單、繳費。金額先用預估金額,可以再改。</span>
          <p class="muted small" id="tpl-hint"></p>
        </div>
      </fieldset>

      <fieldset>
        <legend>繳費單照片</legend>
        <div class="files" id="bill-files"></div>
        <label class="btn small file-btn">＋ 加照片<input type="file" accept="image/*" multiple hidden data-add="billFiles"></label>
      </fieldset>

      <fieldset class="pay-box">
        <legend>繳費狀態</legend>
        <label class="switch"><input type="checkbox" name="paid" ${bill.status === 'paid' ? 'checked' : ''}> 已繳費</label>
        <div id="paid-fields" ${bill.status === 'paid' ? '' : 'hidden'}>
          <div class="two">
            <label>繳費日期 <input type="date" name="paidDate" value="${esc(bill.paidDate)}"></label>
            <label>繳費方式
              <select name="paidMethod"><option value="">—</option>${PAY_METHODS.map((p) => `<option ${p === bill.paidMethod ? 'selected' : ''}>${p}</option>`).join('')}</select>
            </label>
          </div>
          <div class="sub-legend">繳費證明(收據、轉帳截圖、PDF)</div>
          <div class="files" id="proof-files"></div>
          <label class="btn small file-btn">＋ 上傳繳費證明<input type="file" accept="image/*,application/pdf" multiple hidden data-add="proofFiles"></label>
        </div>
      </fieldset>

      <label>備註 <textarea name="notes" rows="2">${esc(bill.notes)}</textarea></label>

      <div class="form-actions">
        <button class="btn primary big" type="submit">儲存</button>
        ${isNew ? '<button class="btn big" type="button" id="cancel">取消</button>' : '<button class="btn big danger" type="button" id="delete">刪除</button>'}
      </div>
    </form>`;

  const form = $('#bill-form');
  const field = (n) => form.elements.namedItem(n);
  const guard = guardForm({
    // 確定離開:這次加進來、但沒存的照片一起刪掉
    onLeave: () => addedFiles.forEach((fid) => db.del('files', fid)),
  });
  form.addEventListener('input', guard.markDirty);
  form.addEventListener('change', guard.markDirty);

  // 「同時存成固定繳費」:用目前表單內容組出一個 template
  const draftTemplate = () => ({
    id: db.uid(),
    name: field('name').value.trim(),
    category: field('category').value,
    amount: field('amount').value === '' ? '' : Number(field('amount').value),
    cycleMonths: Number(field('cycleMonths').value),
    anchorMonth: Number((field('period').value || todayISO()).slice(5, 7)),
    arrivalDay: Number(field('arrivalDay').value),
    dueDay: Number(field('dueDay').value),
    remindDays: Number(field('remindDays').value || 0),
    autoPay: field('autoPay').checked,
    autoPayFrom: field('autoPay').checked ? todayISO() : '',
    accountNo: digits(field('accountNo').value),
    bankCode: digits(field('bankCode').value),
    active: true,
    notes: '',
  });
  let tplDaysTouched = false;
  function updateTemplateHint() {
    if (field('saveTemplate').checked && !tplDaysTouched) {
      const d = suggestTemplateDays(field('period').value || todayISO().slice(0, 7), field('dueDate').value, todayISO());
      field('arrivalDay').value = d.arrivalDay;
      field('dueDay').value = d.dueDay;
    }
    const t = draftTemplate();
    const n = nextPeriod(t, todayISO());
    $('#tpl-hint').textContent = cycleText(t)
      + (n ? `。${n.arrival <= todayISO() ? '本期' : '下一期'}:${formatDate(n.arrival)} 到單、${formatDate(n.due)} 截止` : '');
  }

  async function drawFiles(key, containerId) {
    const box = $(`#${containerId}`);
    const files = (await Promise.all(bill[key].map((fid) => db.get('files', fid)))).filter(Boolean);
    box.innerHTML = files.map((f) => {
      const url = fileUrl(f.blob);
      const thumb = f.type.startsWith('image/')
        ? `<img src="${url}" alt="">`
        : `<span class="doc">📄<br>${esc(f.name || 'PDF')}</span>`;
      return `<div class="file"><a href="${url}" data-view="${f.type.startsWith('image/') ? 'img' : 'doc'}" target="_blank" rel="noopener">${thumb}</a>
        <button type="button" class="x" data-remove="${key}:${f.id}" aria-label="移除">×</button></div>`;
    }).join('') || '<span class="muted small">尚未加入</span>';
  }
  const redrawFiles = () => Promise.all([drawFiles('billFiles', 'bill-files'), drawFiles('proofFiles', 'proof-files')]);
  await redrawFiles();

  async function addFiles(key, fileList) {
    const ids = [];
    for (const f of fileList) {
      const fid = await db.saveFile(await compressImage(f), f.name);
      bill[key].push(fid);
      addedFiles.push(fid);
      ids.push(fid);
    }
    await redrawFiles();
    return ids;
  }

  form.addEventListener('change', async (e) => {
    const el = e.target;
    if (el.dataset.add) {
      await addFiles(el.dataset.add, el.files);
      el.value = '';
    } else if (el.name === 'paid') {
      $('#paid-fields').hidden = !el.checked;
      if (el.checked && !form.paidDate.value) form.paidDate.value = todayISO();
    } else if (el.name === 'templateId') {
      $('#save-template').hidden = !!el.value;
      if (!el.value) return;
      const t = templates.find((x) => x.id === el.value);
      field('name').value = t.name;
      field('category').value = t.category || 'other';
      field('cycleMonths').value = t.cycleMonths || 1;
      if (!field('amount').value && t.amount) field('amount').value = t.amount;
      if (!field('accountNo').value && t.accountNo) {
        field('accountNo').value = t.accountNo;
        field('bankCode').value = t.bankCode || '';
      }
      if (!field('dueDate').value && field('period').value) field('dueDate').value = periodDates(t, field('period').value).due;
    } else if (el.name === 'saveTemplate') {
      $('#tpl-fields').hidden = !el.checked;
      updateTemplateHint();
    } else if (el.name === 'arrivalDay' || el.name === 'dueDay') {
      tplDaysTouched = true;
      updateTemplateHint();
    } else if (['period', 'dueDate', 'cycleMonths'].includes(el.name) && field('saveTemplate').checked) {
      updateTemplateHint();
    }
  });

  form.addEventListener('click', async (e) => {
    if (e.target.closest('[data-copy-account]')) {
      copyText(digits(field('accountNo').value), '帳號');
      return;
    }
    const rm = e.target.closest('[data-remove]');
    if (rm) {
      const [key, fid] = rm.dataset.remove.split(':');
      bill[key] = bill[key].filter((x) => x !== fid);
      guard.markDirty();
      await redrawFiles();
      return;
    }
    const v = e.target.closest('[data-view="img"]');
    if (v) {
      e.preventDefault();
      showImage(v.href);
    }
  });

  // --- 掃描 ---
  const status = $('#scan-status');
  const setStatus = (html) => { status.hidden = false; status.innerHTML = html; };
  // 拍照和即時掃描的結果累積在一起,兩種方式可以混用
  // 這個表單目前的掃描結果。同一張帳單的多次掃描(拍照 + 對準條碼掃、正反面)會合併;
  // 掃「另一張」帳單前要先 resetScan(),不然上一張的條碼(例如稅單 QR Code)會一直蓋過新的。
  const newScanState = () => ({
    barcodes: new Set(), texts: [], errors: [], size: null,
    photos: [], // 掃描時加進來的照片 id
    before: {}, // 欄位被掃描改寫前的值
    filled: {}, // 掃描寫進欄位的值
  });
  let scan = newScanState();
  const hasScan = () => scan.barcodes.size > 0 || scan.texts.length > 0 || scan.photos.length > 0;
  /** 掃描結果寫進欄位,並記下原值,換帳單時才還原得回去。 */
  const fill = (name, value) => {
    if (!(name in scan.before)) scan.before[name] = field(name).value;
    field(name).value = value;
    scan.filled[name] = field(name).value;
  };
  /** 清掉上一次掃描的影響:條碼/文字、它帶入的欄位(使用者之後自己改過的保留)、它加的照片。 */
  async function resetScan() {
    for (const [name, value] of Object.entries(scan.filled)) {
      if (field(name).value === value) field(name).value = scan.before[name];
    }
    for (const fid of scan.photos) {
      bill.billFiles = bill.billFiles.filter((x) => x !== fid);
      await db.del('files', fid);
    }
    scan = newScanState();
    status.hidden = true;
    await redrawFiles();
  }
  /** 已經掃過一張時,問這次是「另一張帳單」還是「同一張的另一頁」。回傳 false 代表使用者取消。 */
  async function startScan() {
    if (!hasScan()) return true;
    const choice = await ask({
      title: '這個表單已經掃過一張了',
      message: '這次要掃的是?',
      stacked: true,
      actions: [
        { label: '另一張帳單', desc: '清掉上一張帶入的資料和照片,重新辨識', value: 'another', kind: 'primary' },
        { label: '同一張帳單的另一頁', desc: '合併兩次的結果(例如正反面)', value: 'same' },
        { label: '取消', value: null },
      ],
    });
    if (choice === 'another') await resetScan();
    return choice !== null;
  }
  const barcodesEnough = (t) => {
    const r = parseConvenienceBarcodes(t);
    return !!(r.dueDate && r.amount != null);
  };
  $('#scan-btn').onclick = () => $('#scan-input').click();
  $('#pick-input').onchange = (e) => $('#scan-input').onchange(e);
  $('#scan-input').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!(await startScan())) return;
    scan.size = await imageSize(file);
    scan.photos.push(...await addFiles('billFiles', [file]));
    setStatus('🔍 辨識條碼中…');
    const { texts: codes, errors } = await readBarcodes(file, { isEnough: barcodesEnough });
    codes.forEach((c) => scan.barcodes.add(c));
    scan.errors.push(...errors);
    let result = mergeScan([...scan.barcodes], scan.texts);
    // 帳號欄位還空著的話也跑一次文字辨識,看帳單上有沒有寫轉帳帳號
    if (!scanComplete(result) || !field('accountNo').value) {
      setStatus('🔤 條碼資訊不完整,改用文字辨識…');
      try {
        const texts = await readText(file, {
          isEnough: (t) => scanComplete(mergeScan([...scan.barcodes], [...scan.texts, ...t])),
          onProgress: (p) => setStatus(p.loading
            ? '🔤 載入文字辨識…(第一次需要下載約 12 MB,之後就不用)'
            : `🔤 文字辨識中…${p.pass > 1 ? '(換個方式再讀一次)' : ''} ${Math.round(p.progress * 100)}%`),
        });
        scan.texts.push(...texts);
        result = mergeScan([...scan.barcodes], scan.texts);
      } catch (err) {
        console.warn(err);
        scan.errors.push(`文字辨識:${err?.message || err}`);
      }
    }
    applyScan(result);
  };
  $('#live-btn').onclick = async () => {
    if (!(await startScan())) return;
    const codes = await liveScan({ describe: describeBarcodes, isEnough: barcodesEnough });
    if (!codes) return;
    codes.forEach((c) => scan.barcodes.add(c));
    applyScan(mergeScan([...scan.barcodes], scan.texts));
  };

  function applyScan(r) {
    guard.markDirty();
    const barcodes = [...scan.barcodes];
    const found = [];
    const missing = [];
    const via = (src) => ({ barcode: '條碼', ocr: '文字辨識', guess: '推測' }[src]);
    if (r.amount != null) {
      fill('amount', r.amount);
      found.push(`金額 ${money(r.amount)}(${via(r.source.amount)})`);
    } else missing.push('金額');
    if (r.dueDate) {
      fill('dueDate', r.dueDate);
      found.push(`截止日 ${formatDate(r.dueDate)}(${r.taxCutoff ? '稅單繳納期間最後一天' : via(r.source.dueDate)})`);
      if (r.taxCutoff) {
        // 條碼上的日期是「繳納期間屆滿後 3 日」,記在備註,不當截止日
        const note = `條碼上的繳納截止日是 ${formatDate(r.taxCutoff)}(繳納期間屆滿後 3 日)`;
        const notes = field('notes');
        if (!notes.value.includes(note)) fill('notes', notes.value ? `${notes.value}\n${note}` : note);
      }
    } else missing.push('截止日');
    if (r.period && /^\d{4}-\d{2}$/.test(r.period)) fill('period', r.period);
    if (r.cycleMonths) fill('cycleMonths', r.cycleMonths);
    let movedPeriod = false;
    // 帳單沒寫月份、截止日又離目前選的月份很遠(例如掃去年的稅單):帳單月份改成截止日那個月
    if (!r.period && r.dueDate && field('period').value) {
      const [py, pm] = field('period').value.split('-').map(Number);
      const [dy, dm] = r.dueDate.split('-').map(Number);
      if (Math.abs((dy * 12 + dm) - (py * 12 + pm)) > 1) {
        fill('period', r.dueDate.slice(0, 7));
        movedPeriod = true;
      }
    }
    if (r.accountNo && !field('accountNo').value) {
      fill('accountNo', r.accountNo);
      if (r.bankCode) fill('bankCode', r.bankCode);
      found.push(r.taxQr ? `繳款類別 ${r.bankCode}、銷帳編號 ${r.accountNo}` : `繳費帳號 ${accountText(r)}`);
    }

    const lines = [];
    if (found.length) lines.push(`✅ 已帶入:${found.join('、')}`);
    if (r.taxCutoff) lines.push(`🏛️ 稅單:條碼上的 ${formatDate(r.taxCutoff)} 是繳納期間屆滿後 3 日,截止日用 ${formatDate(r.dueDate)}(已寫進備註)。`);
    if (movedPeriod) lines.push(`📅 帳單月份已改成 <b>${formatPeriod(field('period').value)}</b>(跟截止日同月),存檔後會列在那個月份底下;不對的話請直接改。`);
    if (r.source.dueDate === 'guess') lines.push('⚠️ 帳單上沒找到「繳費期限」之類的字,截止日是用帳單上最晚的日期<b>推測</b>的,請一定要核對。');
    if (missing.length) lines.push(`⚠️ 沒辨識出${missing.join('、')},請手動填寫。`);
    const LOW_RES = 2000; // 長邊少於這個,條碼和小字很容易讀不到
    if (scan.size && Math.max(scan.size.width, scan.size.height) < LOW_RES) {
      lines.push(`⚠️ 這張照片只有 ${scan.size.width}×${scan.size.height},解析度偏低,條碼和小字容易讀不到。可以改用「🖼️ 從相簿選」:先用手機相機 App 拍,再從相簿選。`);
    }
    if (r.source.dueDate !== 'barcode' && !barcodesEnough(barcodes)) {
      lines.push('💡 截止日、金額最準的來源是帳單下方的超商條碼。條碼沒讀到的話,按「▦ 對準條碼掃」把鏡頭靠近條碼試試。');
    }
    lines.push('<span class="muted small">照片已存下。辨識偶爾會看錯,存檔前請核對。</span>');
    const detail = [
      ...(scan.size ? [`照片解析度:${scan.size.width}×${scan.size.height}(約 ${Math.round(scan.size.width * scan.size.height / 1e4)} 萬畫素)`] : []),
      `條碼(${barcodes.length}):${barcodes.length ? barcodes.map(esc).join(' / ') : '沒讀到'}`,
      ...scan.texts.map((t, i) => `文字辨識 #${i + 1}:\n${esc(t.trim()) || '(空白)'}`),
      ...(scan.errors.length ? [`錯誤:\n${[...new Set(scan.errors)].map(esc).join('\n')}`] : []),
    ].join('\n\n');
    setStatus(`${lines.join('<br>')}<details class="scan-detail"><summary>辨識細節</summary><pre>${detail}</pre></details>`);
  }
  if (params.get('scan') && isNew) $('#scan-input').click();

  // --- 儲存/取消/刪除 ---
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const paid = fd.get('paid') === 'on';
    const updated = {
      ...bill,
      name: fd.get('name').trim(),
      templateId: fd.get('templateId'),
      category: fd.get('category'),
      period: fd.get('period'),
      cycleMonths: Number(fd.get('cycleMonths')) || 1,
      amount: fd.get('amount') === '' ? '' : Number(fd.get('amount')),
      dueDate: fd.get('dueDate'),
      status: paid ? 'paid' : 'unpaid',
      paidDate: paid ? fd.get('paidDate') || todayISO() : '',
      paidMethod: paid ? fd.get('paidMethod') : '',
      accountNo: digits(fd.get('accountNo')),
      bankCode: digits(fd.get('bankCode')),
      notes: fd.get('notes').trim(),
      updatedAt: new Date().toISOString(),
      createdAt: bill.createdAt || new Date().toISOString(),
    };
    if (isNew && updated.templateId
      && bills.some((b) => b.templateId === updated.templateId && b.period === updated.period)
      && !(await confirmDialog({
        title: '這個月已經有這筆了',
        message: `${formatPeriod(updated.period)}已經有一筆「${updated.name}」,還要再新增一筆嗎?`,
        ok: '還是新增',
      }))) return;
    let savedTemplate = false;
    if (!updated.templateId && fd.get('saveTemplate') === 'on') {
      const t = { ...draftTemplate(), createdAt: new Date().toISOString() };
      await db.put('templates', t);
      updated.templateId = t.id;
      savedTemplate = true;
    }
    await db.put('bills', updated);
    guard.release();
    if (savedTemplate) await runAutoPay();
    toast(savedTemplate ? '已儲存,也加進固定繳費了' : '已儲存');
    go(`#/bills?month=${updated.period}`);
  };
  $('#cancel')?.addEventListener('click', () => navigate('#/')); // 有沒存的變更時會先問
  $('#delete')?.addEventListener('click', async () => {
    if (!(await confirmDialog({
      title: '刪除這筆帳單?',
      message: `「${bill.name}」和它的繳費單照片、繳費證明都會一起刪除,無法復原。`,
      ok: '刪除',
      danger: true,
    }))) return;
    await db.deleteBill(await db.get('bills', bill.id));
    for (const fid of addedFiles) await db.del('files', fid);
    guard.release();
    toast('已刪除');
    go(`#/bills?month=${bill.period}`);
  });
}

/** 即時掃描畫面上顯示目前讀到哪幾段。 */
function describeBarcodes(texts) {
  const r = parseConvenienceBarcodes(texts);
  const row = (ok, label, value) => `<div class="${ok ? 'ok' : 'muted'}">${ok ? '✅' : '⬜'} ${label}${ok ? `:${value}` : ':還沒讀到'}</div>`;
  const others = texts.length - (r.dueDate ? 1 : 0) - (r.amount != null ? 1 : 0);
  return row(!!r.dueDate, '截止日(第一段條碼)', r.dueDate ? formatDate(r.dueDate) : '')
    + row(r.amount != null, '金額(第三段條碼)', money(r.amount))
    + (others > 0 ? `<div class="muted small">另外讀到 ${others} 個條碼</div>` : '');
}

function showImage(src) {
  const dlg = $('#viewer');
  $('img', dlg).src = src;
  dlg.showModal();
}

// ---------- 固定繳費 ----------

function cycleText(t) {
  const cycle = CYCLES.find(([n]) => n === t.cycleMonths)?.[1] || `每 ${t.cycleMonths} 個月`;
  const due = t.dueDay >= t.arrivalDay ? dayLabel(t.dueDay) : `隔月 ${dayLabel(t.dueDay)}`;
  return `${cycle} · ${dayLabel(t.arrivalDay)}左右到單 · ${due}截止${t.autoPay ? ' · 自動扣款' : ''}`;
}

async function renderTemplates() {
  const { templates } = await loadAll();
  const today = todayISO();
  view.innerHTML = `
    <header class="page-head"><h1>固定繳費</h1></header>
    <p class="muted small intro">設定每期大概什麼時候會收到繳費單、什麼時候截止,首頁就會提醒你去拿單、去繳錢。</p>
    ${templates.map((t) => {
    const n = nextPeriod(t, today);
    return `<a class="card row ${t.active ? '' : 'inactive'}" href="#/template/${t.id}">
        <div class="icon">${catIcon(t.category)}</div>
        <div class="grow">
          <div class="title">${esc(t.name)} ${t.active ? '' : '<span class="badge">已停用</span>'}</div>
          <div class="sub">${cycleText(t)}</div>
          ${t.accountNo ? `<div class="sub">帳號 ${esc(accountText(t))}</div>` : ''}
          ${n && t.active ? `<div class="sub">${n.arrival <= today ? '本期' : '下一期'}:${formatDate(n.arrival)} 到單、${formatDate(n.due)} 截止</div>` : ''}
        </div>
        <div class="amount">${t.amount ? `約 ${money(t.amount)}` : ''}</div>
      </a>`;
  }).join('') || '<div class="empty">還沒有固定繳費,按右下角 ＋ 新增</div>'}
    <a class="fab" href="#/template/new" aria-label="新增固定繳費">＋</a>`;
}

/** 固定繳費頁下方:這個項目所有月份的帳單。 */
async function templateHistory(t) {
  const today = todayISO();
  const list = (await db.getAll('bills')).filter((b) => b.templateId === t.id)
    .sort((a, b) => b.period.localeCompare(a.period));
  return `<section class="history">
    <h2>繳費紀錄(${list.length})</h2>
    ${list.length ? list.map((b) => `<div class="muted small group-label">${formatPeriod(b.period)}</div>${billRow(b, t, today)}`).join('')
    : '<div class="empty">還沒有帳單</div>'}
  </section>`;
}

async function renderTemplateForm(id) {
  const isNew = id === 'new';
  const t = isNew
    ? {
      id: db.uid(), name: '', category: 'other', amount: '', cycleMonths: 1, anchorMonth: new Date().getMonth() + 1,
      arrivalDay: 1, dueDay: 15, remindDays: DEFAULT_REMIND_DAYS, active: true, notes: '', accountNo: '', bankCode: '',
    }
    : await db.get('templates', id);
  if (!t) return go('#/templates');

  view.innerHTML = `
    <header class="page-head">
      <a class="back" href="#/templates" aria-label="返回">‹</a>
      <h1>${isNew ? '新增固定繳費' : '編輯固定繳費'}</h1>
    </header>
    <form id="t-form" class="form">
      <label>名稱 <input name="name" required value="${esc(t.name)}" placeholder="例如:台電電費、中華電信"></label>
      <div class="two">
        <label>類別
          <select name="category">${CATEGORIES.map(([k, ic, label]) => `<option value="${k}" ${k === t.category ? 'selected' : ''}>${ic} ${label}</option>`).join('')}</select>
        </label>
        <label>預估金額 <input type="number" name="amount" inputmode="numeric" min="0" value="${esc(t.amount)}" placeholder="可不填"></label>
      </div>
      <div class="two">
        <label>繳費週期
          <select name="cycleMonths">${CYCLES.map(([n, label]) => `<option value="${n}" ${n === t.cycleMonths ? 'selected' : ''}>${label}</option>`).join('')}</select>
        </label>
        <label id="anchor" ${t.cycleMonths > 1 ? '' : 'hidden'}>哪個月會有帳單
          <select name="anchorMonth">${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}" ${i + 1 === t.anchorMonth ? 'selected' : ''}>${i + 1} 月</option>`).join('')}</select>
        </label>
      </div>
      <div class="two">
        <label>繳費單大約幾號到 <select name="arrivalDay">${dayOptions(t.arrivalDay)}</select></label>
        <label>截止日 <select name="dueDay">${dayOptions(t.dueDay)}</select></label>
      </div>
      <p class="muted small" id="due-hint"></p>
      <label>截止前幾天提醒 <input type="number" name="remindDays" min="0" max="30" value="${esc(t.remindDays)}"></label>
      <label class="switch"><input type="checkbox" name="active" ${t.active ? 'checked' : ''}> 啟用提醒</label>
      <label class="switch"><input type="checkbox" name="autoPay" ${t.autoPay ? 'checked' : ''}> 自動扣款</label>
      <span class="muted small switch-hint">到截止日自動記成「已繳(自動扣繳)」,不再提醒拿單、繳費。金額先用預估金額,可以再改。</span>
      ${accountFields(t)}
      <label>備註 <textarea name="notes" rows="2" placeholder="例如:電號、用戶編號">${esc(t.notes)}</textarea></label>
      <div class="form-actions">
        <button class="btn primary big" type="submit">儲存</button>
        ${isNew ? '' : '<button class="btn big danger" type="button" id="delete">刪除</button>'}
      </div>
    </form>
    ${isNew ? '' : await templateHistory(t)}`;

  const form = $('#t-form');
  const guard = guardForm();
  form.addEventListener('input', guard.markDirty);
  form.addEventListener('change', guard.markDirty);
  const read = () => ({
    ...t,
    name: form.elements.namedItem('name').value.trim(),
    category: form.category.value,
    amount: form.amount.value === '' ? '' : Number(form.amount.value),
    cycleMonths: Number(form.cycleMonths.value),
    anchorMonth: Number(form.anchorMonth.value),
    arrivalDay: Number(form.arrivalDay.value),
    dueDay: Number(form.dueDay.value),
    remindDays: Number(form.remindDays.value || 0),
    active: form.active.checked,
    autoPay: form.autoPay.checked,
    accountNo: digits(form.elements.namedItem('accountNo').value),
    bankCode: digits(form.elements.namedItem('bankCode').value),
    notes: form.notes.value.trim(),
  });
  const hint = () => {
    const cur = read();
    $('#anchor').hidden = cur.cycleMonths === 1;
    const n = nextPeriod(cur, todayISO());
    $('#due-hint').textContent = `${cur.dueDay < cur.arrivalDay ? '截止日比到單日早,視為隔月截止。' : ''}${n.arrival <= todayISO() ? '本期' : '下一期'}:${formatDate(n.arrival)} 到單、${formatDate(n.due)} 截止。`;
  };
  form.addEventListener('change', hint);
  form.addEventListener('click', (e) => {
    if (e.target.closest('[data-copy-account]')) copyText(digits(form.elements.namedItem('accountNo').value), '帳號');
  });
  hint();

  form.onsubmit = async (e) => {
    e.preventDefault();
    const saved = { ...read(), createdAt: t.createdAt || new Date().toISOString() };
    if (saved.autoPay && !t.autoPay) {
      // 剛開啟自動扣款:從今天起截止的期別才自動記錄
      saved.autoPayFrom = todayISO();
      saved.autoPayDone = '';
    }
    await db.put('templates', saved);
    guard.release();
    const n = await runAutoPay();
    toast(n ? `已儲存,並自動記錄 ${n} 筆自動扣款` : '已儲存');
    go('#/templates');
  };
  $('#delete')?.addEventListener('click', async () => {
    if (!(await confirmDialog({
      title: '刪除這個固定繳費?',
      message: `之後不會再提醒「${t.name}」。已經登記的帳單紀錄會保留。`,
      ok: '刪除',
      danger: true,
    }))) return;
    await db.del('templates', t.id);
    guard.release();
    go('#/templates');
  });
}

// ---------- 備份 ----------

/**
 * 備份:優先用分享選單(Android 可以直接選「雲端硬碟」,或 Gmail / LINE 傳給自己),
 * 不支援分享檔案時改成下載。成功(分享出去或已下載)才記下備份時間。
 */
async function backupNow() {
  toast('準備備份檔…');
  const data = await db.exportAll();
  const name = `bill-tracker-backup-${todayISO()}`;
  const json = JSON.stringify(data);
  // Chrome 的分享只允許特定副檔名;.json 不行時改用 .txt(匯入時兩種都收)
  const candidates = [
    new File([json], `${name}.json`, { type: 'application/json' }),
    new File([json], `${name}.txt`, { type: 'text/plain' }),
  ];
  const shareable = candidates.find((f) => navigator.canShare?.({ files: [f] }));
  let result = 'downloaded';
  if (shareable) {
    result = await shareFile(shareable);
    if (result === 'needs-gesture') {
      // 準備檔案花太久,瀏覽器不再把這次當成使用者點擊:請使用者再點一次
      const again = await ask({
        title: '備份檔準備好了',
        message: `約 ${Math.max(1, Math.round(json.length / 1024 / 1024))} MB。點「分享」選擇雲端硬碟,或傳給自己保存。`,
        actions: [{ label: '分享 / 存到雲端', value: true, kind: 'primary' }, { label: '改用下載', value: false }],
        cancelValue: null,
      });
      if (again === null) return toast('沒有備份');
      result = again ? await shareFile(shareable) : 'download';
    }
    if (result === 'cancelled') return toast('沒有備份');
    if (result !== 'shared') result = 'download';
  }
  if (result !== 'shared') download(`${name}.json`, json, 'application/json');
  await db.setMeta('lastBackupAt', new Date().toISOString());
  await db.setMeta('backupSnoozeUntil', '');
  toast(result === 'shared' ? '已備份(記得存到雲端硬碟或傳給自己)' : '備份檔已下載到手機的「下載」資料夾');
  render();
}

async function shareFile(file) {
  try {
    await navigator.share({ files: [file], title: '繳費小幫手備份' });
    return 'shared';
  } catch (e) {
    if (e.name === 'AbortError') return 'cancelled';
    if (e.name === 'NotAllowedError') return 'needs-gesture';
    console.warn('分享失敗', e);
    return 'failed';
  }
}

async function snoozeBackup() {
  await db.setMeta('backupSnoozeUntil', new Date(Date.now() + SNOOZE_DAYS * 86400000).toISOString());
  toast(`${SNOOZE_DAYS} 天後再提醒`);
  render();
}

// ---------- 設定 ----------

function download(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function renderSettings() {
  const persisted = await navigator.storage?.persisted?.();
  const all = await loadAll();
  const backup = await getBackupStatus(all.templates, all.bills);
  const backupAt = await db.getMeta('lastBackupAt');
  view.innerHTML = `
    <header class="page-head"><h1>設定</h1></header>
    <section class="card col">
      <h3>🔔 通知提醒</h3>
      ${await notifyStatusHTML()}
    </section>
    <section class="card col">
      <h3>📅 加到手機行事曆(準時、iPhone 也可用)</h3>
      <p class="muted small">把所有固定繳費匯出成行事曆檔,用手機打開匯入後,就算沒開這個 app,到單日和截止前也會跳提醒。之後修改了固定繳費,再匯出一次即可(同一個項目會更新,不會重複)。</p>
      <button class="btn primary" id="ics">匯出行事曆提醒 (.ics)</button>
    </section>
    <section class="card col">
      <h3>👋 新手引導</h3>
      <p class="muted small">在首頁重新顯示「加到主畫面、開啟通知、建立第一筆」的步驟。</p>
      <button class="btn" id="show-onboarding">在首頁顯示新手引導</button>
    </section>
    <section class="card col">
      <h3>💾 備份</h3>
      <p class="small backup-status ${backup.due ? 'due' : ''}">${esc(backupSummary(backup))}${backupAt ? `<span class="muted">(${formatDate(backupAt.slice(0, 10))})</span>` : ''}</p>
      <p class="muted small">資料只存在這支手機的瀏覽器裡。按「立即備份」會開分享選單,選「雲端硬碟」或傳給自己保存;
        換手機時在新手機「匯入備份」即可(包含照片與繳費證明)。該備份時首頁和通知會提醒你。${persisted ? '' : '<br>建議按「保護資料」,降低瀏覽器空間不足時自動清掉資料的機會。'}</p>
      <div class="btn-row">
        <button class="btn primary" id="export">立即備份</button>
        <label class="btn file-btn">匯入備份<input type="file" id="import" accept="application/json,.json,text/plain,.txt" hidden></label>
        <button class="btn" id="export-csv">匯出帳單 CSV</button>
        ${persisted ? '<span class="badge ok">資料已受保護</span>' : '<button class="btn" id="persist">保護資料</button>'}
      </div>
    </section>`;

  $('#ics').onclick = async () => {
    const { templates } = await loadAll();
    if (!templates.some((t) => t.active)) return toast('還沒有啟用中的固定繳費');
    download('bill-reminders.ics', buildICS(templates, todayISO()), 'text/calendar');
  };
  $('#notif')?.addEventListener('click', async () => {
    const ok = await enableNotifications();
    await render();
    if (ok) testNotification();
  });
  $('#notif-test')?.addEventListener('click', () => testNotification());
  $('#persist')?.addEventListener('click', async () => {
    const ok = await navigator.storage.persist();
    toast(ok ? '已保護資料' : '瀏覽器沒有同意,建議先「加入主畫面」後再試');
    render();
  });
  $('#show-onboarding').onclick = async () => {
    await db.setMeta('onboardingDismissed', false);
    go('#/');
  };
  $('#export-csv').onclick = async () => {
    const { bills } = await loadAll();
    if (!bills.length) return toast('還沒有帳單');
    download(`bills-all-${todayISO()}.csv`, billsToCSV(bills, catLabel), 'text/csv');
  };
  $('#export').onclick = () => backupNow();
  $('#import').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let data;
    let info;
    try {
      data = JSON.parse(await file.text());
      info = describeBackup(data);
    } catch (err) {
      return alertDialog({ title: '無法讀取這個檔案', message: err instanceof SyntaxError ? '檔案格式不對,請選「繳費小幫手」匯出的備份檔。' : err.message });
    }
    const { templates, bills } = await loadAll();
    const when = info.exportedAt ? new Date(info.exportedAt).toLocaleString('zh-TW', { dateStyle: 'medium', timeStyle: 'short' }) : '不明';
    if (!(await confirmDialog({
      title: '用這個備份取代目前的資料?',
      message: `備份時間:${when}\n備份內容:${info.bills} 筆帳單、${info.templates} 個固定繳費、${info.files} 個檔案\n\n`
        + `目前手機上的 ${bills.length} 筆帳單、${templates.length} 個固定繳費會被清掉,換成備份檔的內容。`,
      ok: '取代並匯入',
      danger: true,
    }))) return;
    try {
      await db.importAll(data);
      // 剛從備份還原,等於有一份最新備份
      await db.setMeta('lastBackupAt', info.exportedAt || new Date().toISOString());
      toast('匯入完成');
    } catch (err) {
      await alertDialog({ title: '匯入失敗', message: err.message });
    }
    render();
  };
}

// ---------- 啟動 ----------


// ---------- 通知 ----------

async function setupServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  try {
    // sw.js 用 import 共用提醒邏輯,所以要用 module 註冊
    await navigator.serviceWorker.register('sw.js', { type: 'module' });
  } catch (e) {
    console.warn('SW 註冊失敗', e);
    return;
  }
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const reg = await navigator.serviceWorker.ready;
  await registerBackgroundSync(reg);
  await notifyReminders(reg);
}

/** Android Chrome、已加到主畫面時,讓瀏覽器定期在背景叫醒 app 檢查帳單。回傳狀態字串。 */
async function registerBackgroundSync(reg) {
  if (!('periodicSync' in reg)) return 'unsupported';
  try {
    const { state } = await navigator.permissions.query({ name: 'periodic-background-sync' });
    if (state !== 'granted') return 'not-installed';
    await reg.periodicSync.register(SYNC_TAG, { minInterval: 6 * 60 * 60 * 1000 });
    return 'on';
  } catch (e) {
    console.warn('periodicSync 註冊失敗', e);
    return 'not-installed';
  }
}

/** 要求通知權限;成功回傳 true。 */
async function enableNotifications() {
  if (!('Notification' in window)) {
    toast('這個瀏覽器不支援通知');
    return false;
  }
  const result = await Notification.requestPermission();
  if (result !== 'granted') {
    toast('沒有開啟通知,之後可以在「設定」再開');
    return false;
  }
  const reg = await navigator.serviceWorker?.getRegistration();
  if (reg) await registerBackgroundSync(reg);
  toast('通知已開啟');
  return true;
}

const ANDROID_NOTIFY_HELP = '請到手機「設定 → 應用程式 → <b>繳費小幫手</b>(找不到就選 <b>Chrome</b>)→ 通知」把通知打開,'
  + '並確認沒有開「勿干擾」。改完回來再按一次測試。';

/**
 * 設定頁的「測試通知」:按下去當下就檢查權限(必要時直接跳出詢問),送出測試通知,
 * 再確認系統有沒有真的顯示,結果寫在按鈕下方,不會再「按了沒反應」。
 */
async function testNotification() {
  const box = $('#notif-result');
  const say = (html) => {
    if (!box) return toast(html.replace(/<[^>]+>/g, ''));
    box.hidden = false;
    box.innerHTML = html;
  };
  if (!('Notification' in window) || !('serviceWorker' in navigator)) return say('⚠️ 這個瀏覽器不支援通知。');
  say('⏳ 送出測試通知中…');
  let perm = Notification.permission;
  if (perm !== 'granted') perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    return say(`⚠️ 通知權限沒有開啟(目前狀態:${perm === 'denied' ? '已封鎖' : '還沒允許'})。<br>${ANDROID_NOTIFY_HELP}`);
  }
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return say('⚠️ app 還沒準備好(需要用 HTTPS 網址開啟),請重新整理後再試。');
  try {
    await sendTestNotification(reg);
  } catch (e) {
    return say(`⚠️ 通知送不出去:${esc(e.message || e)}<br>${ANDROID_NOTIFY_HELP}`);
  }
  await new Promise((r) => setTimeout(r, 1000));
  const shown = (await reg.getNotifications({ tag: TEST_TAG }).catch(() => [])).length > 0;
  say(shown
    ? `✅ 已送出測試通知,請看一下手機的通知列。<br><span class="muted small">如果沒看到:${ANDROID_NOTIFY_HELP}</span>`
    : `⚠️ 測試通知送出了,但系統沒有顯示,可能被手機擋下。<br>${ANDROID_NOTIFY_HELP}`);
}

async function notifyStatusHTML() {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) {
    return '<p class="muted small">這個瀏覽器不支援通知。iPhone 要先用 Safari「分享 → 加入主畫面」,再從主畫面打開 app。</p>';
  }
  const perm = Notification.permission;
  if (perm === 'denied') {
    return '<p class="muted small">通知被封鎖了。請到手機的「設定 → 應用程式 → Chrome(或這個 app)→ 通知」打開,再回來這裡。</p>';
  }
  if (perm === 'default') {
    return `<p class="muted small">開啟後:有快截止、逾期、該去拿繳費單的帳單時,手機會跳通知。</p>
      <button class="btn primary" id="notif">開啟通知</button>
      <div id="notif-result" class="notif-result small" hidden></div>`;
  }
  const reg = await navigator.serviceWorker.getRegistration();
  const bg = reg ? await registerBackgroundSync(reg) : 'unsupported';
  const bgText = {
    on: '✅ <b>背景提醒已啟用</b>:沒開 app 時,手機也會在白天跳通知(大約一天一次,實際時間由瀏覽器決定,省電模式下可能延後)。',
    'not-installed': '⚠️ 目前只有<b>打開 app 時</b>才會通知。要讓沒開 app 也能通知,請用 Chrome 選單的「加到主畫面 / 安裝應用程式」,再從主畫面的圖示打開。',
    unsupported: '⚠️ 這個瀏覽器只能在<b>打開 app 時</b>通知(背景提醒目前只有 Android 的 Chrome 支援)。要準時提醒,請用下面的「加到手機行事曆」。',
  }[bg];
  return `<p class="small">${bgText}</p>
    <button class="btn" id="notif-test">現在測試一次通知</button>
    <div id="notif-result" class="notif-result small" hidden></div>`;
}

/** 套用自動扣款(見 schedule.planAutoPay),回傳新記成已繳的筆數。 */
async function runAutoPay() {
  const { templates, bills } = await loadAll();
  const plan = planAutoPay(templates, bills, todayISO());
  const now = new Date().toISOString();
  for (const b of plan.create) await db.put('bills', { ...b, id: db.uid(), createdAt: now, updatedAt: now });
  for (const { id, paidDate } of plan.markPaid) {
    const b = await db.get('bills', id);
    await db.put('bills', { ...b, status: 'paid', paidDate, paidMethod: b.paidMethod || AUTO_PAY_METHOD, autoPaid: true, updatedAt: now });
  }
  for (const { id, autoPayDone } of plan.templateUpdates) {
    await db.put('templates', { ...(await db.get('templates', id)), autoPayDone });
  }
  return plan.create.length + plan.markPaid.length;
}

/** 清掉沒有任何帳單引用的檔案(例如新增帳單到一半直接關掉 app)。 */
async function collectGarbage() {
  const bills = await db.getAll('bills');
  const used = new Set(bills.flatMap((b) => [...(b.billFiles || []), ...(b.proofFiles || [])]));
  const dayAgo = Date.now() - 86400000;
  for (const f of await db.getAll('files')) {
    if (!used.has(f.id) && Date.parse(f.createdAt) < dayAgo) await db.del('files', f.id);
  }
}

async function render() {
  leaveGuard = null; // 每一頁自己決定要不要設
  currentHash = location.hash;
  objectUrls.forEach(URL.revokeObjectURL);
  objectUrls = [];
  const { parts, params } = parseHash();
  const [page = '', id] = parts;
  $$('nav.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === (page === 'bill' ? 'bills' : page === 'template' ? 'templates' : page)));
  try {
    if (page === 'bills') await renderBills(params);
    else if (page === 'bill') await renderBillForm(id, params);
    else if (page === 'templates') await renderTemplates();
    else if (page === 'template') await renderTemplateForm(id);
    else if (page === 'settings') await renderSettings();
    else await renderHome();
  } catch (err) {
    console.error(err);
    view.innerHTML = `<div class="empty">發生錯誤:${esc(err.message)}</div>`;
  }
  window.scrollTo(0, 0);
}

view.addEventListener('click', async (e) => {
  if (e.target.closest('[data-backup-now]')) return backupNow();
  if (e.target.closest('[data-backup-snooze]')) return snoozeBackup();
  if (e.target.closest('[data-install]') && installPrompt) {
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => null);
    installPrompt = null;
    render();
    return;
  }
  if (e.target.closest('[data-dismiss-onboarding]')) {
    await db.setMeta('onboardingDismissed', true);
    toast('之後可以在「設定 → 新手引導」再打開');
    render();
    return;
  }
  if (e.target.closest('[data-enable-notify]')) {
    await enableNotifications();
    render();
    return;
  }
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    e.preventDefault();
    copyText(copy.dataset.copy, '帳號');
    return;
  }
  const pay = e.target.closest('[data-pay]');
  if (pay) {
    e.preventDefault();
    markPaid(pay.dataset.pay);
  }
});
$('#viewer').addEventListener('click', (e) => e.currentTarget.close());
/** 程式裡要換頁時用:有沒存的變更就先問。 */
async function navigate(hash) {
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

(async () => {
  const autoPaid = await runAutoPay().catch((e) => { console.warn('自動扣款處理失敗', e); return 0; });
  await render();
  if (autoPaid) toast(`已自動記錄 ${autoPaid} 筆自動扣款`);
})();
collectGarbage();
setupServiceWorker();
