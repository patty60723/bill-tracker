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

test('稅單:截止日用繳納期間最後一天,條碼上的日期(屆滿後 3 日)另外記下', () => {
  const r = mergeScan([TAX_QR], [], TODAY);
  assert.equal(r.dueDate, '2025-12-01');
  assert.equal(r.taxCutoff, '2025-12-04');
  // 一般帳單不受影響
  const normal = mergeScan(['151031K6A', '1510AB000001234'], [], TODAY);
  assert.equal(normal.dueDate, '2026-10-31');
  assert.equal(normal.taxCutoff, undefined);
});

test('稅單 OCR:沒有 QR Code 時從「銷帳編號」「繳款類別」「繳納截止日」表格讀', async () => {
  const fs = await import('node:fs');
  const text = fs.readFileSync(new URL('./fixtures/land-tax-pass1.txt', import.meta.url), 'utf8');
  const r = parse(text);
  assert.equal(r.accountNo, '1234567890123456');
  assert.equal(r.bankCode, '11331');
  assert.equal(r.dueDate, '2025-12-04'); // 表頭 OCR 成「級納截止日」,值是 6 碼的 141204
  // 稅單上註明「繳納截止日為繳納期間屆滿後 3 日」:截止日用 11/30,條碼的 12/4 另外記下
  const fromText = mergeScan([], [text], TODAY);
  assert.equal(fromText.dueDate, '2025-12-01');
  assert.equal(fromText.taxCutoff, '2025-12-04');
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

test('文件增強:陰影、色塊底變白,文字保持深色', async () => {
  const { enhanceDocument } = await import('../src/enhance.js');
  const W = 400, H = 200;
  const data = new Uint8ClampedArray(W * H * 4);
  const set = (x, y, v) => { const p = (y * W + x) * 4; data[p] = data[p + 1] = data[p + 2] = v; data[p + 3] = 255; };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let paper = 235 - Math.round((x / W) * 130); // 由左到右越來越暗(陰影)
      if (x >= 200 && x < 360 && y >= 60 && y < 140) paper -= 50; // 一塊色塊底
      const isText = (y >= 90 && y < 110) && ((x >= 40 && x < 44) || (x >= 250 && x < 254)); // 兩條細筆畫
      set(x, y, isText ? Math.round(paper * 0.35) : paper);
    }
  }
  const out = enhanceDocument({ data, width: W, height: H });
  const at = (x, y) => out.data[(y * W + x) * 4];
  assert.ok(at(10, 10) > 230, `左邊亮紙 ${at(10, 10)}`);
  assert.ok(at(390, 190) > 230, `右邊陰影裡的紙 ${at(390, 190)}`);
  assert.ok(at(300, 75) > 230, `色塊底 ${at(300, 75)}`);
  assert.ok(at(41, 100) < 60, `亮處的字 ${at(41, 100)}`);
  assert.ok(at(251, 100) < 60, `色塊裡、陰影下的字 ${at(251, 100)}`);
});

test('自動扣款:截止日到了的期別自動記成已繳,未繳帳單標成已繳,記住處理到哪', async () => {
  const { planAutoPay } = await import('../src/schedule.js');
  const card = {
    id: 'c', name: '信用卡', active: true, autoPay: true, cycleMonths: 1, anchorMonth: 1,
    arrivalDay: 1, dueDay: 20, amount: 5000, accountNo: '123', bankCode: '822', createdAt: '2026-08-10T00:00:00Z',
  };
  // 8/10 建立:8 月那期 8/20 截止(建立後)→ 補;9 月 9/20 → 補;10 月 10/20 還沒到
  const r = planAutoPay([card], [], '2026-10-06');
  assert.deepEqual(r.create.map((b) => [b.period, b.dueDate, b.status, b.paidDate, b.paidMethod, b.amount]), [
    ['2026-08', '2026-08-20', 'paid', '2026-08-20', '自動扣繳', 5000],
    ['2026-09', '2026-09-20', 'paid', '2026-09-20', '自動扣繳', 5000],
  ]);
  assert.deepEqual(r.templateUpdates, [{ id: 'c', autoPayDone: '2026-09' }]);

  // 已有 10 月未繳帳單(掃描的,截止日 10/22):10/22 當天標成已繳
  const bills = [{ id: 'b10', templateId: 'c', period: '2026-10', status: 'unpaid', dueDate: '2026-10-22' }];
  const later = { ...card, autoPayDone: '2026-09' };
  assert.deepEqual(planAutoPay([later], bills, '2026-10-21'), { create: [], markPaid: [], templateUpdates: [] });
  assert.deepEqual(planAutoPay([later], bills, '2026-10-22').markPaid, [{ id: 'b10', paidDate: '2026-10-22' }]);

  // 處理過的期別不會重建(使用者刪掉自動建立的紀錄後不會再冒出來)
  assert.equal(planAutoPay([later], [], '2026-10-06').create.length, 0);
  // 建立前就截止的期別不補
  assert.equal(planAutoPay([{ ...card, createdAt: '2026-09-25T00:00:00Z' }], [], '2026-10-06').create.length, 0);
  // 對很久以前建立的項目「今天」才開啟自動扣款:不補過去的期別
  assert.equal(planAutoPay([{ ...card, createdAt: '2025-01-01T00:00:00Z', autoPayFrom: '2026-10-06' }], [], '2026-10-06').create.length, 0);
  assert.deepEqual(planAutoPay([{ ...card, createdAt: '2025-01-01T00:00:00Z', autoPayFrom: '2026-10-06' }], [], '2026-10-20').create.map((b) => b.period), ['2026-10']);
  // 沒開自動扣款、或停用的不處理
  assert.equal(planAutoPay([{ ...card, autoPay: false }], [], '2026-10-06').create.length, 0);
  assert.equal(planAutoPay([{ ...card, active: false }], [], '2026-10-06').create.length, 0);
});

test('自動扣款:不提醒拿單/繳費,未繳帳單只顯示「自動扣款」', () => {
  const card = { id: 'c', name: '信用卡', active: true, autoPay: true, cycleMonths: 1, anchorMonth: 1, arrivalDay: 1, dueDay: 20, createdAt: '2026-01-01T00:00:00Z' };
  assert.equal(buildReminders([card], [], '2026-10-15').length, 0);
  const r = buildReminders([card], [{ id: 'b', templateId: 'c', period: '2026-10', name: '信用卡', status: 'unpaid', dueDate: '2026-10-20' }], '2026-10-18');
  assert.deepEqual(r.map((x) => [x.kind, x.level]), [['autopay', 'info']]);
});

test('年度統計:月份、類別、與去年比較', async () => {
  const { yearStats, billYears } = await import('../src/stats.js');
  const bills = [
    { period: '2026-01', amount: 1000, status: 'paid', category: 'power' },
    { period: '2026-01', amount: 500, status: 'unpaid', category: 'water' },
    { period: '2026-03', amount: 1500, status: 'paid', category: 'power' },
    { period: '2025-02', amount: 2000, status: 'paid', category: 'power' },
    { period: '2026-05', amount: '', status: 'unpaid', category: 'other' },
  ];
  const s = yearStats(bills, 2026);
  assert.equal(s.count, 4);
  assert.equal(s.total, 3000);
  assert.equal(s.paid, 2500);
  assert.equal(s.unpaid, 500);
  assert.equal(s.monthsWithBills, 3);
  assert.equal(s.monthlyAvg, 1000);
  assert.deepEqual(s.byMonth[0], { month: 1, total: 1500, paid: 1000, count: 2 });
  assert.deepEqual(s.byCategory.map((c) => [c.category, c.total, c.count, c.prevTotal]),
    [['power', 2500, 2, 2000], ['water', 500, 1, 0], ['other', 0, 1, 0]]);
  assert.equal(s.prevTotal, 2000);
  assert.equal(s.change, 0.5);
  assert.equal(yearStats(bills, 2024).change, null);
  assert.deepEqual(billYears(bills, 2026), [2026, 2025]);
  // 今年只到 1 月:跟去年同期(1 月)比,去年 1 月沒有資料 → null;到 2 月就能比
  assert.equal(yearStats(bills, 2026, 1).change, null);
  const feb = yearStats(bills, 2026, 2);
  assert.equal(feb.compareTotal, 1500);
  assert.equal(feb.prevTotal, 2000);
  assert.equal(feb.change, -0.25);
});

test('搜尋:名稱、金額(含千分位)、帳號、類別、多個關鍵字', async () => {
  const { matchBill } = await import('../src/stats.js');
  const b = { name: '台電電費', amount: 1286, accountNo: '9876543210', category: 'power', period: '2026-10', notes: '住家' };
  const label = (c) => ({ power: '電費' }[c]);
  assert.ok(matchBill(b, '台電', label));
  assert.ok(matchBill(b, '1286', label));
  assert.ok(matchBill(b, '1,286', label));
  assert.ok(matchBill(b, '$1,286', label));
  assert.ok(matchBill(b, '98765', label));
  assert.ok(matchBill(b, '電費 住家', label));
  assert.ok(matchBill(b, '2026-10', label));
  assert.ok(!matchBill(b, '水費', label));
  assert.ok(matchBill(b, '   ', label));
});

test('CSV:BOM、CRLF、跳脫、長數字當文字', async () => {
  const { billsToCSV } = await import('../src/stats.js');
  const csv = billsToCSV([
    { period: '2026-10', name: '管理費, "A棟"', category: 'rent', amount: 4504, dueDate: '2026-10-21', status: 'paid', paidDate: '2026-10-20', accountNo: '0012345678901234', notes: '第一行\n第二行' },
    { period: '2026-09', name: '電費', category: 'power', amount: 1286, status: 'unpaid' },
  ], (c) => ({ rent: '房租/管理費', power: '電費' }[c]));
  assert.ok(csv.startsWith('﻿帳單月份,名稱,類別,金額'));
  const lines = csv.slice(1).split('\r\n');
  assert.ok(lines[1].startsWith('2026-09,電費,電費,1286,,未繳'));
  assert.ok(lines[2].includes('"管理費, ""A棟"""'));
  assert.ok(lines[2].includes('"=""0012345678901234"""'));
  assert.ok(csv.includes('"第一行\n第二行"'));
  assert.ok(csv.endsWith('\r\n'));
});

test('備份提醒:從沒備份、超過 30 天、改很多筆、延後提醒', async () => {
  const { backupStatus, backupSummary, describeBackup } = await import('../src/backup.js');
  const now = Date.parse('2026-10-07T12:00:00Z');
  const rec = (c, u) => ({ createdAt: c, updatedAt: u || c });
  // 沒資料:不提醒
  assert.equal(backupStatus({ records: [], now }).due, false);
  // 從沒備份:開始用 3 天後才提醒
  assert.equal(backupStatus({ records: [rec('2026-10-06T00:00:00Z')], now }).due, false);
  const never = backupStatus({ records: [rec('2026-10-01T00:00:00Z'), rec('2026-10-05T00:00:00Z')], now });
  assert.deepEqual([never.due, never.never, never.changes], [true, true, 2]);
  assert.equal(backupSummary(never), '還沒備份過(目前有 2 筆資料)');
  // 備份過:30 天內不提醒;超過 30 天、而且之後有變更才提醒
  const records = [rec('2026-08-01T00:00:00Z'), rec('2026-08-02T00:00:00Z', '2026-09-20T00:00:00Z')];
  assert.equal(backupStatus({ lastBackupAt: '2026-09-10T00:00:00Z', records, now }).due, false);
  const old = backupStatus({ lastBackupAt: '2026-09-01T00:00:00Z', records, now });
  assert.deepEqual([old.due, old.daysSince, old.changes], [true, 36, 1]);
  assert.equal(backupSummary(old), '上次備份是 36 天前,之後新增或修改了 1 筆');
  assert.equal(backupStatus({ lastBackupAt: '2026-09-25T00:00:00Z', records, now }).due, false); // 之後沒變更
  // 一週內改了 20 筆以上
  const many = Array.from({ length: 20 }, () => rec('2026-10-05T00:00:00Z'));
  assert.equal(backupStatus({ lastBackupAt: '2026-09-29T00:00:00Z', records: many, now }).due, true);
  assert.equal(backupStatus({ lastBackupAt: '2026-10-03T00:00:00Z', records: many, now }).due, false);
  // 「7 天後再提醒」期間不提醒
  assert.equal(backupStatus({ lastBackupAt: '2026-09-01T00:00:00Z', snoozeUntil: '2026-10-10T00:00:00Z', records, now }).due, false);
  // 備份檔摘要
  assert.deepEqual(describeBackup({ app: 'bill-tracker', exportedAt: 'x', bills: [1, 2], templates: [1], files: [] }),
    { exportedAt: 'x', bills: 2, templates: 1, files: 0 });
  assert.throws(() => describeBackup({ foo: 1 }), /不是/);
});

test('service worker 的離線快取清單包含所有 src/ 下的 JS 檔', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const root = new URL('..', import.meta.url).pathname;
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  const listed = new Set([...sw.matchAll(/'(src\/[^']+)'/g)].map((m) => m[1]));
  const walk = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith('.js') ? [`${dir}/${e.name}`] : []));
  const missing = walk('src').filter((f) => !listed.has(f));
  assert.deepEqual(missing, [], `sw.js 的 ASSETS 少了:${missing.join(', ')}`);
});

test('條碼沒讀到時,用 OCR 讀到的條碼下方數字補截止日、確認金額', () => {
  const text = '繳款截止日\n115/10/31\n總 計\n$ 4504\n喇 lmmWmmWWWWM\n1510316DA\n咖 UWHWWWMM\n092057000004504';
  const r = mergeScan([], [text], '2026-10-07');
  assert.equal(r.dueDate, '2026-10-31');
  assert.equal(r.source.dueDate, 'printed');
  assert.equal(r.amount, 4504);
  assert.equal(r.source.amount, 'printed');
  // 條碼有讀到就用條碼;15 碼數字跟金額對不上、前 4 碼又不是年月時不採用
  const r2 = mergeScan(['1510316DA'], ['總計 $ 3,304\n092057000004504'], '2026-10-07');
  assert.equal(r2.source.dueDate, 'barcode');
  assert.equal(r2.amount, 3304);
  assert.equal(r2.source.amount, 'ocr');
});
