// 帳單表單:新增 / 編輯、掃描(拍照、相簿、即時條碼)、照片與繳費證明。

import { formatDate, formatPeriod, todayISO } from '../dates.js';
import * as db from '../db.js';
import { liveScan } from '../livescan.js';
import { ask, confirmDialog } from '../modal.js';
import { mergeScan, parseConvenienceBarcodes, scanComplete } from '../parse.js';
import { compressImage, imageSize, readBarcodes, readText } from '../scan.js';
import { CYCLES as BILL_CYCLES, DEFAULT_REMIND_DAYS, nextPeriod, periodDates, suggestTemplateDays } from '../schedule.js';
import { loadAll, runAutoPay } from '../ui/actions.js';
import { accountFields, CATEGORIES, cycleText, dayOptions, PAY_METHODS } from '../ui/components.js';
import { $, accountText, copyText, digits, esc, fileUrl, money, showImage, toast, view } from '../ui/dom.js';
import { go, guardForm, navigate } from '../ui/router.js';

export async function renderBillForm(id, params) {
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
export function describeBarcodes(texts) {
  const r = parseConvenienceBarcodes(texts);
  const row = (ok, label, value) => `<div class="${ok ? 'ok' : 'muted'}">${ok ? '✅' : '⬜'} ${label}${ok ? `:${value}` : ':還沒讀到'}</div>`;
  const others = texts.length - (r.dueDate ? 1 : 0) - (r.amount != null ? 1 : 0);
  return row(!!r.dueDate, '截止日(第一段條碼)', r.dueDate ? formatDate(r.dueDate) : '')
    + row(r.amount != null, '金額(第三段條碼)', money(r.amount))
    + (others > 0 ? `<div class="muted small">另外讀到 ${others} 個條碼</div>` : '');
}
