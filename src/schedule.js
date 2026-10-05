// 固定繳費(template)的週期計算與提醒清單。
//
// template 欄位:
//   cycleMonths  幾個月一期(1 每月、2 雙月、3 每季、6 半年、12 每年)
//   anchorMonth  其中一期帳單會到的月份(1–12),用來決定是哪幾個月
//   arrivalDay   繳費單大約每期幾號會到(31 = 月底)
//   dueDay       截止日是幾號;比 arrivalDay 小代表截止日在帳單到的「下個月」
//   remindDays   截止前幾天開始提醒

import {
  addMonths, clampedDate, diffDays, periodKey, parsePeriod,
} from './dates.js';

export const DEFAULT_REMIND_DAYS = 3;
const COLLECT_SOON_DAYS = 3;
const MISSING_LOOKBACK_DAYS = 31;

export function occursIn(t, year, month) {
  const cycle = t.cycleMonths || 1;
  return ((month - (t.anchorMonth || 1)) % cycle + cycle) % cycle === 0;
}

export function periodDates(t, key) {
  const { year, month } = parsePeriod(key);
  const arrival = clampedDate(year, month, t.arrivalDay);
  const dueMonth = t.dueDay >= t.arrivalDay ? { year, month } : addMonths(year, month, 1);
  const due = clampedDate(dueMonth.year, dueMonth.month, t.dueDay);
  return { arrival, due };
}

/** 從 fromIso 那個月起,往後找第一個(截止日還沒過的)週期。 */
export function nextPeriod(t, fromIso) {
  const [y, m] = fromIso.split('-').map(Number);
  for (let i = -1; i <= 24; i++) {
    const { year, month } = addMonths(y, m, i);
    if (!occursIn(t, year, month)) continue;
    const key = periodKey(year, month);
    const dates = periodDates(t, key);
    if (dates.due >= fromIso) return { period: key, ...dates };
  }
  return null;
}

const LEVEL_ORDER = { danger: 0, warn: 1, info: 2 };

/**
 * 首頁的提醒清單。
 * - 固定繳費這期還沒登記帳單:提醒去拿繳費單(快到截止日就升級為紅色)
 * - 已登記但未繳:截止前 remindDays 天提醒,過了就是逾期
 */
export function buildReminders(templates, bills, today) {
  const items = [];
  const [ty, tm] = today.split('-').map(Number);
  const templateById = new Map(templates.map((t) => [t.id, t]));

  for (const t of templates) {
    if (!t.active) continue;
    const remindDays = t.remindDays ?? DEFAULT_REMIND_DAYS;
    const createdDay = (t.createdAt || '').slice(0, 10);
    for (let i = -2; i <= 1; i++) {
      const { year, month } = addMonths(ty, tm, i);
      if (!occursIn(t, year, month)) continue;
      const period = periodKey(year, month);
      if (bills.some((b) => b.templateId === t.id && b.period === period)) continue;
      const { arrival, due } = periodDates(t, period);
      // 新建立的固定繳費,不去追建立之前就已經過期的期數
      if (createdDay && due < createdDay) continue;

      const base = { templateId: t.id, period, name: t.name, arrival, due };
      if (today < arrival) {
        if (diffDays(today, arrival) <= COLLECT_SOON_DAYS) {
          items.push({ ...base, kind: 'collect-soon', level: 'info', date: arrival });
        }
      } else if (today <= due) {
        const urgent = diffDays(today, due) <= remindDays;
        items.push({ ...base, kind: 'collect', level: urgent ? 'danger' : 'warn', date: due });
      } else if (diffDays(due, today) <= MISSING_LOOKBACK_DAYS) {
        items.push({ ...base, kind: 'missing', level: 'danger', date: due });
      }
    }
  }

  for (const b of bills) {
    if (b.status === 'paid' || !b.dueDate) continue;
    const t = templateById.get(b.templateId);
    const remindDays = t?.remindDays ?? DEFAULT_REMIND_DAYS;
    const left = diffDays(today, b.dueDate);
    const base = {
      billId: b.id, templateId: b.templateId, period: b.period, name: b.name,
      due: b.dueDate, date: b.dueDate, amount: b.amount, daysLeft: left,
    };
    if (left < 0) items.push({ ...base, kind: 'overdue', level: 'danger' });
    else if (left <= remindDays) items.push({ ...base, kind: 'due-soon', level: 'warn' });
    else items.push({ ...base, kind: 'unpaid', level: 'info' });
  }

  return items.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a.date.localeCompare(b.date));
}

export function monthSummary(bills, key) {
  const list = bills.filter((b) => b.period === key);
  const sum = (arr) => arr.reduce((s, b) => s + (Number(b.amount) || 0), 0);
  const paid = list.filter((b) => b.status === 'paid');
  const unpaid = list.filter((b) => b.status !== 'paid');
  return { count: list.length, total: sum(list), paid: sum(paid), unpaid: sum(unpaid), unpaidCount: unpaid.length };
}

export const CYCLES = [[1, '單月'], [2, '雙月'], [3, '每季'], [6, '半年'], [12, '每年']];
export const cycleName = (n) => CYCLES.find(([m]) => m === n)?.[1] || `每 ${n} 個月`;

/**
 * 從一筆帳單推一個固定繳費的「到單日 / 截止日」預設值。
 * 截止日直接取帳單截止日的日期;到單日在帳單月份是今天就用今天,否則 1 號。
 * 截止日落在帳單月份的下個月時,到單日必須比截止日晚(那才代表「隔月截止」)。
 */
export function suggestTemplateDays(period, dueDate, today) {
  const todayDay = Math.min(Number(today.slice(8, 10)), 28);
  let arrivalDay = today.slice(0, 7) === period ? todayDay : 1;
  if (!dueDate) return { arrivalDay, dueDay: Math.min(arrivalDay + 14, 28) };
  const dueDay = Number(dueDate.slice(8, 10)) >= 29 ? 31 : Number(dueDate.slice(8, 10));
  const sameMonth = dueDate.slice(0, 7) <= period;
  if (sameMonth && arrivalDay > dueDay) arrivalDay = 1;
  if (!sameMonth && arrivalDay <= dueDay) arrivalDay = dueDay >= 28 ? 28 : Math.max(dueDay + 1, 20);
  return { arrivalDay, dueDay };
}
