import * as db from './db.js';
import {
  addMonths, diffDays, formatDate, formatPeriod, parsePeriod, periodKey, todayISO,
} from './dates.js';
import { mergeScan, parseConvenienceBarcodes, scanComplete } from './parse.js';
import { liveScan } from './livescan.js';
import {
  buildReminders, CYCLES as BILL_CYCLES, cycleName, DEFAULT_REMIND_DAYS, monthSummary, nextPeriod, periodDates,
  suggestTemplateDays,
} from './schedule.js';
import { buildICS } from './ics.js';
import { compressImage, readBarcodes, readText } from './scan.js';
import { notifyReminders, REMINDER_TEXT, SYNC_TAG } from './notify.js';

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
    prompt(`請長按複製${label}`, text);
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
    ${notifyBanner(templates.length + bills.length)}
    <section>
      <h2>待辦提醒</h2>
      ${reminders.length ? reminders.map((r) => reminderCard(r, bills.find((b) => b.id === r.billId))).join('') : `<div class="empty">目前沒有要處理的帳單 🎉${templates.length ? '' : '<br><a href="#/template/new">先設定固定繳費</a>,就會自動提醒你拿繳費單、繳費截止。'}</div>`}
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
  const [cls, label] = paid ? ['ok', `已繳 ${formatDate(b.paidDate)}`]
    : left == null ? ['warn', '未繳']
      : left < 0 ? ['bad', `逾期 ${-left} 天`]
        : left === 0 ? ['bad', '今天截止']
          : left <= 7 ? ['warn', `剩 ${left} 天`]
            : ['warn', '未繳'];
  const meta = [b.dueDate ? `${formatDate(b.dueDate)} 截止` : '未填截止日'];
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

async function markPaid(id) {
  const before = await db.get('bills', id);
  await db.put('bills', { ...before, status: 'paid', paidDate: todayISO(), updatedAt: new Date().toISOString() });
  toast(`「${before.name}」已標記為已繳`, {
    label: '復原',
    onClick: async () => {
      await db.put('bills', before);
      toast('已復原為未繳');
      render();
    },
  });
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
        <div class="scan-buttons">
          <button type="button" class="btn primary" id="scan-btn">📷 拍照辨識</button>
          <button type="button" class="btn" id="live-btn">▦ 對準條碼掃</button>
        </div>
        <span class="muted small">拍整張繳費單自動帶入金額、截止日;條碼讀不到時用「對準條碼掃」,鏡頭靠近條碼掃</span>
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
  const scan = { barcodes: new Set(), texts: [], errors: [] };
  const barcodesEnough = (t) => {
    const r = parseConvenienceBarcodes(t);
    return !!(r.dueDate && r.amount != null);
  };
  $('#scan-btn').onclick = () => $('#scan-input').click();
  $('#scan-input').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    await addFiles('billFiles', [file]);
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
          isEnough: (t) => scanComplete(mergeScan([...scan.barcodes], t)),
          onProgress: (p) => setStatus(p.loading
            ? '🔤 載入文字辨識…(第一次需要下載約 12 MB,之後就不用)'
            : `🔤 文字辨識中…${p.pass > 1 ? '(換個方式再讀一次)' : ''} ${Math.round(p.progress * 100)}%`),
        });
        scan.texts = texts;
        result = mergeScan([...scan.barcodes], texts);
      } catch (err) {
        console.warn(err);
        scan.errors.push(`文字辨識:${err?.message || err}`);
      }
    }
    applyScan(result);
  };
  $('#live-btn').onclick = async () => {
    const codes = await liveScan({ describe: describeBarcodes, isEnough: barcodesEnough });
    if (!codes) return;
    codes.forEach((c) => scan.barcodes.add(c));
    applyScan(mergeScan([...scan.barcodes], scan.texts));
  };

  function applyScan(r) {
    const barcodes = [...scan.barcodes];
    const found = [];
    const missing = [];
    const via = (src) => ({ barcode: '條碼', ocr: '文字辨識', guess: '推測' }[src]);
    if (r.amount != null) {
      field('amount').value = r.amount;
      found.push(`金額 ${money(r.amount)}(${via(r.source.amount)})`);
    } else missing.push('金額');
    if (r.dueDate) {
      field('dueDate').value = r.dueDate;
      found.push(`截止日 ${formatDate(r.dueDate)}(${via(r.source.dueDate)})`);
    } else missing.push('截止日');
    if (r.period && /^\d{4}-\d{2}$/.test(r.period)) field('period').value = r.period;
    if (r.cycleMonths) field('cycleMonths').value = r.cycleMonths;
    // 帳單沒寫月份、截止日又離目前選的月份很遠(例如掃去年的稅單):帳單月份改成截止日那個月
    if (!r.period && r.dueDate && field('period').value) {
      const [py, pm] = field('period').value.split('-').map(Number);
      const [dy, dm] = r.dueDate.split('-').map(Number);
      if (Math.abs((dy * 12 + dm) - (py * 12 + pm)) > 1) field('period').value = r.dueDate.slice(0, 7);
    }
    if (r.accountNo && !field('accountNo').value) {
      field('accountNo').value = r.accountNo;
      if (r.bankCode) field('bankCode').value = r.bankCode;
      found.push(r.taxQr ? `繳款類別 ${r.bankCode}、銷帳編號 ${r.accountNo}` : `繳費帳號 ${accountText(r)}`);
    }

    const lines = [];
    if (found.length) lines.push(`✅ 已帶入:${found.join('、')}`);
    if (r.source.dueDate === 'guess') lines.push('⚠️ 帳單上沒找到「繳費期限」之類的字,截止日是用帳單上最晚的日期<b>推測</b>的,請一定要核對。');
    if (missing.length) lines.push(`⚠️ 沒辨識出${missing.join('、')},請手動填寫。`);
    if (r.source.dueDate !== 'barcode' && !barcodesEnough(barcodes)) {
      lines.push('💡 截止日、金額最準的來源是帳單下方的超商條碼。條碼沒讀到的話,按「▦ 對準條碼掃」把鏡頭靠近條碼試試。');
    }
    lines.push('<span class="muted small">照片已存下。辨識偶爾會看錯,存檔前請核對。</span>');
    const detail = [
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
      && !confirm(`${formatPeriod(updated.period)}已經有一筆「${updated.name}」了,還要再新增一筆嗎?`)) return;
    let savedTemplate = false;
    if (!updated.templateId && fd.get('saveTemplate') === 'on') {
      const t = { ...draftTemplate(), createdAt: new Date().toISOString() };
      await db.put('templates', t);
      updated.templateId = t.id;
      savedTemplate = true;
    }
    await db.put('bills', updated);
    toast(savedTemplate ? '已儲存,也加進固定繳費了' : '已儲存');
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
          ${t.accountNo ? `<div class="sub">帳號 ${esc(accountText(t))}</div>` : ''}
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
      ${accountFields(t)}
      <label>備註 <textarea name="notes" rows="2" placeholder="例如:電號、用戶編號">${esc(t.notes)}</textarea></label>
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
  const persisted = await navigator.storage?.persisted?.();
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
  $('#notif')?.addEventListener('click', async () => {
    await enableNotifications();
    render();
  });
  $('#notif-test')?.addEventListener('click', async () => {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (!reg) return toast('通知需要用 HTTPS 開啟 app 才能用');
    await notifyReminders(reg, { force: true });
  });
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

async function enableNotifications() {
  if (!('Notification' in window)) return toast('這個瀏覽器不支援通知');
  const result = await Notification.requestPermission();
  if (result !== 'granted') return toast('沒有開啟通知,之後可以在「設定」再開');
  const reg = await navigator.serviceWorker?.getRegistration();
  if (!reg) return;
  await registerBackgroundSync(reg);
  toast('通知已開啟');
  await notifyReminders(reg);
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
      <button class="btn primary" id="notif">開啟通知</button>`;
  }
  const reg = await navigator.serviceWorker.getRegistration();
  const bg = reg ? await registerBackgroundSync(reg) : 'unsupported';
  const bgText = {
    on: '✅ <b>背景提醒已啟用</b>:沒開 app 時,手機也會在白天跳通知(大約一天一次,實際時間由瀏覽器決定,省電模式下可能延後)。',
    'not-installed': '⚠️ 目前只有<b>打開 app 時</b>才會通知。要讓沒開 app 也能通知,請用 Chrome 選單的「加到主畫面 / 安裝應用程式」,再從主畫面的圖示打開。',
    unsupported: '⚠️ 這個瀏覽器只能在<b>打開 app 時</b>通知(背景提醒目前只有 Android 的 Chrome 支援)。要準時提醒,請用下面的「加到手機行事曆」。',
  }[bg];
  return `<p class="small">${bgText}</p>
    <button class="btn" id="notif-test">現在測試一次通知</button>`;
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

view.addEventListener('click', async (e) => {
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
window.addEventListener('hashchange', render);

render();
collectGarbage();
setupServiceWorker();
