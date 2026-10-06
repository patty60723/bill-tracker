// 提醒通知:頁面打開時、以及 service worker 在背景被叫醒時(Periodic Background Sync)都用這裡。
// 不能碰 DOM / localStorage,service worker 裡沒有。

import * as db from './db.js';
import { diffDays, formatDate, todayISO } from './dates.js';
import { buildReminders } from './schedule.js';

export const SYNC_TAG = 'bill-reminders';
// Android 通知不支援 SVG 圖示;badge 是狀態列上的小白圖示
const ICON = 'icon-192.png';
const BADGE = 'badge-96.png';
const QUIET_BEFORE = 8; // 早上 8 點前、晚上 10 點後不在背景跳通知
const QUIET_AFTER = 22;

export const REMINDER_TEXT = {
  'collect-soon': (r) => `繳費單預計 ${formatDate(r.arrival)} 會到`,
  collect: (r) => `該去拿繳費單了,${formatDate(r.due)} 截止(剩 ${diffDays(todayISO(), r.due)} 天)`,
  missing: (r) => `這期還沒登記,截止日 ${formatDate(r.due)} 已過`,
  overdue: (r) => `已逾期 ${-r.daysLeft} 天(${formatDate(r.due)} 截止)`,
  'due-soon': (r) => (r.daysLeft === 0 ? '今天截止!' : `剩 ${r.daysLeft} 天截止(${formatDate(r.due)})`),
  unpaid: (r) => `未繳,${formatDate(r.due)} 截止`,
};

const reminderKey = (r) => `${r.kind}:${r.billId || r.templateId}:${r.period}`;

/** 要跳通知的提醒(藍色的「預告」「未繳但還早」不吵你)。 */
export async function urgentReminders(today = todayISO()) {
  const [templates, bills] = await Promise.all([db.getAll('templates'), db.getAll('bills')]);
  return buildReminders(templates, bills, today).filter((r) => r.level !== 'info');
}

/**
 * 一天最多通知一次;但同一天如果冒出新的待辦(例如剛好到單日),會再通知一次。
 * force:不管今天通知過沒有都再發一次。
 * @param registration ServiceWorkerRegistration(用它的 showNotification,背景也能跳)
 * @returns 有沒有真的跳通知
 */
export async function notifyReminders(registration, { force = false, background = false } = {}) {
  if (background) {
    const hour = new Date().getHours();
    if (hour < QUIET_BEFORE || hour >= QUIET_AFTER) return false;
  }
  const today = todayISO();
  const urgent = await urgentReminders(today);
  const keys = urgent.map(reminderKey);
  const last = (await db.getMeta('lastNotified')) || {};
  const seen = last.date === today ? new Set(last.keys) : new Set();
  if (!force && keys.every((k) => seen.has(k))) return false;

  if (!urgent.length) return false;
  const lines = urgent.slice(0, 5).map((r) => `${r.name}:${REMINDER_TEXT[r.kind](r)}`);
  if (urgent.length > 5) lines.push(`…還有 ${urgent.length - 5} 筆`);
  await registration.showNotification(`有 ${urgent.length} 筆帳單要處理`, {
    body: lines.join('\n'),
    tag: 'bill-reminder',
    renotify: true,
    icon: ICON,
    badge: BADGE,
    data: { url: './' },
  });
  await db.setMeta('lastNotified', { date: today, keys: [...new Set([...seen, ...keys])] });
  return true;
}

export const TEST_TAG = 'bill-test';

/** 設定頁的「測試通知」:一定會發一則,內容附上目前的待辦摘要。 */
export async function sendTestNotification(registration) {
  const urgent = await urgentReminders();
  const body = urgent.length
    ? `通知功能正常。目前有 ${urgent.length} 筆要處理:\n${urgent.slice(0, 3).map((r) => `${r.name}:${REMINDER_TEXT[r.kind](r)}`).join('\n')}`
    : '通知功能正常,目前沒有要處理的帳單 🎉';
  await registration.showNotification('🔔 繳費小幫手 測試通知', {
    body, tag: TEST_TAG, renotify: true, icon: ICON, badge: BADGE, data: { url: './' },
  });
}
