// 固定繳費:列表、表單、每期繳費紀錄。

import { formatDate, formatPeriod, todayISO } from '../dates.js';
import * as db from '../db.js';
import { confirmDialog } from '../modal.js';
import { DEFAULT_REMIND_DAYS, nextPeriod } from '../schedule.js';
import { loadAll, runAutoPay } from '../ui/actions.js';
import { accountFields, billRow, CATEGORIES, catIcon, CYCLES, cycleText, dayOptions } from '../ui/components.js';
import { $, accountText, copyText, digits, esc, money, toast, view } from '../ui/dom.js';
import { go, guardForm } from '../ui/router.js';

export async function renderTemplates() {
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
export async function templateHistory(t) {
  const today = todayISO();
  const list = (await db.getAll('bills')).filter((b) => b.templateId === t.id)
    .sort((a, b) => b.period.localeCompare(a.period));
  return `<section class="history">
    <h2>繳費紀錄(${list.length})</h2>
    ${list.length ? list.map((b) => `<div class="muted small group-label">${formatPeriod(b.period)}</div>${billRow(b, t, today)}`).join('')
    : '<div class="empty">還沒有帳單</div>'}
  </section>`;
}

export async function renderTemplateForm(id) {
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
