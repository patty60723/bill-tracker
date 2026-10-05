import * as db from './db.js';
import {
  addMonths, diffDays, formatDate, formatPeriod, parsePeriod, periodKey, todayISO,
} from './dates.js';
import { mergeScan } from './parse.js';
import {
  buildReminders, DEFAULT_REMIND_DAYS, monthSummary, nextPeriod, periodDates,
} from './schedule.js';
import { buildICS } from './ics.js';
import { compressImage, readBarcodes, readText } from './scan.js';

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
const PAY_METHODS = ['超商', 'ATM 轉帳', '網路/行動銀行', '信用卡', '行動支付', '郵局/臨櫃', '自動扣繳', '其他'];
const CYCLES = [[1, '每月'], [2, '每兩個月'], [3, '每季'], [6, '每半年'], [12, '每年']];
const dayLabel = (d) => (d >= 31 ? '月底' : `${d} 號`);
const dayOptions = (selected) => Array.from({ length: 28 }, (_, i) => i + 1).concat(31)
  .map((d) => `<option value="${d}" ${d === selected ? 'selected' : ''}>${dayLabel(d)}</option>`).join('');

let objectUrls = [];
function fileUrl(blob) {
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  return url;
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2400);
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
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

const REMINDER_TEXT = {
  'collect-soon': (r) => `繳費單預計 ${formatDate(r.arrival)} 會到`,
  collect: (r) => `該去拿繳費單了,${formatDate(r.due)} 截止(剩 ${diffDays(todayISO(), r.due)} 天)`,
  missing: (r) => `這期還沒登記,截止日 ${formatDate(r.due)} 已過`,
  overdue: (r) => `已逾期 ${-r.daysLeft} 天(${formatDate(r.due)} 截止)`,
  'due-soon': (r) => (r.daysLeft === 0 ? '今天截止!' : `剩 ${r.daysLeft} 天截止(${formatDate(r.due)})`),
  unpaid: (r) => `未繳,${formatDate(r.due)} 截止`,
};

function reminderCard(r) {
  const actions = r.billId
    ? `<button class="btn small primary" data-pay="${r.billId}">✓ 已繳</button>
       <a class="btn small" href="#/bill/${r.billId}">查看</a>`
    : `<a class="btn small primary" href="#/bill/new?template=${r.templateId}&period=${r.period}">登記帳單</a>`;
  return `<div class="card reminder ${r.level}">
    <div class="grow">
      <div class="title">${esc(r.name)} <span class="muted">${formatPeriod(r.period || '')}</span></div>
      <div class="sub">${esc(REMINDER_TEXT[r.kind](r))}${r.amount ? ` · ${money(r.amount)}` : ''}</div>
    </div>
    <div class="actions">${actions}</div>
  </div>`;
}

async function renderHome() {
  const { templates, bills } = await loadAll();
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
    <section>
      <h2>待辦提醒</h2>
      ${reminders.length ? reminders.map(reminderCard).join('') : `<div class="empty">目前沒有要處理的帳單 🎉${templates.length ? '' : '<br><a href="#/template/new">先設定固定繳費</a>,就會自動提醒你拿繳費單、繳費截止。'}</div>`}
    </section>
    <section>
      <h2>${m} 月帳單 <a class="link" href="#/bills">看全部 ›</a></h2>
      ${summaryBlock(s)}
    </section>`;
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
  const month = params.get('month') || today.slice(0, 7);
  const filter = params.get('filter') || 'all';
  const { year, month: mo } = parsePeriod(month);
  const prev = addMonths(year, mo, -1);
  const next = addMonths(year, mo, 1);
  const tById = new Map(templates.map((t) => [t.id, t]));
  const link = (mk, f) => `#/bills?month=${mk}&filter=${f}`;

  const list = bills
    .filter((b) => b.period === month)
    .filter((b) => filter === 'all' || (filter === 'paid' ? b.status === 'paid' : b.status !== 'paid'))
    .sort((a, b) => (a.status === 'paid') - (b.status === 'paid') || (a.dueDate || '').localeCompare(b.dueDate || ''));

  view.innerHTML = `
    <header class="page-head"><h1>繳費紀錄</h1></header>
    <div class="month-nav">
      <a class="btn small" href="${link(periodKey(prev.year, prev.month), filter)}">‹</a>
      <strong>${formatPeriod(month)}</strong>
      <a class="btn small" href="${link(periodKey(next.year, next.month), filter)}">›</a>
    </div>
    ${summaryBlock(monthSummary(bills, month))}
    <div class="chips">
      ${[['all', '全部'], ['unpaid', '未繳'], ['paid', '已繳']].map(([k, label]) => `<a class="chip ${k === filter ? 'on' : ''}" href="${link(month, k)}">${label}</a>`).join('')}
    </div>
    ${list.length ? list.map((b) => billRow(b, tById.get(b.templateId), today)).join('') : '<div class="empty">這個月沒有帳單</div>'}
    <a class="fab" href="#/bill/new?period=${month}" aria-label="新增帳單">＋</a>`;
}

function billRow(b, t, today) {
  const paid = b.status === 'paid';
  const left = b.dueDate ? diffDays(today, b.dueDate) : null;
  const badge = paid
    ? `<span class="badge ok">已繳 ${formatDate(b.paidDate)}</span>`
    : left != null && left < 0 ? '<span class="badge bad">逾期</span>'
      : '<span class="badge warn">未繳</span>';
  const clips = `${b.billFiles?.length ? '🧾' : ''}${b.proofFiles?.length ? '📎' : ''}`;
  return `<a class="card row" href="#/bill/${b.id}">
    <div class="icon">${catIcon(b.category || t?.category)}</div>
    <div class="grow">
      <div class="title">${esc(b.name)} <span class="muted">${clips}</span></div>
      <div class="sub">${b.dueDate ? `${formatDate(b.dueDate)} 截止` : '未填截止日'} ${badge}</div>
    </div>
    <div class="amount">${money(b.amount)}</div>
    ${paid ? '' : `<button class="btn small primary" data-pay="${b.id}">✓ 已繳</button>`}
  </a>`;
}

async function markPaid(id) {
  const b = await db.get('bills', id);
  b.status = 'paid';
  b.paidDate = todayISO();
  b.updatedAt = new Date().toISOString();
  await db.put('bills', b);
  toast(`「${b.name}」已標記為已繳,可以進去上傳繳費證明`);
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
      period, amount: t?.amount ?? '', dueDate: t ? periodDates(t, period).due : '',
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
        <button type="button" class="btn primary" id="scan-btn">📷 掃描繳費單</button>
        <span class="muted small">拍繳費單(條碼要拍清楚),自動帶入金額與截止日</span>
        <input type="file" id="scan-input" accept="image/*" capture="environment" hidden>
        <div id="scan-status" class="scan-status" hidden></div>
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
        <label>金額 <input type="number" name="amount" inputmode="numeric" min="0" step="1" value="${esc(bill.amount)}" placeholder="0"></label>
      </div>
      <label>繳費截止日 <input type="date" name="dueDate" value="${esc(bill.dueDate)}"></label>

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
    for (const f of fileList) {
      const fid = await db.saveFile(await compressImage(f), f.name);
      bill[key].push(fid);
      addedFiles.push(fid);
    }
    await redrawFiles();
  }

  form.addEventListener('change', async (e) => {
    const el = e.target;
    if (el.dataset.add) {
      await addFiles(el.dataset.add, el.files);
      el.value = '';
    } else if (el.name === 'paid') {
      $('#paid-fields').hidden = !el.checked;
      if (el.checked && !form.paidDate.value) form.paidDate.value = todayISO();
    } else if (el.name === 'templateId' && el.value) {
      const t = templates.find((x) => x.id === el.value);
      form.elements.namedItem('name').value = t.name;
      form.category.value = t.category || 'other';
      if (!form.amount.value && t.amount) form.amount.value = t.amount;
      if (!form.dueDate.value && form.period.value) form.dueDate.value = periodDates(t, form.period.value).due;
    }
  });

  form.addEventListener('click', async (e) => {
    const rm = e.target.closest('[data-remove]');
    if (rm) {
      const [key, fid] = rm.dataset.remove.split(':');
      bill[key] = bill[key].filter((x) => x !== fid);
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
  $('#scan-btn').onclick = () => $('#scan-input').click();
  $('#scan-input').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    await addFiles('billFiles', [file]);
    setStatus('🔍 辨識條碼中…');
    let barcodes = [];
    try {
      barcodes = await readBarcodes(file);
    } catch (err) {
      console.warn(err);
    }
    let result = mergeScan(barcodes, '');
    if ((result.amount == null || !result.dueDate) && navigator.onLine) {
      setStatus('🔤 條碼資訊不完整,改用文字辨識…(第一次需要下載辨識資料,約 10–20 秒)');
      try {
        const text = await readText(file, (p) => setStatus(`🔤 文字辨識中… ${Math.round(p * 100)}%`));
        result = mergeScan(barcodes, text);
      } catch (err) {
        console.warn(err);
      }
    }
    applyScan(result, barcodes);
  };

  function applyScan(r, barcodes) {
    const found = [];
    if (r.amount != null) {
      form.amount.value = r.amount;
      found.push(`金額 ${money(r.amount)}${r.source.amount === 'ocr' ? '(文字辨識)' : ''}`);
    }
    if (r.dueDate) {
      form.dueDate.value = r.dueDate;
      found.push(`截止日 ${r.dueDate}${r.source.dueDate === 'ocr' ? '(文字辨識)' : ''}`);
    }
    if (r.period && /^\d{4}-\d{2}$/.test(r.period)) form.period.value = r.period;
    setStatus(found.length
      ? `✅ 已帶入:${found.join('、')}<br><span class="muted small">請核對一下是否正確,文字辨識偶爾會看錯。</span>`
      : `⚠️ 沒辨識出金額或截止日,照片已存下,請手動填寫。${barcodes.length ? `<br><span class="muted small">讀到的條碼:${barcodes.map(esc).join(' / ')}</span>` : ''}`);
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
      amount: fd.get('amount') === '' ? '' : Number(fd.get('amount')),
      dueDate: fd.get('dueDate'),
      status: paid ? 'paid' : 'unpaid',
      paidDate: paid ? fd.get('paidDate') || todayISO() : '',
      paidMethod: paid ? fd.get('paidMethod') : '',
      notes: fd.get('notes').trim(),
      updatedAt: new Date().toISOString(),
      createdAt: bill.createdAt || new Date().toISOString(),
    };
    if (isNew && updated.templateId
      && bills.some((b) => b.templateId === updated.templateId && b.period === updated.period)
      && !confirm(`${formatPeriod(updated.period)}已經有一筆「${updated.name}」了,還要再新增一筆嗎?`)) return;
    await db.put('bills', updated);
    toast('已儲存');
    go(`#/bills?month=${updated.period}`);
  };
  $('#cancel')?.addEventListener('click', async () => {
    for (const fid of addedFiles) await db.del('files', fid);
    go('#/');
  });
  $('#delete')?.addEventListener('click', async () => {
    if (!confirm(`確定刪除「${bill.name}」這筆帳單和它的照片?`)) return;
    await db.deleteBill(await db.get('bills', bill.id));
    toast('已刪除');
    go(`#/bills?month=${bill.period}`);
  });
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
  return `${cycle} · ${dayLabel(t.arrivalDay)}左右到單 · ${due}截止`;
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
          ${n && t.active ? `<div class="sub">${n.arrival <= today ? '本期' : '下一期'}:${formatDate(n.arrival)} 到單、${formatDate(n.due)} 截止</div>` : ''}
        </div>
        <div class="amount">${t.amount ? `約 ${money(t.amount)}` : ''}</div>
      </a>`;
  }).join('') || '<div class="empty">還沒有固定繳費,按右下角 ＋ 新增</div>'}
    <a class="fab" href="#/template/new" aria-label="新增固定繳費">＋</a>`;
}

async function renderTemplateForm(id) {
  const isNew = id === 'new';
  const t = isNew
    ? {
      id: db.uid(), name: '', category: 'other', amount: '', cycleMonths: 1, anchorMonth: new Date().getMonth() + 1,
      arrivalDay: 1, dueDay: 15, remindDays: DEFAULT_REMIND_DAYS, active: true, notes: '',
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
      <label>備註 <textarea name="notes" rows="2" placeholder="例如:電號、繳費帳號">${esc(t.notes)}</textarea></label>
      <div class="form-actions">
        <button class="btn primary big" type="submit">儲存</button>
        ${isNew ? '' : '<button class="btn big danger" type="button" id="delete">刪除</button>'}
      </div>
    </form>`;

  const form = $('#t-form');
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
    notes: form.notes.value.trim(),
  });
  const hint = () => {
    const cur = read();
    $('#anchor').hidden = cur.cycleMonths === 1;
    const n = nextPeriod(cur, todayISO());
    $('#due-hint').textContent = `${cur.dueDay < cur.arrivalDay ? '截止日比到單日早,視為隔月截止。' : ''}${n.arrival <= todayISO() ? '本期' : '下一期'}:${formatDate(n.arrival)} 到單、${formatDate(n.due)} 截止。`;
  };
  form.addEventListener('change', hint);
  hint();

  form.onsubmit = async (e) => {
    e.preventDefault();
    await db.put('templates', { ...read(), createdAt: t.createdAt || new Date().toISOString() });
    toast('已儲存');
    go('#/templates');
  };
  $('#delete')?.addEventListener('click', async () => {
    if (!confirm(`刪除「${t.name}」?(已登記的帳單紀錄會保留)`)) return;
    await db.del('templates', t.id);
    go('#/templates');
  });
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
  const notif = 'Notification' in window ? Notification.permission : 'unsupported';
  const persisted = await navigator.storage?.persisted?.();
  view.innerHTML = `
    <header class="page-head"><h1>設定</h1></header>
    <section class="card col">
      <h3>📅 加到手機行事曆(最推薦)</h3>
      <p class="muted small">把所有固定繳費匯出成行事曆檔,用手機打開匯入後,就算沒開這個 app,到單日和截止前也會跳提醒。之後修改了固定繳費,再匯出一次即可(同一個項目會更新,不會重複)。</p>
      <button class="btn primary" id="ics">匯出行事曆提醒 (.ics)</button>
    </section>
    <section class="card col">
      <h3>🔔 開 app 時跳通知</h3>
      <p class="muted small">允許後,每天第一次打開 app 時,如果有快截止或逾期的帳單會跳通知。${notif === 'unsupported' ? '<br>這個瀏覽器不支援通知(iPhone 需要先「加入主畫面」)。' : ''}</p>
      <button class="btn" id="notif" ${notif === 'unsupported' || notif === 'granted' ? 'disabled' : ''}>${notif === 'granted' ? '已允許通知' : notif === 'denied' ? '通知被封鎖了,請到瀏覽器設定開啟' : '允許通知'}</button>
    </section>
    <section class="card col">
      <h3>💾 備份</h3>
      <p class="muted small">資料只存在這支手機的瀏覽器裡。換手機或清除瀏覽器資料前,請先匯出備份(包含照片與繳費證明)。${persisted ? '' : '<br>建議按「保護資料」,降低瀏覽器空間不足時自動清掉資料的機會。'}</p>
      <div class="btn-row">
        <button class="btn" id="export">匯出備份</button>
        <label class="btn file-btn">匯入備份<input type="file" id="import" accept="application/json,.json" hidden></label>
        ${persisted ? '<span class="badge ok">資料已受保護</span>' : '<button class="btn" id="persist">保護資料</button>'}
      </div>
    </section>`;

  $('#ics').onclick = async () => {
    const { templates } = await loadAll();
    if (!templates.some((t) => t.active)) return toast('還沒有啟用中的固定繳費');
    download('bill-reminders.ics', buildICS(templates, todayISO()), 'text/calendar');
  };
  $('#notif').onclick = async () => {
    await Notification.requestPermission();
    render();
  };
  $('#persist')?.addEventListener('click', async () => {
    const ok = await navigator.storage.persist();
    toast(ok ? '已保護資料' : '瀏覽器沒有同意,建議先「加入主畫面」後再試');
    render();
  });
  $('#export').onclick = async () => {
    download(`bill-tracker-backup-${todayISO()}.json`, JSON.stringify(await db.exportAll()), 'application/json');
  };
  $('#import').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file || !confirm('匯入會「取代」目前所有資料,確定嗎?')) return;
    try {
      await db.importAll(JSON.parse(await file.text()));
      toast('匯入完成');
    } catch (err) {
      alert(`匯入失敗:${err.message}`);
    }
    render();
  };
}

// ---------- 啟動 ----------

async function notifyIfNeeded() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const today = todayISO();
  try {
    if (localStorage.getItem('lastNotified') === today) return;
  } catch { /* 無法讀 localStorage 就每次都通知 */ }
  const { templates, bills } = await loadAll();
  const urgent = buildReminders(templates, bills, today).filter((r) => r.level !== 'info');
  if (!urgent.length) return;
  const body = urgent.slice(0, 4).map((r) => `${r.name}:${REMINDER_TEXT[r.kind](r)}`).join('\n');
  const reg = await navigator.serviceWorker?.getRegistration();
  const opts = { body, tag: 'bill-reminder', icon: 'icon.svg' };
  if (reg) await reg.showNotification(`有 ${urgent.length} 筆帳單要處理`, opts);
  else new Notification(`有 ${urgent.length} 筆帳單要處理`, opts);
  try { localStorage.setItem('lastNotified', today); } catch { /* ignore */ }
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

view.addEventListener('click', (e) => {
  const pay = e.target.closest('[data-pay]');
  if (pay) {
    e.preventDefault();
    markPaid(pay.dataset.pay);
  }
});
$('#viewer').addEventListener('click', (e) => e.currentTarget.close());
window.addEventListener('hashchange', render);

render();
notifyIfNeeded();
collectGarbage();
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW 註冊失敗', e));
}
