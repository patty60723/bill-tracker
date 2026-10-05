// 提醒通知:頁面打開時、以及 service worker 在背景被叫醒時(Periodic Background Sync)都用這裡。
// 不能碰 DOM / localStorage,service worker 裡沒有。

import * as db from './db.js';
import { diffDays, formatDate, todayISO } from './dates.js';
import { buildReminders } from './schedule.js';

export const SYNC_TAG = 'bill-reminders';
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

  if (!urgent.length) {
    if (!force) return false;
    await registration.showNotification('繳費小幫手', { body: '目前沒有要處理的帳單 🎉', tag: 'bill-reminder', icon: 'icon.svg' });
    return true;
  }
  const lines = urgent.slice(0, 5).map((r) => `${r.name}:${REMINDER_TEXT[r.kind](r)}`);
  if (urgent.length > 5) lines.push(`…還有 ${urgent.length - 5} 筆`);
  await registration.showNotification(`有 ${urgent.length} 筆帳單要處理`, {
    body: lines.join('\n'),
    tag: 'bill-reminder',
    renotify: true,
    icon: 'icon.svg',
    badge: 'icon.svg',
    data: { url: './' },
  });
  await db.setMeta('lastNotified', { date: today, keys: [...new Set([...seen, ...keys])] });
  return true;
}
