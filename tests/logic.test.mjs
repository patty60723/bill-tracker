// node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBillText, parseConvenienceBarcodes, parsePaytaxQr, mergeScan } from '../src/parse.js';
import { buildReminders, monthSummary, nextPeriod, occursIn, periodDates } from '../src/schedule.js';
import { buildICS } from '../src/ics.js';

const TODAY = '2026-10-05';
// amountRank 是內部用的排序資訊,比對結果時略過
const parse = (text) => {
  const { amountRank, ...rest } = parseBillText(text, TODAY);
  return rest;
};

test('超商三段式條碼:民國年截止日、金額、應繳月份', () => {
  const r = parseConvenienceBarcodes(['151031K6A', '0000123456789012', '1510AB000001234'], TODAY);
  assert.equal(r.dueDate, '2026-10-31');
  assert.equal(r.collectionCode, 'K6A');
  assert.equal(r.amount, 1234);
  assert.equal(r.period, '2026-10');
  assert.equal(r.billNo, '0000123456789012');
});

test('超商條碼:第一段用西元年末兩碼也認得', () => {
  assert.equal(parseConvenienceBarcodes(['261031K6A'], TODAY).dueDate, '2026-10-31');
});

test('超商條碼:第三段前 4 碼是 MMDD 時,金額照樣讀得到', () => {
  const r = parseConvenienceBarcodes(['*1031AB000000899*'], TODAY);
  assert.equal(r.amount, 899);
  assert.equal(r.period, undefined);
});

test('條碼:不存在或太遠的日期不採用', () => {
  assert.equal(parseConvenienceBarcodes(['151332K6A'], TODAY).dueDate, undefined);
  assert.equal(parseConvenienceBarcodes(['401031K6A'], TODAY).dueDate, undefined);
});

// 以下 OCR 文字是 Tesseract(chi_tra+eng)對合成帳單圖片的真實輸出:中文字之間會被插空白
test('OCR:欄位式(關鍵字與值在同一行,中文字被空白隔開)', () => {
  const text = `中 華電 信 電信 費 帳 單

帳 單 月 份 115 年 09 月

出 帳 日 期 115 年 09 月 28 日
繳費 截止 日 115 年 10 月 15 日
本 期 應 繳 總 金 額 899 元`;
  assert.deepEqual(parse(text), { amount: 899, dueDate: '2026-10-15' });
});

test('OCR:一行式、西元年、最低應繳不能當成應繳金額', () => {
  const text = `XX 銀行 信用 卡 帳 單
結 帳 日 2026/09/22

最 低 應 繳 金 額 : 1,235
本 期 應 繳 總 金 額 : NT$12,345
繳 款 截止 日 : 2026/10/08`;
  assert.deepEqual(parse(text), { amount: 12345, dueDate: '2026-10-08' });
});

test('OCR:表格式(值在下一行,同一列還有計費期間)', () => {
  const text = `台 灣 自 來 水 公司 水 費 通 知 單
用 水 地 址 : 臺 北市 中 正 區 某 某 路 一 段 1 號 水 號 :K-12-345678-9
計 費 期 間
本 期 應 繳 金 額 | 繳費 期 限
| 115/07/15~115/09/14 | 1,286 | 115/10/27 |
收費 日 期 115 年 09 月 20 日 _ 抄 表 日 期 115/09/14`;
  assert.deepEqual(parse(text), { amount: 1286, dueDate: '2026-10-27' });
});

test('OCR:表頭與數值之間多一行雜訊(真實輸出)', () => {
  const text = `台 灣 自 來 水 公司 水 費 通 知 單\n用 水 地 址 : 臺 北市 中 正 區 某 某 路 一 段 1 號 水 號 :K-12-345678-9\n\n計 費 期 間 本 期 應 繳 金 額 繳費 期 限\n\ni 1\n115/07/15~115/09/14 NT$ 1,286 115/10/27\n\n收費 日 期 115 年 09 月 20 日 _ 抄 表 日 期 115/09/14`;
  assert.deepEqual(parse(text), { amount: 1286, dueDate: '2026-10-27' });
});

test('OCR:表格亂掉找不到關鍵字時,猜近期最晚的日期並標記為推測', () => {
  const text = `[wm  [smmasu] asom |\n收費 日 期 115 年 09 月 20 日 _ 抄 表 日 期 115/09/14\n115/10/27`;
  assert.deepEqual(parse(text), { dueDate: '2026-10-27', dueDateGuessed: true });
});

test('OCR:繳款截止日後面沒寫年份、或擠成一串數字', () => {
  assert.equal(parse('繳款截止日:10月31日').dueDate, '2026-10-31');
  assert.equal(parse('繳 款 截止 日 10/31').dueDate, '2026-10-31');
  assert.equal(parse('繳款截止日 1151031').dueDate, '2026-10-31');
  assert.equal(parse('繳款截止日 20261031').dueDate, '2026-10-31');
  // 12 月時看到 1/10 → 明年
  assert.equal(parseBillText('繳款截止日 1/10', '2026-12-20').dueDate, '2027-01-10');
  // 沒有截止日關鍵字的地方,不亂把 10/31、1151031 當日期
  assert.equal(parse('電號 1151031 抄表 10/31').dueDate, undefined);
});

test('OCR:全形數字與 O/l 誤認', () => {
  assert.equal(parseBillText('繳費期限:１１５／１０／２８', TODAY).dueDate, '2026-10-28');
  assert.equal(parseBillText('繳費期限 1l5/1O/28', TODAY).dueDate, '2026-10-28');
});

test('OCR:繳費帳號與銀行代碼', () => {
  assert.deepEqual(parse('銀 行 代 碼 : 822 中 國 信託\n繳 費 帳 號 : 9876 5432 1098 7654', TODAY),
    { accountNo: '9876543210987654', bankCode: '822' });
  // 帳號在下一行、前面有 (812)
  assert.deepEqual(parse('ATM 轉 帳 帳 號\n(812) 12345678901234', TODAY),
    { accountNo: '12345678901234', bankCode: '812' });
  // 最後一組不足 4 碼
  assert.equal(parseBillText('繳費帳號:1234 5678 9012 34', TODAY).accountNo, '12345678901234');
  // 扣款帳號不是繳費帳號;日期、金額不會被當成帳號
  assert.equal(parseBillText('扣 款 帳 號 1234567890123\n繳費期限 115/10/27 金額 1,286', TODAY).accountNo, undefined);
});

test('真實帳單(社區管理費,聯邦銀行繳款書)的 OCR 輸出', async () => {
  const fs = await import('node:fs');
  const read = (f) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
  const texts = [read('mgmt-fee-pass1.txt'), read('mgmt-fee-pass2.txt')];
  const r = mergeScan([], texts, TODAY);
  assert.equal(r.amount, 4504); // 不是明細第一項的 3,304
  assert.equal(r.accountNo, '12345678901234');
  assert.equal(r.bankCode, '803'); // 「ATM 代碼」後面隔兩行才出現
  assert.equal(r.period, '2026-09'); // 「115 年 09-10 月」
  assert.equal(r.cycleMonths, 2);
  // 「應 弧 金 額」:錯一個字也認得
  assert.equal(parse('應 弧 金 額 | $4,504').amount, 4504);
});

// 稅單(地價稅)。銷帳編號等號碼已換成假的,格式與真實稅單相同
const TAX_QR = 'https://paytax.nat.gov.tw/QRCODE.aspx?par=113311234567890123456000000050214120414010671687';

test('稅單 QR Code:繳款類別、銷帳編號、金額、繳納截止日', () => {
  assert.deepEqual(parsePaytaxQr(TAX_QR, TODAY),
    { bankCode: '11331', accountNo: '1234567890123456', amount: 502, dueDate: '2025-12-04' });
  // 和其他條碼一起讀到時,QR Code 的資料優先
  const r = parseConvenienceBarcodes([TAX_QR, '1412046AM', 'F301955114019403388', '0003W0000000502'], TODAY);
  assert.equal(r.accountNo, '1234567890123456');
  assert.equal(r.bankCode, '11331');
  assert.equal(r.amount, 502);
  assert.equal(r.dueDate, '2025-12-04');
});

test('稅單 OCR:沒有 QR Code 時從「銷帳編號」「繳款類別」「繳納截止日」表格讀', async () => {
  const fs = await import('node:fs');
  const text = fs.readFileSync(new URL('./fixtures/land-tax-pass1.txt', import.meta.url), 'utf8');
  const r = parse(text);
  assert.equal(r.accountNo, '1234567890123456');
  assert.equal(r.bankCode, '11331');
  assert.equal(r.dueDate, '2025-12-04'); // 表頭 OCR 成「級納截止日」,值是 6 碼的 141204
  // 掃到 QR Code 時,以 QR Code 為準(OCR 可能看錯一個數字)
  const merged = mergeScan([TAX_QR.replace('1234567890123456', '1234567890123457')], [text], TODAY);
  assert.equal(merged.accountNo, '1234567890123457');
});

test('mergeScan:條碼優先;關鍵字結果優先於推測', () => {
  const r = mergeScan(['1510AB000000500'], ['應繳金額 999\n繳費期限 115/12/01'], TODAY);
  assert.equal(r.amount, 500);
  assert.equal(r.source.amount, 'barcode');
  assert.equal(r.dueDate, '2026-12-01');
  assert.equal(r.source.dueDate, 'ocr');
  const g = mergeScan([], ['亂碼 115/10/20', '繳費期限 115/10/27'], TODAY);
  assert.equal(g.dueDate, '2026-10-27');
  assert.equal(g.source.dueDate, 'ocr');
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
