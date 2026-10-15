// 設定頁:通知、行事曆、文字辨識預先下載、PDF 密碼、新手引導、備份 / 匯入 / CSV、開發者模式。

import { backupSummary, describeBackup } from '../backup.js';
import { formatDate, todayISO } from '../dates.js';
import * as db from '../db.js';
import { buildICS } from '../ics.js';
import { getInboxUrl, testInbox } from '../inbox.js';
import { downloadPaddle, PADDLE_TOTAL_BYTES, paddleDownloaded, removePaddle } from '../paddle.js';
import { alertDialog, confirmDialog } from '../modal.js';
import { billsToCSV } from '../stats.js';
import { backupNow, getBackupStatus, loadAll } from '../ui/actions.js';
import { catLabel } from '../ui/components.js';
import { $, download, esc, toast, view } from '../ui/dom.js';
import { enableNotifications, notifyStatusHTML, testNotification } from '../ui/notifications.js';
import { VERSION } from '../version.js';
import { go, render } from '../ui/router.js';

export async function renderSettings() {
  const persisted = await navigator.storage?.persisted?.();
  const all = await loadAll();
  const backup = await getBackupStatus(all.templates, all.bills);
  const backupAt = await db.getMeta('lastBackupAt');
  const pdfPasswords = (await db.getMeta('pdfPasswords')) || [];
  const inboxUrl = await getInboxUrl();
  const inboxAuto = (await db.getMeta('inboxAutoSave')) !== false;
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
    <section class="card col" id="ocr-box">
      <h3>🔤 文字辨識(拍照辨識用)</h3>
      <p class="small" id="ocr-status">檢查中…</p>
      <progress id="ocr-progress" max="1" value="0" hidden></progress>
      <div class="btn-row" id="ocr-actions"></div>
    </section>
    <section class="card col" id="inbox-box">
      <h3>📬 Gmail 帳單收件匣</h3>
      <p class="muted small">Gmail 標了「帳單」的電子帳單會自動進到 app:背景同步(Android 加到主畫面後)和打開 app 時會去取件。
        要先在你自己的 Google 帳號設定一個 Apps Script,步驟見 <a href="https://github.com/patty60723/bill-tracker/blob/main/tools/gmail-inbox/README.md" target="_blank" rel="noopener">設定說明</a>。</p>
      <label class="col">Apps Script 網址(含 ?key=…)
        <input type="url" id="inbox-url" placeholder="https://script.google.com/macros/s/…/exec?key=…" value="${esc(inboxUrl)}" autocomplete="off">
      </label>
      <div class="btn-row">
        <button class="btn primary" id="inbox-save">儲存並測試</button>
        ${inboxUrl ? '<a class="btn" href="#/inbox">打開收件匣</a><button class="btn" id="inbox-clear">取消設定</button>' : ''}
      </div>
      <p class="small" id="inbox-status"></p>
      <label class="switch"><input type="checkbox" id="inbox-auto" ${inboxAuto ? 'checked' : ''}> 有把握的自動記錄</label>
      <p class="muted small">認得是哪個固定繳費、條碼或 PDF 文字讀得到金額和截止日、沒有警告的,直接存;其他的停下來給你確認。</p>
    </section>
    <section class="card col" id="pw-box">
      <h3>🔐 PDF 帳單密碼</h3>
      <p class="small" id="pw-status">${(pdfPasswords.length ? `已記住 ${pdfPasswords.length} 組密碼。` : '還沒有記住任何密碼。')}</p>
      <p class="muted small">打開有密碼的 PDF 電子帳單時,在密碼框勾「記住這個密碼」,之後會自動先試。密碼只存在這支手機的瀏覽器裡,不會進備份檔。</p>
      ${pdfPasswords.length ? '<div class="btn-row"><button class="btn" id="pw-clear">清除記住的密碼</button></div>' : ''}
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
    </section>
    <section class="card col">
      <h3>🛠️ 開發者模式</h3>
      <label class="switch"><input type="checkbox" id="debug-mode" ${(await db.getMeta('debugMode')) ? 'checked' : ''}> 掃描後顯示「辨識細節」</label>
      <p class="muted small">耗時、條碼原始內容、用了哪個辨識引擎、辨識出的全文。回報辨識問題時打開,按「複製辨識細節」貼給開發者。</p>
    </section>
    <p class="muted small version">繳費小幫手 ${VERSION}</p>`;

  drawOcrBox();
  $('#inbox-save').onclick = async () => {
    const url = $('#inbox-url').value.trim();
    const status = $('#inbox-status');
    // 開發 / 測試時允許本機的假收件匣
    const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url);
    if ((!local && !/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) || !/[?&]key=/.test(url)) {
      status.textContent = '⚠️ 網址要是 https://script.google.com/macros/s/…/exec?key=… 的格式(後面要有 ?key=)。';
      return;
    }
    status.textContent = '連線中…';
    try {
      const r = await testInbox(url);
      await db.setMeta('inboxUrl', url);
      status.textContent = `✅ 連上了:Gmail 標籤「${r.label}」裡有 ${r.count} 張待記錄。`;
      toast('收件匣設定好了');
    } catch (e) {
      status.textContent = `⚠️ ${e.message}`;
    }
  };
  $('#inbox-clear')?.addEventListener('click', async () => {
    await db.setMeta('inboxUrl', '');
    await db.setMeta('inboxItems', []);
    toast('已取消收件匣設定');
    render();
  });
  $('#inbox-auto').onchange = (e) => db.setMeta('inboxAutoSave', e.target.checked);
  $('#pw-clear')?.addEventListener('click', async () => {
    if (!(await confirmDialog({ title: '清除記住的 PDF 密碼?', message: '之後打開有密碼的 PDF 會再問一次。', ok: '清除', danger: true }))) return;
    await db.setMeta('pdfPasswords', []);
    toast('已清除');
    render();
  });
  $('#debug-mode').onchange = async (e) => {
    await db.setMeta('debugMode', e.target.checked);
    toast(e.target.checked ? '已開啟:掃描後會顯示辨識細節' : '已關閉辨識細節');
  };

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

const MB = (bytes) => (bytes / 1048576).toFixed(0);
let ocrDownloading = null; // 下載中的 Promise:離開設定頁再回來時繼續顯示進度

/** 文字辨識區塊:顯示是否已下載、預先下載(有進度)、刪除。 */
async function drawOcrBox() {
  const status = $('#ocr-status');
  const actions = $('#ocr-actions');
  const bar = $('#ocr-progress');
  if (!status) return;
  if (ocrDownloading) {
    status.textContent = '下載中…';
    bar.hidden = false;
    actions.innerHTML = '';
    return;
  }
  const ready = await paddleDownloaded();
  if (!$('#ocr-status')) return; // 已經換頁
  bar.hidden = true;
  if (ready === null) {
    status.textContent = '這個瀏覽器不支援預先下載,第一次拍照辨識時會自動下載。';
    actions.innerHTML = '';
    return;
  }
  if (ready) {
    status.innerHTML = `✅ 已下載,拍照辨識可以離線使用。<span class="muted">(佔用約 ${MB(PADDLE_TOTAL_BYTES)} MB 空間)</span>`;
    actions.innerHTML = '<button class="btn" id="ocr-remove">刪除,釋放空間</button>';
    $('#ocr-remove').onclick = async () => {
      if (!(await confirmDialog({
        title: '刪除文字辨識資料?',
        message: '下次拍照辨識時會再自動下載(約 22 MB)。',
        ok: '刪除',
      }))) return;
      await removePaddle();
      toast('已刪除');
      drawOcrBox();
    };
    return;
  }
  const cellular = navigator.connection?.type === 'cellular' || navigator.connection?.saveData;
  status.innerHTML = '還沒下載。第一次拍照辨識時會自動下載約 22 MB,要等一下;建議現在先在 Wi-Fi 下載好。'
    + (cellular ? '<br>⚠️ 目前看起來是行動網路。' : '');
  actions.innerHTML = '<button class="btn primary" id="ocr-download">預先下載(約 22 MB)</button>';
  $('#ocr-download').onclick = startOcrDownload;
}

async function startOcrDownload() {
  const progress = (done, total) => {
    const bar = $('#ocr-progress');
    const status = $('#ocr-status');
    if (!bar || !status) return;
    bar.hidden = false;
    bar.value = done / total;
    status.textContent = `下載中… ${Math.round((done / total) * 100)}%(${MB(done)} / ${MB(total)} MB)`;
  };
  ocrDownloading = downloadPaddle(progress);
  drawOcrBox();
  try {
    await ocrDownloading;
    toast('文字辨識已下載完成');
  } catch (e) {
    console.warn(e);
    await alertDialog({ title: '下載沒有完成', message: `${e.message || e}。可以稍後再試,或第一次拍照辨識時會自動下載。` });
  } finally {
    ocrDownloading = null;
    drawOcrBox();
  }
}
