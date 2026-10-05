// 把固定繳費匯出成 .ics 行事曆檔:匯入手機行事曆後,就算沒開 app 也會跳提醒。
// (網頁 app 沒辦法在背景排程通知,這是最可靠的提醒方式。)

import { nextPeriod } from './schedule.js';

const esc = (s) => String(s).replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
const compact = (iso) => iso.replace(/-/g, '');

function monthDayRule(day) {
  // 29–31 號不是每個月都有,一律當「月底」,不然短的月份會被跳過
  return day >= 29 ? -1 : day;
}

function stamp(now) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
}

function event({ uid, date, summary, description, interval, day, alarms, now }) {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp(now)}`,
    `DTSTART;VALUE=DATE:${compact(date)}`,
    `RRULE:FREQ=MONTHLY;INTERVAL=${interval};BYMONTHDAY=${monthDayRule(day)}`,
    `SUMMARY:${esc(summary)}`,
  ];
  if (description) lines.push(`DESCRIPTION:${esc(description)}`);
  for (const { trigger, text } of alarms) {
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(text)}`, `TRIGGER:${trigger}`, 'END:VALARM');
  }
  lines.push('END:VEVENT');
  return lines;
}

export function buildICS(templates, today, now = new Date()) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//bill-tracker//繳費提醒//ZH', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:繳費提醒'];
  for (const t of templates) {
    if (!t.active) continue;
    const next = nextPeriod(t, today);
    if (!next) continue;
    const interval = t.cycleMonths || 1;
    const remindDays = t.remindDays ?? 3;
    const amount = t.amount ? `預估金額 ${t.amount} 元` : '';
    // 全天事件的 TRIGGER 以當天 00:00 為基準:PT9H = 當天早上 9 點,
    // -P{n-1}DT15H = n 天前的早上 9 點
    lines.push(...event({
      uid: `${t.id}-collect@bill-tracker`, now, interval, day: t.arrivalDay, date: next.arrival,
      summary: `📬 拿${t.name}繳費單`, description: amount,
      alarms: [{ trigger: 'PT9H', text: `${t.name}繳費單應該到了` }],
    }));
    lines.push(...event({
      uid: `${t.id}-due@bill-tracker`, now, interval, day: t.dueDay, date: next.due,
      summary: `⏰ ${t.name}繳費截止`, description: amount,
      alarms: [
        ...(remindDays > 0 ? [{ trigger: `-P${remindDays - 1}DT15H`, text: `${t.name}還有 ${remindDays} 天截止` }] : []),
        { trigger: 'PT9H', text: `${t.name}今天截止` },
      ],
    }));
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}
