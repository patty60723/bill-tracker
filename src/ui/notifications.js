// 通知相關的畫面邏輯:service worker 註冊、權限、背景定期提醒、測試通知。

import { notifyReminders, sendTestNotification, SYNC_TAG, TEST_TAG } from '../notify.js';
import { $, esc, toast } from './dom.js';

export async function setupServiceWorker() {
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
export async function registerBackgroundSync(reg) {
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
export async function enableNotifications() {
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

export const ANDROID_NOTIFY_HELP = '請到手機「設定 → 應用程式 → <b>繳費小幫手</b>(找不到就選 <b>Chrome</b>)→ 通知」把通知打開,'
  + '並確認沒有開「勿干擾」。改完回來再按一次測試。';

/**
 * 設定頁的「測試通知」:按下去當下就檢查權限(必要時直接跳出詢問),送出測試通知,
 * 再確認系統有沒有真的顯示,結果寫在按鈕下方,不會再「按了沒反應」。
 */
export async function testNotification() {
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

export async function notifyStatusHTML() {
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
