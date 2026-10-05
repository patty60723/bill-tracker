// node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBillText, parseConvenienceBarcodes, mergeScan } from '../src/parse.js';
import { buildReminders, monthSummary, nextPeriod, occursIn, periodDates } from '../src/schedule.js';
import { buildICS } from '../src/ics.js';

test('超商三段式條碼:截止日、金額、應繳月份', () => {
  const r = parseConvenienceBarcodes(['151031K6A', '0000123456789012', '1510AB000001234']);
  assert.equal(r.dueDate, '2026-10-31');
  assert.equal(r.collectionCode, 'K6A');
  assert.equal(r.amount, 1234);
  assert.equal(r.period, '2026-10');
  assert.equal(r.accountNo, '0000123456789012');
});

test('條碼:不存在的日期不採用', () => {
  assert.equal(parseConvenienceBarcodes(['151332K6A']).dueDate, undefined);
});

test('OCR 文字:民國年日期與千分位金額', () => {
  const text = `台灣電力公司 電費通知單
  計費期間 115/08/12 至 115/10/10
  本期應繳總金額 NT$ 2,345 元
  繳費期限:115年10月28日`;
  assert.deepEqual(parseBillText(text), { amount: 2345, dueDate: '2026-10-28' });
});

test('OCR 文字:金額跟日期在下一行、西元年', () => {
  const text = '應繳金額\n$899\n繳款截止日\n2026/11/05';
  assert.deepEqual(parseBillText(text), { amount: 899, dueDate: '2026-11-05' });
});

test('OCR 文字:金額那行有日期時不要把日期當金額', () => {
  assert.equal(parseBillText('繳費金額 115/10/31 前繳 560元').amount, 560);
});

test('mergeScan:條碼優先於 OCR', () => {
  const r = mergeScan(['1510AB000000500'], '應繳金額 999\n繳費期限 115/12/01');
  assert.equal(r.amount, 500);
  assert.equal(r.source.amount, 'barcode');
  assert.equal(r.dueDate, '2026-12-01');
  assert.equal(r.source.dueDate, 'ocr');
});

const water = {
  id: 'w', name: '水費', active: true, cycleMonths: 2, anchorMonth: 1,
  arrivalDay: 5, dueDay: 20, remindDays: 3, createdAt: '2026-01-01T00:00:00Z',
};
const phone = {
  id: 'p', name: '電信', active: true, cycleMonths: 1, anchorMonth: 1,
  arrivalDay: 25, dueDay: 10, remindDays: 3, createdAt: '2026-01-01T00:00:00Z',
};

test('雙月週期只出現在奇數月', () => {
  assert.equal(occursIn(water, 2026, 9), true);
  assert.equal(occursIn(water, 2026, 10), false);
  assert.equal(occursIn(water, 2027, 1), true);
});

test('截止日比到單日早 → 隔月截止;31 = 月底', () => {
  assert.deepEqual(periodDates(phone, '2026-12'), { arrival: '2026-12-25', due: '2027-01-10' });
  assert.deepEqual(periodDates({ arrivalDay: 1, dueDay: 31 }, '2026-02'), { arrival: '2026-02-01', due: '2026-02-28' });
});

test('nextPeriod 會考慮上個月的單還沒截止', () => {
  assert.deepEqual(nextPeriod(phone, '2026-10-05'), { period: '2026-09', arrival: '2026-09-25', due: '2026-10-10' });
  assert.deepEqual(nextPeriod(water, '2026-10-05'), { period: '2026-11', arrival: '2026-11-05', due: '2026-11-20' });
});

test('提醒:該拿繳費單 / 快截止 / 逾期 / 前幾期沒登記', () => {
  const bills = [
    { id: 'b1', name: '信用卡', status: 'unpaid', dueDate: '2026-10-06', period: '2026-10' },
    { id: 'b2', name: '保險', status: 'unpaid', dueDate: '2026-10-01', period: '2026-09' },
    { id: 'b3', name: '已繳的', status: 'paid', dueDate: '2026-10-01', period: '2026-09' },
    { id: 'b4', name: '電信', templateId: 'p', status: 'paid', period: '2026-08' },
  ];
  const r = buildReminders([phone, water], bills, '2026-10-05');
  const by = (name) => r.filter((x) => x.name === name).map((x) => `${x.period}:${x.kind}:${x.level}`);
  assert.deepEqual(by('電信'), ['2026-09:collect:warn']); // 9/25 到單、10/10 截止,還剩 5 天
  assert.deepEqual(by('水費'), ['2026-09:missing:danger']); // 9/20 截止,沒登記
  assert.deepEqual(by('信用卡'), ['2026-10:due-soon:warn']);
  assert.deepEqual(by('保險'), ['2026-09:overdue:danger']);
  assert.deepEqual(by('已繳的'), []);
  assert.equal(r[0].level, 'danger');
  assert.equal(r.at(-1).level, 'warn');
  // 截止前 remindDays 天內還沒拿單 → 升級成紅色
  assert.equal(buildReminders([phone], bills, '2026-10-08')[0].level, 'danger');
});

test('提醒:這期還沒登記且已過截止日 → missing;登記後就消失', () => {
  const r = buildReminders([water], [], '2026-09-22');
  assert.equal(r[0].kind, 'missing');
  const after = buildReminders([water], [{ id: 'x', templateId: 'w', period: '2026-09', status: 'paid', name: '水費' }], '2026-09-22');
  assert.equal(after.length, 0);
});

test('提醒:剛建立的固定繳費不追建立前的期數', () => {
  const fresh = { ...water, createdAt: '2026-09-25T00:00:00Z' };
  assert.equal(buildReminders([fresh], [], '2026-09-26').length, 0);
});

test('提醒:到單前 3 天預告', () => {
  const r = buildReminders([water], [], '2026-11-03');
  assert.equal(r[0].kind, 'collect-soon');
});

test('月統計', () => {
  const s = monthSummary([
    { period: '2026-10', amount: 100, status: 'paid' },
    { period: '2026-10', amount: 250, status: 'unpaid' },
    { period: '2026-09', amount: 999, status: 'unpaid' },
  ], '2026-10');
  assert.deepEqual(s, { count: 2, total: 350, paid: 100, unpaid: 250, unpaidCount: 1 });
});

test('ICS:每個固定繳費兩個重複事件與提醒', () => {
  const ics = buildICS([water, phone, { ...water, id: 'off', active: false }], '2026-10-05', new Date('2026-10-05T00:00:00Z'));
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 4);
  assert.match(ics, /UID:w-due@bill-tracker\r\nDTSTAMP:20261005T000000Z\r\nDTSTART;VALUE=DATE:20261120\r\nRRULE:FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=20/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261010\r\nRRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=10/);
  assert.match(ics, /TRIGGER:-P2DT15H/);
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
});

test('suggestTemplateDays:同月截止、隔月截止、沒填截止日', async () => {
  const { suggestTemplateDays } = await import('../src/schedule.js');
  assert.deepEqual(suggestTemplateDays('2026-10', '2026-10-20', '2026-10-05'), { arrivalDay: 5, dueDay: 20 });
  assert.deepEqual(suggestTemplateDays('2026-10', '2026-10-03', '2026-10-05'), { arrivalDay: 1, dueDay: 3 });
  assert.deepEqual(suggestTemplateDays('2026-09', '2026-10-10', '2026-10-05'), { arrivalDay: 20, dueDay: 10 });
  assert.deepEqual(suggestTemplateDays('2026-10', '2026-11-10', '2026-10-25'), { arrivalDay: 25, dueDay: 10 });
  assert.deepEqual(suggestTemplateDays('2026-10', '2026-10-31', '2026-10-05'), { arrivalDay: 5, dueDay: 31 });
  assert.deepEqual(suggestTemplateDays('2026-10', '', '2026-10-05'), { arrivalDay: 5, dueDay: 19 });
  // 推出來的設定要能還原出原本的截止日
  const { periodDates } = await import('../src/schedule.js');
  for (const [p, due, today] of [['2026-09', '2026-10-10', '2026-10-05'], ['2026-10', '2026-10-31', '2026-10-05'], ['2026-10', '2026-11-10', '2026-10-25']]) {
    const d = suggestTemplateDays(p, due, today);
    assert.equal(periodDates(d, p).due, due);
  }
});
