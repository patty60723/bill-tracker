// 年度統計、搜尋比對、CSV 匯出。純函式,不碰 DOM。
// 統計以「帳單月份」(period)歸年,和月統計一致。

const num = (v) => Number(v) || 0;

/**
 * 某一年的統計。
 * @returns {{
 *   year, count, total, paid, unpaid, monthsWithBills, monthlyAvg,
 *   byMonth: { month, total, paid, count }[],      // 12 個月
 *   byCategory: { category, total, count, prevTotal }[], // 依金額由大到小
 *   compareThrough, compareTotal, prevTotal, change
 *   // 與去年「同期」比較:只算 1 月到 compareThrough 月(今年還沒過完時,不能拿 10 個月去比 12 個月)
 * }}
 * @param throughMonth 比較到幾月為止(今年用本月,過去的年份用 12)
 */
export function yearStats(bills, year, throughMonth = 12) {
  const inYear = (y) => bills.filter((b) => b.period?.startsWith(`${y}-`));
  const upTo = (b) => Number(b.period.slice(5, 7)) <= throughMonth;
  const list = inYear(year);
  const prev = inYear(year - 1).filter(upTo);

  const byMonth = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, total: 0, paid: 0, count: 0 }));
  for (const b of list) {
    const m = byMonth[Number(b.period.slice(5, 7)) - 1];
    if (!m) continue;
    m.total += num(b.amount);
    m.count++;
    if (b.status === 'paid') m.paid += num(b.amount);
  }

  const cats = new Map();
  const bump = (category, field, amount) => {
    const key = category || 'other';
    if (!cats.has(key)) cats.set(key, { category: key, total: 0, count: 0, compareTotal: 0, prevTotal: 0 });
    const c = cats.get(key);
    c[field] += amount;
    if (field === 'total') c.count++;
  };
  for (const b of list) bump(b.category, 'total', num(b.amount));
  for (const b of list.filter(upTo)) bump(b.category, 'compareTotal', num(b.amount));
  for (const b of prev) bump(b.category, 'prevTotal', num(b.amount));
  const byCategory = [...cats.values()].filter((c) => c.total > 0 || c.count > 0)
    .sort((a, b) => b.total - a.total);

  const total = list.reduce((s, b) => s + num(b.amount), 0);
  const paid = list.filter((b) => b.status === 'paid').reduce((s, b) => s + num(b.amount), 0);
  const prevTotal = prev.reduce((s, b) => s + num(b.amount), 0);
  const compareTotal = list.filter(upTo).reduce((s, b) => s + num(b.amount), 0);
  const monthsWithBills = byMonth.filter((m) => m.count > 0).length;
  return {
    year,
    count: list.length,
    total,
    paid,
    unpaid: total - paid,
    monthsWithBills,
    monthlyAvg: monthsWithBills ? Math.round(total / monthsWithBills) : 0,
    byMonth,
    byCategory,
    compareThrough: throughMonth,
    compareTotal,
    prevTotal,
    change: prevTotal > 0 ? (compareTotal - prevTotal) / prevTotal : null,
  };
}

/** 有帳單的年份(新到舊),至少包含 currentYear。 */
export function billYears(bills, currentYear) {
  const years = new Set([currentYear]);
  for (const b of bills) {
    const y = Number(b.period?.slice(0, 4));
    if (y) years.add(y);
  }
  return [...years].sort((a, b) => b - a);
}

/**
 * 搜尋:每個關鍵字(空白分隔)都要出現在名稱、備註、帳號、代碼、金額、類別名稱、帳單月份其中之一。
 * 金額可以打 1286 或 1,286。
 */
export function matchBill(bill, query, categoryLabel = () => '') {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const amount = bill.amount === '' || bill.amount == null ? '' : String(bill.amount);
  const haystack = [
    bill.name, bill.notes, bill.accountNo, bill.bankCode, amount,
    amount && Number(amount).toLocaleString('en-US'), categoryLabel(bill.category), bill.period,
    bill.paidMethod,
  ].filter(Boolean).join(' ').toLowerCase();
  return words.every((w) => haystack.includes(w.replace(/^\$/, '')));
}

const CSV_COLUMNS = [
  ['帳單月份', (b) => b.period],
  ['名稱', (b) => b.name],
  ['類別', (b, label) => label(b.category)],
  ['金額', (b) => b.amount],
  ['截止日', (b) => b.dueDate],
  ['狀態', (b) => (b.status === 'paid' ? '已繳' : '未繳')],
  ['繳費日期', (b) => b.paidDate],
  ['繳費方式', (b) => b.paidMethod],
  ['帳單週期(月)', (b) => b.cycleMonths || 1],
  ['代碼', (b) => b.bankCode],
  ['帳號/銷帳編號', (b) => b.accountNo],
  ['繳費單照片數', (b) => b.billFiles?.length || 0],
  ['繳費證明數', (b) => b.proofFiles?.length || 0],
  ['備註', (b) => b.notes],
];

function csvCell(v) {
  const s = v == null ? '' : String(v);
  // 帳號、銷帳編號這種長數字,Excel 會轉成科學記號、吃掉開頭的 0:用 ="..." 強制當文字
  if (/^\d{8,}$/.test(s)) return `"=""${s}"""`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 帳單 → CSV(UTF-8 BOM + CRLF,Excel 直接開不會亂碼)。依帳單月份、截止日排序。
 */
export function billsToCSV(bills, categoryLabel = (c) => c) {
  const rows = [...bills].sort((a, b) => (a.period || '').localeCompare(b.period || '')
    || (a.dueDate || '').localeCompare(b.dueDate || ''));
  const lines = [CSV_COLUMNS.map(([h]) => h).join(',')];
  for (const b of rows) lines.push(CSV_COLUMNS.map(([, get]) => csvCell(get(b, categoryLabel))).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}
