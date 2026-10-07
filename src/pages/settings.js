// 設定頁:通知、行事曆、新手引導、備份 / 匯入 / CSV。

import { backupSummary, describeBackup } from '../backup.js';
import { formatDate, todayISO } from '../dates.js';
import * as db from '../db.js';
import { buildICS } from '../ics.js';
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
    </section>
    <p class="muted small version">繳費小幫手 ${VERSION}</p>`;

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
