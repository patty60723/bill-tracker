// 帳單表單:新增 / 編輯、掃描(拍照、相簿、即時條碼)、照片與繳費證明。

import { formatDate, formatPeriod, todayISO } from '../dates.js';
import * as db from '../db.js';
import { liveScan } from '../livescan.js';
import { ask, confirmDialog, passwordDialog } from '../modal.js';
import { mergeScan, parseConvenienceBarcodes, scanComplete } from '../parse.js';
import { isPdf, readPdf } from '../pdf.js';
import { matchTemplate, scanHintsFrom } from '../profiles.js';
import { compressImage, imageSize, readBarcodes, readText } from '../scan.js';
import { CYCLES as BILL_CYCLES, DEFAULT_REMIND_DAYS, nextPeriod, periodDates, suggestTemplateDays } from '../schedule.js';
import { loadAll, runAutoPay } from '../ui/actions.js';
import { accountFields, CATEGORIES, cycleText, dayOptions, PAY_METHODS } from '../ui/components.js';
import { $, accountText, copyText, digits, esc, fileUrl, money, showImage, toast, view } from '../ui/dom.js';
import { go, guardForm, navigate } from '../ui/router.js';
import { progressHTML, resultHTML } from '../ui/scan-view.js';
import { takeSharedFiles } from '../ui/share.js';
import { ackInbox, cachedInboxItems, inboxFile } from '../inbox.js';

export async function renderBillForm(id, params) {
  const { templates, bills } = await loadAll();
  const debug = !!(await db.getMeta('debugMode')); // 開發者模式:顯示辨識細節(設定頁)
  const isNew = id === 'new';
  let bill;
  if (isNew) {
    const t = templates.find((x) => x.id === params.get('template'));
    const period = params.get('period') || todayISO().slice(0, 7);
    bill = {
      id: db.uid(), name: t?.name || '', templateId: t?.id || '', category: t?.category || 'other',
      period, cycleMonths: t?.cycleMonths || 1, amount: t?.amount ?? '', dueDate: t ? periodDates(t, period).due : '',
      accountNo: t?.accountNo || '', bankCode: t?.bankCode || '', inCardBill: !!t?.inCardBill,
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
            <span class="tile-icon">🖼️</span><b>從相簿選</b><span>照片或 PDF 帳單</span>
            <input type="file" id="pick-input" accept="image/*,application/pdf,.pdf" hidden>
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

<label class="switch"><input type="checkbox" name="inCardBill" ${bill.inCardBill ? 'checked' : ''}> 已包含在信用卡帳單裡</label>
      <span class="muted small switch-hint">用信用卡扣款、而且你也有記那張信用卡帳單時勾選:統計不重複計算(帳單照樣提醒、照樣記已繳)。</span>
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
    inCardBill: field('inCardBill').checked,
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

  /** 選了固定繳費:名稱、類別、週期跟著它;金額、帳號、截止日只補空著的。set 可以換成掃描用的 fill(記得原值)。 */
  function applyTemplate(t, set = (name, value) => { field(name).value = value; }) {
    set('name', t.name);
    set('category', t.category || 'other');
    set('cycleMonths', t.cycleMonths || 1);
    if (!field('amount').value && t.amount) set('amount', t.amount);
    if (!field('accountNo').value && t.accountNo) {
      set('accountNo', t.accountNo);
      set('bankCode', t.bankCode || '');
    }
    if (!field('dueDate').value && field('period').value) set('dueDate', periodDates(t, field('period').value).due);
    if (t.inCardBill) set('inCardBill', true);
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
      if (el.value) applyTemplate(templates.find((x) => x.id === el.value));
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
    barcodes: new Set(), texts: [], layouts: [], labels: [], errors: [], size: null, // layouts:每次 OCR 的版面;labels:用的引擎
    pageAmounts: [], // 每一頁各自讀到的金額(同一張帳單多頁時加總用)
    engines: '', sources: {}, // 診斷用:各條碼引擎的次數/耗時、每個條碼是誰讀到的
    photos: [], // 掃描時加進來的照片 id
    before: {}, // 欄位被掃描改寫前的值
    filled: {}, // 掃描寫進欄位的值
  });
  let scan = newScanState();
  const hasScan = () => scan.barcodes.size > 0 || scan.texts.length > 0 || scan.photos.length > 0;
  /** 掃描結果寫進欄位,並記下原值,換帳單時才還原得回去。 */
  const fill = (name, value) => {
    const el = field(name);
    const prop = el.type === 'checkbox' ? 'checked' : 'value';
    if (!(name in scan.before)) scan.before[name] = el[prop];
    el[prop] = value;
    scan.filled[name] = el[prop];
  };
  /** 清掉上一次掃描的影響:條碼/文字、它帶入的欄位(使用者之後自己改過的保留)、它加的照片。 */
  async function resetScan() {
    for (const [name, value] of Object.entries(scan.filled)) {
      const el = field(name);
      const prop = el.type === 'checkbox' ? 'checked' : 'value';
      if (el[prop] === value) el[prop] = scan.before[name];
    }
    for (const fid of scan.photos) {
      bill.billFiles = bill.billFiles.filter((x) => x !== fid);
      await db.del('files', fid);
    }
    scan = newScanState();
    $('#save-template').hidden = !!field('templateId').value;
    status.hidden = true;
    await redrawFiles();
  }
  /** 已經掃過一張時,問這次是「另一張帳單」還是「同一張的另一頁」。回傳 false 代表使用者取消。 */
  /** 回傳這次掃描的模式:'first'(第一次)、'another'(另一張,已清掉上一張)、'same'(同一張的另一頁),取消回傳 null。 */
  async function startScan() {
    if (!hasScan()) return 'first';
    const choice = await ask({
      title: '這個表單已經掃過一張了',
      message: '這次要掃的是?',
      stacked: true,
      actions: [
        { label: '另一張帳單', desc: '清掉上一張帶入的資料和照片,重新辨識', value: 'another', kind: 'primary' },
        { label: '同一張帳單的另一頁', desc: '合併兩次的結果(例如正反面、電信費和代收費用分兩頁)', value: 'same' },
        { label: '取消', value: null },
      ],
    });
    if (choice === 'another') await resetScan();
    return choice;
  }
  /**
   * 同一張帳單的另一頁也有金額、而且跟目前的不一樣:問要加總(多頁是不同的費用,例如台灣大哥大的電信費
   * 和代收費用分兩頁、拆兩筆扣款)、用這一頁的,還是維持原本的。回傳 { value, source, pages? } 或 null。
   */
  async function askPageAmount(pageAmount) {
    const prev = field('amount').value === '' ? null : Number(field('amount').value);
    if (pageAmount == null || prev == null || pageAmount === prev) return null;
    const pages = [...(scan.pageAmounts.length ? scan.pageAmounts : [prev]), pageAmount];
    const sum = pages.reduce((a, n) => a + n, 0);
    const choice = await ask({
      title: '這一頁也有金額',
      message: `這一頁是 ${money(pageAmount)},前面是 ${money(prev)}。`,
      stacked: true,
      actions: [
        { label: `加總 ${money(sum)}`, desc: `${pages.map(money).join(' + ')}:每一頁是不同的費用`, value: 'sum', kind: 'primary' },
        { label: `用這一頁的 ${money(pageAmount)}`, desc: '這一頁才是總額', value: 'page' },
        { label: `維持 ${money(prev)}`, value: 'keep' },
      ],
    });
    if (choice === 'sum') return { value: sum, source: 'sum', pages };
    if (choice === 'page') return { value: pageAmount, source: 'ocr' };
    return { value: prev, source: 'keep' };
  }
  const barcodesEnough = (t) => {
    const r = parseConvenienceBarcodes(t);
    return !!(r.dueDate && r.amount != null);
  };
  /** 文字辨識進度 → 步驟的說明與進度條。 */
  function ocrProgress(p) {
    if (p.engine === 'paddle') {
      return p.loading ? { note: '載入中(第一次要下載約 22 MB,可以先到設定頁預先下載)' } : { note: '辨識帳單上的文字', progress: p.progress || 0 };
    }
    return p.loading ? { note: '換另一種方式辨識,載入中' } : { note: `換另一種方式再讀一次${p.pass > 1 ? `(第 ${p.pass} 次)` : ''}`, progress: p.progress || 0 };
  }
  /** 條碼步驟的結果說明。 */
  function barcodeNote(bc, count) {
    if (bc.taxQr) return '讀到稅單 QR Code';
    const got = [bc.dueDate && '截止日', bc.amount != null && '金額'].filter(Boolean);
    if (got.length) return `從條碼讀到${got.join('、')}`;
    return count ? `讀到 ${count} 個條碼,但不是超商代收條碼` : '這張照片沒讀到條碼';
  }
  /** 為什麼要跑文字辨識:條碼不完整,還是條碼齊了只是要找帳號。 */
  function ocrReason(bc) {
    if (bc.taxQr || (bc.dueDate && bc.amount != null)) return '找帳單上的繳費帳號';
    return '從帳單上的文字找金額、截止日、帳號';
  }
  /** 辨識細節裡的條碼解讀:台灣超商三段式條碼各段有沒有讀到。 */
  function barcodeSummary(bc) {
    if (bc.taxQr) return '稅單 QR Code ✓';
    return [
      `第一段(截止日)${bc.dueDate ? `✓ ${formatDate(bc.dueDate)}` : '✗ 沒讀到'}`,
      `第三段(金額)${bc.amount != null ? `✓ ${money(bc.amount)}` : '✗ 沒讀到'}`,
    ].join(' · ');
  }
  $('#scan-btn').onclick = () => $('#scan-input').click();
  $('#pick-input').onchange = (e) => $('#scan-input').onchange(e);
  $('#scan-input').onchange = (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) scanFile(file);
  };
  /** 辨識一個檔案(拍照、相簿選的照片或 PDF、從別的 app 分享過來的)。 */
  async function scanFile(file) {
    const mode = await startScan();
    if (!mode) return;
    scan.timings = [];
    const pdf = isPdf(file);
    const steps = [
      ...(pdf ? [{ id: 'pdf', label: '讀取 PDF', state: 'active', note: '打開檔案、讀出每一頁' }] : []),
      { id: 'barcode', label: '讀條碼', state: pdf ? 'pending' : 'active', note: '找帳單上的超商條碼、QR Code' },
      { id: 'ocr', label: '文字辨識', state: 'pending' },
      { id: 'parse', label: '整理結果', state: 'pending' },
    ];
    const step = (id, patch) => {
      Object.assign(steps.find((x) => x.id === id), patch);
      setStatus(progressHTML(steps));
    };
    setStatus(progressHTML(steps));

    // PDF 電子帳單:讀出每一頁的文字和畫成圖片;照片就是它自己
    let images = [file];
    let pdfPages = null;
    if (pdf) {
      const t0 = performance.now();
      try {
        // 先試記住的密碼(設定頁可以清除),都不對才問
        const saved = [...((await db.getMeta('pdfPasswords')) || [])];
        const triedSaved = saved.length;
        let prompted = 0;
        let toRemember = null;
        const doc = await readPdf(file, {
          askPassword: async (wrong) => {
            if (saved.length) return saved.shift();
            const r = await passwordDialog({
              title: wrong && prompted ? '密碼不對,再試一次' : '這個 PDF 有密碼',
              message: (triedSaved && !prompted ? `記住的 ${triedSaved} 組密碼都打不開。` : '')
                + '電子帳單的密碼通常是身分證字號(英文字母大寫)、生日或手機號碼,寄帳單的通知信裡會寫。',
            });
            prompted++;
            toRemember = r?.remember ? r.password : null;
            return r ? r.password : null;
          },
        });
        if (doc && toRemember) {
          const list = (await db.getMeta('pdfPasswords')) || [];
          if (!list.includes(toRemember)) await db.setMeta('pdfPasswords', [...list, toRemember]);
        }
        if (!doc) {
          status.hidden = true;
          return toast('沒有輸入密碼,已取消');
        }
        pdfPages = doc.pages;
        images = doc.pages.map((pg) => pg.image);
        scan.size = { width: doc.pages[0].width, height: doc.pages[0].height };
        const withText = doc.pages.some((pg) => pg.hasText);
        step('pdf', { state: 'done', note: `${doc.numPages} 頁${withText ? ',有文字可以直接讀' : ',是掃描的圖片,要用文字辨識'}` });
      } catch (err) {
        console.warn(err);
        scan.errors.push(`PDF:${err?.message || err}`);
        setStatus(`<ul class="scan-list scan-warnings"><li>⚠️ 讀不出這個 PDF(${esc(err?.message || err)})。可以截圖後改用「從相簿選」。</li></ul>`);
        return;
      }
      scan.timings.push({ label: `讀取 PDF(${pdfPages.length} 頁)`, ms: performance.now() - t0 });
      scan.screenshot = false;
      step('barcode', { state: 'active' });
    } else {
      scan.size = await imageSize(file);
      scan.screenshot = file.type === 'image/png'; // 手機截圖是 PNG,相機拍的是 JPEG/HEIC
    }
    scan.photos.push(...await addFiles('billFiles', [file])); // PDF 存原檔,之後可以點開看

    const codes = [];
    for (const img of images) {
      const r = await readBarcodes(img, { isEnough: (t) => barcodesEnough([...codes, ...t]), timings: scan.timings });
      codes.push(...r.texts.filter((c) => !codes.includes(c)));
      scan.engines = scan.engines && images.length > 1 ? `${scan.engines} | ${r.engines}` : r.engines;
      Object.assign(scan.sources, r.sources);
      scan.errors.push(...r.errors);
      if (barcodesEnough(codes)) break;
    }
    codes.forEach((c) => scan.barcodes.add(c));
    const bc = parseConvenienceBarcodes(codes);
    step('barcode', { state: 'done', note: barcodeNote(bc, codes.length) });
    // 這一頁自己的結果(同一張帳單的另一頁時,要不要文字辨識看這一頁,不看前面幾頁合併的)
    const pageTexts = [];
    const pageLayouts = [];
    const pageResult = () => mergeScan(codes, pageTexts, undefined, pageLayouts);
    const addTexts = (texts, layouts, labels) => {
      pageTexts.push(...texts);
      pageLayouts.push(...layouts);
      scan.texts.push(...texts);
      scan.layouts.push(...layouts);
      scan.labels.push(...labels);
    };
    if (pdfPages?.some((pg) => pg.hasText)) {
      // PDF 裡本來就有文字:直接用,不用辨識(又快又準)
      const pages = pdfPages.map((pg, i) => ({ ...pg, n: i + 1 })).filter((pg) => pg.hasText);
      addTexts(pages.map((pg) => pg.text), pages.map((pg) => pg.layout), pages.map((pg) => `PDF 文字・第 ${pg.n} 頁`));
      step('ocr', { state: 'done', label: '讀文字', note: '直接讀 PDF 裡的文字(不用辨識)' });
    } else if (!scanComplete(pageResult()) || !field('accountNo').value) {
      // 條碼已經有金額和截止日、只缺帳號時,也跑一次文字辨識,看帳單上有沒有寫轉帳帳號
      const reason = ocrReason(bc);
      step('ocr', { state: 'active', note: reason });
      try {
        const { texts, layouts, labels, errors: ocrErrors } = await readText(images[0], {
          timings: scan.timings,
          isEnough: (t, l) => scanComplete(mergeScan(codes, t, undefined, l)),
          onProgress: (p) => step('ocr', ocrProgress(p)),
        });
        addTexts(texts, layouts, labels);
        scan.errors.push(...ocrErrors);
        step('ocr', { state: 'done', note: reason, progress: null });
      } catch (err) {
        console.warn(err);
        scan.errors.push(`文字辨識:${err?.message || err}`);
        step('ocr', { state: 'done', note: '文字辨識失敗,只用條碼的結果', progress: null });
      }
    } else {
      step('ocr', { state: 'skip', note: '條碼的資料已經夠了' });
    }
    step('parse', { state: 'active' });
    const pageAmount = pageResult().amount;
    const amount = mode === 'same' ? await askPageAmount(pageAmount) : null;
    if (pageAmount != null) scan.pageAmounts.push(pageAmount);
    return applyScan(mergeScan([...scan.barcodes], scan.texts, undefined, scan.layouts), { amount });
  }
  $('#live-btn').onclick = async () => {
    if (!(await startScan())) return;
    const codes = await liveScan({ describe: describeBarcodes, isEnough: barcodesEnough });
    if (!codes) return;
    codes.forEach((c) => scan.barcodes.add(c));
    applyScan(mergeScan([...scan.barcodes], scan.texts, undefined, scan.layouts));
  };

  /** opts.amount:{ value, source, pages? }(同一張帳單多頁時使用者選的金額),蓋過辨識的結果。 */
  function applyScan(r, { amount: chosen = null } = {}) {
    guard.markDirty();
    if (chosen) r = { ...r, amount: chosen.value, source: { ...r.source, amount: chosen.source } };
    const barcodes = [...scan.barcodes];
    const fields = []; // 帶入的欄位(畫面上的卡片)
    const notes = [];
    const warnings = [];
    const addNote = (note) => {
      const box = field('notes');
      if (!box.value.includes(note)) fill('notes', box.value ? `${box.value}\n${note}` : note);
    };
    if (chosen?.pages) {
      addNote(`金額是 ${chosen.pages.length} 頁加總:${chosen.pages.map(money).join(' + ')} = ${money(chosen.value)}`);
      notes.push(`💰 金額是 ${chosen.pages.length} 頁加總:${chosen.pages.map(money).join(' + ')} = <b>${money(chosen.value)}</b>(已寫進備註)。`);
    }
    if (r.amount != null) {
      fill('amount', r.amount);
      fields.push({ label: '金額', value: money(r.amount), source: r.taxQr ? 'qr' : r.source.amount });
    } else fields.push({ label: '金額', missing: true });
    if (r.dueDate) {
      fill('dueDate', r.dueDate);
      fields.push({ label: '截止日', value: formatDate(r.dueDate), source: r.taxQr ? 'qr' : r.source.dueDate });
      if (r.collectCutoff) {
        addNote(`代收截止日是 ${formatDate(r.collectCutoff)}(超商最後收單日),過了繳費期限可能會加收遲付費用`);
        notes.push(`📅 截止日用帳單上的繳費期限;條碼上的 ${formatDate(r.collectCutoff)} 是超商最後收單日,已寫進備註。`);
      }
      if (r.taxCutoff) {
        // 條碼上的日期是「繳納期間屆滿後 3 日」,記在備註,不當截止日
        addNote(`條碼上的繳納截止日是 ${formatDate(r.taxCutoff)}(繳納期間屆滿後 3 日)`);
        notes.push(`🏛️ 稅單:截止日用繳納期間最後一天;條碼上的 ${formatDate(r.taxCutoff)} 是期滿後 3 日,已寫進備註。`);
      }
    } else fields.push({ label: '截止日', missing: true });
    scan.result = r;
    // 認得這張帳單(存檔時記下的帳號/代收代號/帳單種類):自動選上那個固定繳費
    let matched = null;
    if (!field('templateId').value) {
      matched = matchTemplate(r, templates);
      if (matched) {
        fill('templateId', matched.template.id);
        $('#save-template').hidden = true;
        applyTemplate(matched.template, fill);
        fields.unshift({ label: '固定繳費', value: matched.template.name, source: 'template' });
        notes.unshift(`🔁 認出是固定繳費「<b>${esc(matched.template.name)}</b>」(${esc(matched.reason)}),已套用;不對的話在最上面改。`);
      }
    }
    // 從帳單上的機構名稱猜的名稱/類別:只在還沒填(類別還是「其他」)時帶入
    if (r.issuerName && !field('name').value.trim()) {
      fill('name', r.issuerName);
      fields.push({ label: '名稱', value: r.issuerName, source: 'ocr' });
    }
    if (r.category && field('category').value === 'other') fill('category', r.category);
    if (r.period && /^\d{4}-\d{2}$/.test(r.period)) {
      fill('period', r.period);
      fields.push({ label: '帳單月份', value: formatPeriod(r.period) });
    }
    // 有固定繳費時週期以它為準(使用者自己設的)
    if (r.cycleMonths && !field('templateId').value) {
      fill('cycleMonths', r.cycleMonths);
      fields.push({ label: '週期', value: ({ 1: '每月', 2: '雙月', 3: '每季', 6: '半年', 12: '每年' })[r.cycleMonths] || `${r.cycleMonths} 個月` });
    }
    // 帳單沒寫月份、截止日又離目前選的月份很遠(例如掃去年的稅單):帳單月份改成截止日那個月
    if (!r.period && r.dueDate && field('period').value) {
      const [py, pm] = field('period').value.split('-').map(Number);
      const [dy, dm] = r.dueDate.split('-').map(Number);
      if (Math.abs((dy * 12 + dm) - (py * 12 + pm)) > 1) {
        fill('period', r.dueDate.slice(0, 7));
        fields.push({ label: '帳單月份', value: formatPeriod(field('period').value) });
        notes.push(`📅 帳單月份改成 <b>${formatPeriod(field('period').value)}</b>(跟截止日同月),存檔後會列在那個月份底下。`);
      }
    }
    if (r.accountNo && !field('accountNo').value) {
      fill('accountNo', r.accountNo);
      if (r.bankCode) fill('bankCode', r.bankCode);
      fields.push(r.taxQr
        ? { label: '銷帳編號', value: `${r.bankCode} ${r.accountNo}`, source: 'qr' }
        : { label: '繳費帳號', value: accountText(r), source: 'ocr' });
    }

    // 帳單寫著轉帳代繳 / 自動扣繳:存成固定繳費時預設自動扣款(到截止日自動記成已繳,不提醒去繳)
    if (r.autoPay) {
      const tpl = templates.find((t) => t.id === field('templateId').value);
      if (!tpl) {
        if (!field('autoPay').checked) fill('autoPay', true);
        notes.push('🔄 帳單上寫著自動扣款(轉帳代繳):勾「同時存成固定繳費」時,已預設「自動扣款」。');
      } else if (!tpl.autoPay) {
        notes.push(`🔄 帳單上寫著自動扣款(轉帳代繳),可以到「固定繳費」把「${esc(tpl.name)}」設成自動扣款,截止日會自動記成已繳。`);
      }
    }
    // 由信用卡扣款:提醒可以勾「已包含在信用卡帳單裡」(要不要勾看使用者有沒有記信用卡帳單,不自動勾)
    if (r.cardPay && !field('inCardBill').checked) {
      notes.push('💳 這筆由信用卡扣款。如果你也有記那張信用卡帳單,可以勾下面的「已包含在信用卡帳單裡」,統計就不會算兩次。');
    }
    if (r.source.dueDate === 'guess') warnings.push('⚠️ 帳單上沒找到「繳費期限」之類的字,截止日是用帳單上最晚的日期<b>推測</b>的,請一定要核對。');
    const LOW_RES = 2000; // 長邊少於這個,條碼和小字很容易讀不到
    if (scan.size && Math.max(scan.size.width, scan.size.height) < LOW_RES) {
      warnings.push(`⚠️ 照片只有 ${scan.size.width}×${scan.size.height},解析度偏低,條碼和小字容易讀不到。可以先用手機相機 App 拍,再「從相簿選」。`);
    }
    let tip = '';
    if (r.source.dueDate !== 'barcode' && !barcodesEnough(barcodes)) {
      tip = scan.screenshot
        ? '💡 截圖的解析度通常不夠讀條碼,金額和截止日是從文字讀的。'
        : '💡 最準的是帳單下方的超商條碼。條碼沒讀到的話,可以按「對準條碼掃」把鏡頭靠近條碼。';
    }
    const detail = debug ? [
      ...(scan.timings?.length ? [`耗時:${scan.timings.map((x) => `${x.label} ${(x.ms / 1000).toFixed(1)}s`).join(' · ')}`
        + `(共 ${(scan.timings.reduce((a, x) => a + x.ms, 0) / 1000).toFixed(1)}s)`] : []),
      ...(scan.size ? [`照片解析度:${scan.size.width}×${scan.size.height}(約 ${Math.round(scan.size.width * scan.size.height / 1e4)} 萬畫素)`] : []),
      `條碼(${barcodes.length}):${barcodes.length ? barcodes.map((b) => (scan.sources[b] ? `${b}〔${scan.sources[b]}〕` : b)).join(' / ') : '沒讀到'}`,
      ...(scan.engines ? [`條碼引擎:${scan.engines}`] : []),
      `條碼解讀:${barcodeSummary(parseConvenienceBarcodes(barcodes))}`,
      `帳單種類:${r.profileLabel || '沒認出(用通用規則)'}`,
      ...scan.texts.map((t, i) => `文字辨識 #${i + 1}${scan.labels[i] ? `(${scan.labels[i]})` : ''}:\n${t.trim() || '(空白)'}`),
      ...(scan.errors.length ? [`錯誤:\n${[...new Set(scan.errors)].join('\n')}`] : []),
    ].join('\n\n') : null;
    setStatus(resultHTML({ fields, notes, warnings, tip, detail }));
    // 有把握:金額、截止日都有(截止日不是推測)、認得是哪個固定繳費、沒有警告。收件匣自動記錄用
    const confident = r.amount != null && !!r.dueDate && r.source.dueDate !== 'guess'
      && !!field('templateId').value && !warnings.length;
    status.querySelector('[data-copy-detail]')?.addEventListener('click', () => copyText(detail, '辨識細節', { preview: false }));
    return { confident };
  }
  if (params.get('scan') && isNew) $('#scan-input').click();
  // 從收件匣(Gmail 電子帳單)來的:辨識,有把握而且設定允許就直接存
  const inboxId = isNew ? params.get('inbox') : null;
  const inboxChain = params.get('chain') === '1';
  let autoSaving = false;
  // 從 Gmail 等 app 分享過來的帳單:直接辨識(拿了就從暫存刪掉,網址也拿掉 shared,重新整理不會再跑一次)
  if (params.get('shared') && isNew) {
    history.replaceState(null, '', '#/bill/new');
    const files = await takeSharedFiles();
    if (files.length > 1) toast(`收到 ${files.length} 個檔案,先辨識第一個;其他的可以再用「從相簿選」加進來`);
    if (files.length) scanFile(files[0]);
    else toast('沒有收到檔案');
  }

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
      inCardBill: fd.get('inCardBill') === 'on',
      notes: fd.get('notes').trim(),
      updatedAt: new Date().toISOString(),
      createdAt: bill.createdAt || new Date().toISOString(),
    };
    const auto = autoSaving;
    autoSaving = false;
    if (isNew && updated.templateId
      && bills.some((b) => b.templateId === updated.templateId && b.period === updated.period)) {
      // 收件匣的帳單已經記過(例如紙本先掃了):略過並標成已處理;自動記錄時不問
      const choice = inboxId && auto ? 'skip' : await ask({
        title: '這個月已經有這筆了',
        message: `${formatPeriod(updated.period)}已經有一筆「${updated.name}」。`,
        stacked: true,
        actions: [
          ...(inboxId ? [{ label: '略過這張', desc: '已經記過了,收件匣標成已處理', value: 'skip', kind: 'primary' }] : []),
          { label: '還是新增', value: 'add', kind: inboxId ? '' : 'primary' },
          { label: '取消', value: null },
        ],
      });
      if (!choice) return;
      if (choice === 'skip') {
        await ackInbox(inboxId).catch((err) => toast(err.message));
        guard.release();
        toast(`「${updated.name}」${formatPeriod(updated.period)}已經記過了,略過`);
        return nextInbox();
      }
    }
    let savedTemplate = false;
    // 掃描過的話,把這張帳單的特徵記到固定繳費上,下次掃到同一張就認得(見 profiles.js matchTemplate)
    const hints = scan.result ? scanHintsFrom(scan.result) : {};
    if (!updated.templateId && fd.get('saveTemplate') === 'on') {
      const t = { ...draftTemplate(), scanHints: hints, createdAt: new Date().toISOString() };
      await db.put('templates', t);
      updated.templateId = t.id;
      savedTemplate = true;
    } else if (updated.templateId && Object.keys(hints).length) {
      const t = await db.get('templates', updated.templateId);
      if (t) await db.put('templates', { ...t, scanHints: { ...t.scanHints, ...hints } });
    }
    await db.put('bills', updated);
    guard.release();
    if (savedTemplate) await runAutoPay();
    if (inboxId) {
      await ackInbox(inboxId).catch((err) => toast(`已儲存,但收件匣沒標成已處理:${err.message}`));
      toast(`${auto ? '已自動記錄' : '已儲存'}:${updated.name} ${money(updated.amount)}`);
      return nextInbox();
    }
    toast(savedTemplate ? '已儲存,也加進固定繳費了' : '已儲存');
    go(`#/bills?month=${updated.period}`);
  };
  /** 收件匣:「全部記錄」時接著下一張,否則回收件匣。 */
  async function nextInbox() {
    const next = inboxChain && (await cachedInboxItems())[0];
    if (next) return go(`#/bill/new?inbox=${encodeURIComponent(next.id)}&chain=1`);
    if (inboxChain) toast('收件匣都處理完了 🎉');
    return go('#/inbox');
  }
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
  // 收件匣:等表單(含儲存)都設定好才開始辨識,有把握而且設定允許就直接存
  if (inboxId) startInbox();
  async function startInbox() {
    const item = (await cachedInboxItems()).find((i) => i.id === inboxId);
    let file = null;
    if (item) file = await inboxFile(item).catch((err) => { toast(`下載不到這張帳單:${err.message}`); return null; });
    else toast('這張已經處理過了');
    if (!file) return go('#/inbox');
    const outcome = await scanFile(file);
    if (outcome?.confident && (await db.getMeta('inboxAutoSave')) !== false) {
      autoSaving = true;
      form.requestSubmit();
    }
  }
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
