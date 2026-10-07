// 從掃描結果(條碼文字、OCR 文字)推出繳費金額與截止日期。
//
// 台灣的超商代收繳費單是「三段式條碼」(Code 39):
//   第一段  9 碼:代收期限 YYMMDD + 代收項目代號 3 碼
//   第二段 16 碼:業者自訂(銷帳編號)
//   第三段 15 碼:4 碼(民國 YYMM 或 MMDD,各家不同)+ 檢查碼 2 碼 + 應繳金額 9 碼
// 第一段的 YY 規格上是民國年末兩碼,但也有業者用西元年末兩碼,所以兩種都試,取離今天近的。
// 不是每張單都長這樣(郵局劃撥、銀行、電信各有變化),所以全部都是「猜」,
// 結果只用來預填表單,使用者存檔前一定看得到、改得到。

import { addDays, diffDays, normalizeYear, todayISO, validDate } from './dates.js';

const BARCODE_WINDOW_DAYS = 400; // 條碼日期離今天超過這麼久就當成看錯
const GUESS_PAST_DAYS = 60; // 沒有關鍵字時,只在這個範圍內猜截止日
const GUESS_FUTURE_DAYS = 150;
const MIN_AMOUNT = 10; // 個位數多半是 OCR 雜訊,不會是帳單金額

const near = (date, today, days) => Math.abs(diffDays(today, date)) <= days;

function twoDigitYearDate(yy, mm, dd, today) {
  const candidates = [2011 + yy, 2000 + yy] // 民國 1xx 年、西元 20xx 年
    .map((y) => validDate(y, mm, dd))
    .filter((d) => d && near(d, today, BARCODE_WINDOW_DAYS));
  candidates.sort((a, b) => Math.abs(diffDays(today, a)) - Math.abs(diffDays(today, b)));
  return candidates[0] || null;
}

/**
 * 稅單上的「全國繳稅網」QR Code(https://paytax.nat.gov.tw/QRCODE.aspx?par=…)。
 * par 開頭依序是:繳款類別 5 碼 + 銷帳編號 16 碼 + 繳款金額 10 碼 + 繳納截止日 6 碼(民國 YYMMDD),
 * 正是用 ATM / 網銀 / 信用卡繳稅時要輸入的四個欄位。
 */
export function parsePaytaxQr(text, today = todayISO()) {
  const m = text.match(/paytax\.nat\.gov\.tw\/QRCODE\.aspx\?par=(\d{37,})/i);
  if (!m) return null;
  const par = m[1];
  const amount = Number(par.slice(21, 31));
  const dueDate = twoDigitYearDate(+par.slice(31, 33), +par.slice(33, 35), +par.slice(35, 37), today);
  return {
    bankCode: par.slice(0, 5), // 繳款類別(放在「代碼」欄)
    accountNo: par.slice(5, 21), // 銷帳編號
    ...(amount > 0 ? { amount } : {}),
    ...(dueDate ? { dueDate } : {}),
  };
}

export function parseConvenienceBarcodes(texts, today = todayISO()) {
  const result = {};
  // 稅單 QR Code 資訊最完整,先用它
  for (const raw of texts) {
    const tax = parsePaytaxQr(raw, today);
    if (tax) {
      Object.assign(result, tax, { taxQr: true });
      break;
    }
  }
  for (const raw of texts) {
    const t = raw.trim().toUpperCase().replace(/^\*|\*$/g, '');
    if (/^\d{6}[0-9A-Z]{3}$/.test(t)) {
      const due = twoDigitYearDate(+t.slice(0, 2), +t.slice(2, 4), +t.slice(4, 6), today);
      if (due && !result.dueDate) {
        result.dueDate = due;
        result.collectionCode = t.slice(6);
      }
    } else if (/^\d{4}[0-9A-Z]{2}\d{9}$/.test(t)) {
      const amount = +t.slice(6);
      if (amount > 0 && result.amount == null) {
        result.amount = amount;
        // 前 4 碼如果是民國年月,順便當成帳單月份
        const ym = twoDigitYearDate(+t.slice(0, 2), +t.slice(2, 4), 1, today);
        if (ym && near(ym, today, 120)) result.period = ym.slice(0, 7);
      }
    } else if (/^[0-9A-Z]{16}$/.test(t) && !result.billNo) {
      result.billNo = t; // 銷帳編號:每期不同,只記下來不拿來填欄位
    }
  }
  return result;
}

// ---------- OCR 文字 ----------

// 依可靠程度排序:越前面越優先
const DUE_KEYWORDS = [
  '繳費截止日', '繳款截止日', '繳納截止日', '繳費期限', '繳款期限', '繳納期限', '限繳日期', '最後繳費日', '最後繳款日',
  '代收期限', '截止日期', '截止日', '到期日', '繳費日期', '期限',
];
const AMOUNT_KEYWORDS = [
  '本期應繳總金額', '本期應繳金額', '應繳總金額', '應繳金額', '本期應付金額', '應付總金額', '應付金額',
  '繳費金額', '繳款金額', '總金額', '合計', '總計', '本期費用', '金額',
  '應繳費用', // 常是明細表的表頭(底下是各項費用),所以排最後
];
const AMOUNT_SKIP = /最低|已繳|上期|前期|預繳|折抵|手續費/;

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * 關鍵字比對器,依可靠度排名(rank 越小越可靠)。
 * 4 個字以上、而且含有「期限 / 截止 / 金額」這類特徵詞的關鍵字,另外允許「錯一個字」
 * (OCR 常把「繳」看成「弧」之類),排在同一個關鍵字的正確版本後面。
 * 「繳費日期」這種就不放寬,不然「收費日期」也會被當成截止日。
 */
const FUZZY_OK = /期限|截止|金額/;
function matchers(keywords) {
  return keywords.flatMap((kw, i) => {
    const list = [{ re: new RegExp(escapeRe(kw)), rank: i * 2 }];
    if ([...kw].length >= 4 && FUZZY_OK.test(kw)) {
      const chars = [...kw];
      const alts = chars.map((_, j) => chars.map((c, k) => (k === j ? '[^\\s\\d]' : escapeRe(c))).join(''));
      list.push({ re: new RegExp(alts.join('|')), rank: i * 2 + 1 });
    }
    return list;
  }).sort((a, b) => a.rank - b.rank);
}
const DUE_MATCHERS = matchers(DUE_KEYWORDS);
const AMOUNT_MATCHERS = matchers(AMOUNT_KEYWORDS);

const CJK = '\\u3400-\\u9fff\\uf900-\\ufaff';

/** OCR 常見問題:中文字之間被插空白、全形數字符號、數字裡混了 O/l。 */
export function normalizeOcrText(text) {
  return text
    .normalize('NFKC')
    .replace(/〇/g, '0')
    .replace(new RegExp(`([${CJK}])[ \\t]+(?=[${CJK}])`, 'g'), '$1')
    .replace(/(?<=\d)[Oo](?=[\d/.-])|(?<=[\d/.-])[Oo](?=\d)/g, '0')
    .replace(/(?<=\d)[lI](?=[\d/.-])|(?<=[\d/.-])[lI](?=\d)/g, '1');
}

// 年份限 3 碼(民國)或 4 碼(西元),避免把「15~115/09/14」之類的片段湊成日期
const DATE_RES = [
  /(?<!\d)(\d{3,4})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{1,2})(?!\d)/g,
  /(?<!\d)(\d{3,4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/g,
];

function allDates(text) {
  const out = [];
  for (const re of DATE_RES) {
    for (const m of text.matchAll(re)) {
      const d = validDate(normalizeYear(+m[1]), +m[2], +m[3]);
      if (d) out.push({ date: d, index: m.index, length: m[0].length });
    }
  }
  return out;
}

const latest = (dates) => dates.map((d) => d.date).sort().at(-1);

/**
 * 只用在截止日關鍵字後面的寫法:沒寫年份(10月31日、10/31)、或擠成一串數字
 * (1151031 民國、20261031 西元)。沒寫年份時取離今天最近的那一年。
 */
function looseDates(text, today) {
  const out = [];
  const year = Number(today.slice(0, 4));
  for (const m of text.matchAll(/(?<![\d/.-])(\d{1,2})\s*(?:月|[/.])\s*(\d{1,2})\s*日?(?![\d/.-])/g)) {
    const options = [year - 1, year, year + 1].map((y) => validDate(y, +m[1], +m[2])).filter(Boolean);
    options.sort((a, b) => Math.abs(diffDays(today, a)) - Math.abs(diffDays(today, b)));
    if (options[0]) out.push({ date: options[0] });
  }
  for (const m of text.matchAll(/(?<!\d)(1\d{2}|20\d{2})(\d{2})(\d{2})(?!\d)/g)) {
    const d = validDate(normalizeYear(+m[1]), +m[2], +m[3]);
    if (d) out.push({ date: d });
  }
  // 6 碼 YYMMDD(稅單的「繳納截止日 141204」= 民國 114 年 12 月 4 日)
  for (const m of text.matchAll(/(?<!\d)(\d{2})(\d{2})(\d{2})(?!\d)/g)) {
    const d = twoDigitYearDate(+m[1], +m[2], +m[3], today);
    if (d) out.push({ date: d });
  }
  return out;
}

/**
 * 關鍵字後面的文字:同一行剩下的部分 + 後面兩行。
 * 表格式帳單的值常在下一行,而 OCR 有時會在中間多吐一行雜訊。
 */
function regionsAfter(lines, keyword, skip) {
  const re = typeof keyword === 'string' ? new RegExp(escapeRe(keyword)) : keyword;
  const regions = [];
  lines.forEach((line, i) => {
    const m = line.match(re);
    if (!m || skip?.test(line)) return;
    regions.push([line.slice(m.index + m[0].length), ...lines.slice(i + 1, i + 3)].join(' \n '));
  });
  return regions;
}

function findDueDate(lines, today) {
  for (const { re } of DUE_MATCHERS) {
    for (const region of regionsAfter(lines, re)) {
      // 截止日通常是附近日期裡最晚的那個(計費期間、出帳日都比較早)
      let dates = allDates(region).filter((d) => near(d.date, today, BARCODE_WINDOW_DAYS));
      if (!dates.length) dates = looseDates(region, today).filter((d) => near(d.date, today, BARCODE_WINDOW_DAYS));
      if (dates.length) return latest(dates);
    }
  }
  return null;
}

function findAmountIn(region) {
  let text = region;
  for (const d of allDates(region)) text = text.replace(region.substr(d.index, d.length), ' ');
  const nums = [...text.matchAll(/(NT\$|NTD|\$|新臺幣|新台幣)?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?\s*(元)?/g)]
    .map((m) => ({ value: Number(m[2].replace(/,/g, '')), marked: !!(m[1] || m[3]) }))
    .filter((n) => n.value >= MIN_AMOUNT);
  return (nums.find((n) => n.marked) || nums[0])?.value ?? null;
}

/** @returns {{ amount: number, rank: number } | null} rank 越小,找到它的關鍵字越可靠 */
function findAmount(lines) {
  for (const { re, rank } of AMOUNT_MATCHERS) {
    for (const region of regionsAfter(lines, re, AMOUNT_SKIP)) {
      const amount = findAmountIn(region);
      if (amount != null) return { amount, rank };
    }
  }
  return null;
}

// 轉帳/ATM 繳費用的帳號
const ACCOUNT_KEYWORDS = [
  '繳費帳號', '繳款帳號', '轉帳帳號', '虛擬帳號', '匯款帳號', '轉入帳號', '專屬帳號', '繳費帳戶', '繳款帳戶',
  '銷帳編號', // 稅單、部分帳單用 ATM 繳費時輸入的是銷帳編號
  '帳號',
];
const ACCOUNT_SKIP = /扣款帳號|扣繳帳號|約定帳號/; // 這些是「從哪個帳戶扣」,不是要繳進去的帳號
// 4 碼一組(1234 5678 9012 3456 / 1234-5678-9012-34)或一整串 10–16 碼
const ACCOUNT_RE = /(?<![\d-])(\d{4}(?:[ -]\d{4}){1,2}(?:[ -]\d{1,4})?|\d{10,16})(?![\d-])/;
const BANK_CODE_RE = /(?:銀行代[碼號]|金融機構代[碼號]|代收行代[碼號]|轉入行代[碼號]|銀行)\s*[:]?\s*\(?(\d{3})\)?(?!\d)/;

/** 銀行代碼:先找「銀行代碼 822」這種寫法,再找「代碼」後面(可能隔一兩行)單獨的 3 位數。 */
function findBankCode(lines) {
  const direct = lines.join('\n').match(BANK_CODE_RE)?.[1];
  if (direct) return direct;
  // 稅單:「繳款類別」5 碼(例如 11331),表頭在上、數值在下一行
  for (const region of regionsAfter(lines, '繳款類別')) {
    const m = region.match(/(?<!\d)(\d{5})(?!\d)/);
    if (m) return m[1];
  }
  for (const kw of ['代碼', '代號']) {
    for (const region of regionsAfter(lines, kw)) {
      const m = region.match(/(?<![\d,.])(\d{3})(?![\d,])/);
      if (m) return m[1];
    }
  }
  return null;
}

function findPayAccount(lines) {
  for (const kw of ACCOUNT_KEYWORDS) {
    for (const region of regionsAfter(lines, kw, ACCOUNT_SKIP)) {
      // 帳號前面常寫「(822)」這種銀行代碼,先拿掉免得黏成一串
      const paren = region.match(/\((\d{3})\)/);
      const m = region.replace(/\(\d{3}\)/g, ' ').match(ACCOUNT_RE);
      if (!m) continue;
      const accountNo = m[1].replace(/[ -]/g, '');
      if (accountNo.length < 10 || accountNo.length > 16) continue;
      const bank = paren?.[1] || findBankCode(lines);
      return { accountNo, ...(bank ? { bankCode: bank } : {}) };
    }
  }
  return null;
}

/**
 * OCR 出來的全文 → { amount?, dueDate?, dueDateGuessed?, accountNo?, bankCode? }。
 * 先找關鍵字;找不到截止日關鍵字時,退而求其次猜「近期內最晚的日期」(dueDateGuessed = true)。
 */
/** 「115 年 09-10 月」這種寫法 → 帳單月份(起始月)與週期。 */
function findPeriodRange(lines) {
  const m = lines.join('\n').match(/(?<!\d)(\d{3,4})\s*年\s*(\d{1,2})\s*[-~至到]\s*(\d{1,2})\s*月/);
  if (!m) return null;
  const year = normalizeYear(+m[1]);
  const from = +m[2];
  const to = +m[3];
  if (!validDate(year, from, 1) || !validDate(year, to, 1)) return null;
  const months = ((to - from + 12) % 12) + 1;
  if (![2, 3, 6, 12].includes(months)) return null;
  return { period: `${year}-${String(from).padStart(2, '0')}`, cycleMonths: months };
}

export function parseBillText(text, today = todayISO()) {
  const lines = normalizeOcrText(text).split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const result = {};
  const found = findAmount(lines);
  if (found) Object.assign(result, { amount: found.amount, amountRank: found.rank });
  Object.assign(result, findPeriodRange(lines));
  Object.assign(result, findPayAccount(lines));
  const due = findDueDate(lines, today);
  if (due) {
    result.dueDate = due;
  } else {
    const guess = latest(allDates(lines.join('\n')).filter((d) => {
      const n = diffDays(today, d.date);
      return n >= -GUESS_PAST_DAYS && n <= GUESS_FUTURE_DAYS;
    }));
    if (guess) {
      result.dueDate = guess;
      result.dueDateGuessed = true;
    }
  }
  return result;
}

/**
 * 合併多種來源;條碼比 OCR 可靠,優先採用。
 * ocrTexts 可以是好幾次 OCR 的結果(不同版面分析模式)。
 */
export function mergeScan(barcodeTexts, ocrTexts = [], today = todayISO()) {
  const fromBarcode = parseConvenienceBarcodes(barcodeTexts, today);
  const texts = (Array.isArray(ocrTexts) ? ocrTexts : [ocrTexts]).filter(Boolean).map((t) => parseBillText(t, today));
  const fromText = {};
  let amountRank = Infinity;
  for (const r of texts) {
    // 好幾次 OCR 都找到金額時,採用「找到它的關鍵字最可靠」的那個
    if (r.amount != null && r.amountRank < amountRank) {
      fromText.amount = r.amount;
      amountRank = r.amountRank;
    }
    if (!fromText.accountNo && r.accountNo) fromText.accountNo = r.accountNo;
    if (!fromText.bankCode && r.bankCode && r.accountNo === fromText.accountNo) fromText.bankCode = r.bankCode;
    if (!fromText.period && r.period) Object.assign(fromText, { period: r.period, cycleMonths: r.cycleMonths });
    if (r.dueDate && (!fromText.dueDate || (fromText.dueDateGuessed && !r.dueDateGuessed))) {
      fromText.dueDate = r.dueDate;
      fromText.dueDateGuessed = !!r.dueDateGuessed;
    }
  }
  let dueSource = fromBarcode.dueDate ? 'barcode' : fromText.dueDate ? (fromText.dueDateGuessed ? 'guess' : 'ocr') : null;
  let amountSource = fromBarcode.amount != null ? 'barcode' : fromText.amount != null ? 'ocr' : null;
  // 條碼本身沒讀到時,看 OCR 有沒有讀到印在條碼下方的那串字(第一段、第三段)
  const printed = printedBarcodes((Array.isArray(ocrTexts) ? ocrTexts : [ocrTexts]).filter(Boolean), today);
  if (!fromBarcode.dueDate && printed.dueDate) {
    if (!fromText.dueDate || fromText.dueDateGuessed || fromText.dueDate === printed.dueDate) {
      Object.assign(fromText, { dueDate: printed.dueDate, dueDateGuessed: false });
      dueSource = 'printed';
    }
  }
  if (fromBarcode.amount == null && printed.amount != null) {
    // 15 碼的數字也可能是別的號碼:跟文字辨識的金額一致,或前 4 碼是近期的年月才採用
    if (fromText.amount === printed.amount || (fromText.amount == null && printed.period)) {
      fromText.amount = printed.amount;
      amountSource = 'printed';
    }
  }
  const result = {
    ...fromText,
    ...fromBarcode,
    source: { amount: amountSource, dueDate: dueSource },
  };
  // 稅單:條碼/表格上的「繳納截止日」是繳納期間屆滿後 3 日(稅單上有註明)。
  // 截止日改用繳納期間最後一天,條碼上的日期另外記成 taxCutoff(畫面上寫進備註)。
  const rawTexts = (Array.isArray(ocrTexts) ? ocrTexts : [ocrTexts]).filter(Boolean);
  const isTax = fromBarcode.taxQr || rawTexts.some((t) => TAX_GRACE_RE.test(normalizeOcrText(t)));
  if (isTax && result.dueDate && dueSource !== 'guess') {
    result.taxCutoff = result.dueDate;
    result.dueDate = addDays(result.dueDate, -TAX_GRACE_DAYS);
  }
  return result;
}

/** OCR 文字裡單獨成一行、長得像三段式條碼第一段或第三段的字串(印在條碼下方的人眼可讀字)。 */
function printedBarcodes(texts, today) {
  const tokens = texts.flatMap((t) => t.split('\n'))
    .map((line) => line.replace(/\s+/g, '').toUpperCase())
    .filter((t) => /^\d{6}[0-9A-Z]{3}$|^\d{4}[0-9A-Z]{2}\d{9}$/.test(t));
  const r = parseConvenienceBarcodes(tokens, today);
  return { dueDate: r.dueDate, amount: r.amount, period: r.period };
}

const TAX_GRACE_DAYS = 3;
const TAX_GRACE_RE = /屆滿後\s*(?:3|三)\s*日/;

/** 判斷還需不需要再跑一次 OCR(換版面模式)。 */
export const scanComplete = (r) => r.amount != null && r.dueDate && r.source.dueDate !== 'guess';
