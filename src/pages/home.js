// 首頁:待辦提醒、本月統計、新手引導、備份提醒。

import { backupSummary, SNOOZE_DAYS } from '../backup.js';
import { periodKey, todayISO } from '../dates.js';
import * as db from '../db.js';
import { buildReminders, monthSummary } from '../schedule.js';
import { getBackupStatus, loadAll } from '../ui/actions.js';
import { notifyBanner, reminderCard, summaryBlock } from '../ui/components.js';
import { esc, view } from '../ui/dom.js';
import { render } from '../ui/router.js';

// Android Chrome 允許安裝時會發 beforeinstallprompt:先存起來,讓引導卡片可以直接顯示「安裝 app」按鈕
export let installPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  if (!location.hash || location.hash === '#/') render();
});

window.addEventListener('appinstalled', () => { installPrompt = null; });

/** 「安裝 app」按鈕:叫出 Chrome 的安裝對話框(每個事件只能用一次)。 */
export async function promptInstall() {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => null);
  installPrompt = null;
  render();
}

export const isInstalled = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

export const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

export function onboardingCard({ hasData }) {
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

export function backupCard(status) {
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

export async function renderHome() {
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
