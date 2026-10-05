// 從掃描結果(條碼文字、OCR 文字)推出繳費金額與截止日期。
//
// 台灣的超商代收繳費單是「三段式條碼」(Code 39):
//   第一段  9 碼:代收期限 YYMMDD + 代收項目代號 3 碼
//   第二段 16 碼:業者自訂(銷帳編號)
//   第三段 15 碼:4 碼(民國 YYMM 或 MMDD,各家不同)+ 檢查碼 2 碼 + 應繳金額 9 碼
// 第一段的 YY 規格上是民國年末兩碼,但也有業者用西元年末兩碼,所以兩種都試,取離今天近的。
// 不是每張單都長這樣(郵局劃撥、銀行、電信各有變化),所以全部都是「猜」,
// 結果只用來預填表單,使用者存檔前一定看得到、改得到。

import { diffDays, normalizeYear, todayISO, validDate } from './dates.js';

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

export function parseConvenienceBarcodes(texts, today = todayISO()) {
  const result = {};
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
  '繳費截止日', '繳款截止日', '繳費期限', '繳款期限', '繳納期限', '限繳日期', '最後繳費日', '最後繳款日',
  '代收期限', '截止日期', '截止日', '到期日', '繳費日期', '期限',
];
const AMOUNT_KEYWORDS = [
  '本期應繳總金額', '本期應繳金額', '應繳總金額', '應繳金額', '本期應付金額', '應付總金額', '應付金額',
  '繳費金額', '繳款金額', '應繳費用', '本期費用', '總金額', '合計', '總計', '金額',
];
const AMOUNT_SKIP = /最低|已繳|上期|前期|預繳|折抵/;

const CJK = '\\u3400-\\u9fff\\uf900-\\ufaff';

/** OCR 常見問題:中文字之間被插空白、全形數字符號、數字裡混了 O/l。 */
export function normalizeOcrText(text) {
  return text
    .normalize('NFKC')
    .replace(/〇/g, '0')
    .replace(new RegExp(`([${CJK}])[ \\t]+(?=[${CJK}])`, 'g'), '$1')
    .replace(/(?<=\d)[Oo](?=[\d/.\-])|(?<=[\d/.\-])[Oo](?=\d)/g, '0')
    .replace(/(?<=\d)[lI](?=[\d/.\-])|(?<=[\d/.\-])[lI](?=\d)/g, '1');
}

// 年份限 3 碼(民國)或 4 碼(西元),避免把「15~115/09/14」之類的片段湊成日期
const DATE_RES = [
  /(?<!\d)(\d{3,4})\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*(\d{1,2})(?!\d)/g,
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
 * 關鍵字後面的文字:同一行剩下的部分 + 後面兩行。
 * 表格式帳單的值常在下一行,而 OCR 有時會在中間多吐一行雜訊。
 */
function regionsAfter(lines, keyword, skip) {
  const regions = [];
  lines.forEach((line, i) => {
    const k = line.indexOf(keyword);
    if (k < 0 || skip?.test(line)) return;
    regions.push([line.slice(k + keyword.length), ...lines.slice(i + 1, i + 3)].join(' \n '));
  });
  return regions;
}

function findDueDate(lines, today) {
  for (const kw of DUE_KEYWORDS) {
    for (const region of regionsAfter(lines, kw)) {
      // 截止日通常是附近日期裡最晚的那個(計費期間、出帳日都比較早)
      const dates = allDates(region).filter((d) => near(d.date, today, BARCODE_WINDOW_DAYS));
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

function findAmount(lines) {
  for (const kw of AMOUNT_KEYWORDS) {
    for (const region of regionsAfter(lines, kw, AMOUNT_SKIP)) {
      const amount = findAmountIn(region);
      if (amount != null) return amount;
    }
  }
  return null;
}

// 轉帳/ATM 繳費用的帳號
const ACCOUNT_KEYWORDS = ['繳費帳號', '繳款帳號', '轉帳帳號', '虛擬帳號', '匯款帳號', '轉入帳號', '專屬帳號', '繳費帳戶', '繳款帳戶', '帳號'];
const ACCOUNT_SKIP = /扣款帳號|扣繳帳號|約定帳號/; // 這些是「從哪個帳戶扣」,不是要繳進去的帳號
// 4 碼一組(1234 5678 9012 3456 / 1234-5678-9012-34)或一整串 10–16 碼
const ACCOUNT_RE = /(?<![\d-])(\d{4}(?:[ -]\d{4}){1,2}(?:[ -]\d{1,4})?|\d{10,16})(?![\d-])/;
const BANK_CODE_RE = /(?:銀行代[碼號]|金融機構代[碼號]|代收行代[碼號]|轉入行代[碼號]|銀行)\s*[:]?\s*\(?(\d{3})\)?(?!\d)/;

function findPayAccount(lines) {
  for (const kw of ACCOUNT_KEYWORDS) {
    for (const region of regionsAfter(lines, kw, ACCOUNT_SKIP)) {
      // 帳號前面常寫「(822)」這種銀行代碼,先拿掉免得黏成一串
      const paren = region.match(/\((\d{3})\)/);
      const m = region.replace(/\(\d{3}\)/g, ' ').match(ACCOUNT_RE);
      if (!m) continue;
      const accountNo = m[1].replace(/[ -]/g, '');
      if (accountNo.length < 10 || accountNo.length > 16) continue;
      const bank = lines.join('\n').match(BANK_CODE_RE)?.[1] || paren?.[1];
      return { accountNo, ...(bank ? { bankCode: bank } : {}) };
    }
  }
  return null;
}

/**
 * OCR 出來的全文 → { amount?, dueDate?, dueDateGuessed?, accountNo?, bankCode? }。
 * 先找關鍵字;找不到截止日關鍵字時,退而求其次猜「近期內最晚的日期」(dueDateGuessed = true)。
 */
export function parseBillText(text, today = todayISO()) {
  const lines = normalizeOcrText(text).split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const result = {};
  const amount = findAmount(lines);
  if (amount != null) result.amount = amount;
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
 * ocrTexts 可以是好幾次 OCR 的結果(不同版面分析模式),依序取第一個找到的。
 */
export function mergeScan(barcodeTexts, ocrTexts = [], today = todayISO()) {
  const fromBarcode = parseConvenienceBarcodes(barcodeTexts, today);
  const texts = (Array.isArray(ocrTexts) ? ocrTexts : [ocrTexts]).filter(Boolean).map((t) => parseBillText(t, today));
  const fromText = {};
  for (const r of texts) {
    if (fromText.amount == null && r.amount != null) fromText.amount = r.amount;
    if (!fromText.accountNo && r.accountNo) Object.assign(fromText, { accountNo: r.accountNo, bankCode: r.bankCode });
    if (r.dueDate && (!fromText.dueDate || (fromText.dueDateGuessed && !r.dueDateGuessed))) {
      fromText.dueDate = r.dueDate;
      fromText.dueDateGuessed = !!r.dueDateGuessed;
    }
  }
  const dueSource = fromBarcode.dueDate ? 'barcode' : fromText.dueDate ? (fromText.dueDateGuessed ? 'guess' : 'ocr') : null;
  return {
    ...fromText,
    ...fromBarcode,
    source: {
      amount: fromBarcode.amount != null ? 'barcode' : fromText.amount != null ? 'ocr' : null,
      dueDate: dueSource,
    },
  };
}

/** 判斷還需不需要再跑一次 OCR(換版面模式)。 */
export const scanComplete = (r) => r.amount != null && r.dueDate && r.source.dueDate !== 'guess';
