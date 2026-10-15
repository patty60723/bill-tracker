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
import { detectProfile } from './profiles.js';

const BARCODE_WINDOW_DAYS = 400; // 條碼日期離今天超過這麼久就當成看錯
const GUESS_PAST_DAYS = 60; // 沒有關鍵字時,只在這個範圍內猜截止日
const GUESS_FUTURE_DAYS = 150;
const MIN_AMOUNT = 10; // 個位數多半是 OCR 雜訊,不會是帳單金額
const MAX_AMOUNT = 9999999; // 超過就是電號、帳號之類的號碼(例如台電公共設施表的 01811619019)

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
    } else if (/^\d{4}[0-9A-Z-]{2}\d{9}$/.test(t)) { // 台電印成 00000-000002219
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
// 這些行裡的「截止日期」不是繳費期限(瓦斯單「下次抄表截止日期 115/11/15」)
const DUE_SKIP = /抄表/;
const DUE_KEYWORDS = [
  '繳費截止日', '繳款截止日', '繳納截止日', '繳費期限', '繳款期限', '繳納期限', '限繳期限', '限繳日期', '最後繳費日', '最後繳款日',
  '代收期限', '截止日期', '截止日', '到期日', '繳費日期', '期限',
];
const AMOUNT_KEYWORDS = [
  '本期應繳總金額', '本期應繳金額', '應繳總金額', '應繳總額', '應繳金額', '本期應付金額', '應付總金額', '應付金額',
  '繳費金額', '繳款金額', '總金額', '合計', '總計', '本期費用', '金額',
  '應繳費用', // 常是明細表的表頭(底下是各項費用),所以排最後
];
// 「本期應繳金額將於115/11/02…轉帳扣款」是扣款說明,不是金額欄位
const AMOUNT_SKIP = /最低|已繳|上期|前期|預繳|折抵|手續費|將於/;

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
// 帳單關鍵字會用到的簡體字 → 繁體(PaddleOCR 的字典繁簡都有,常把「繳費」讀成「缴费」)
const SIMPLIFIED = {
  缴: '繳', 费: '費', 额: '額', 账: '帳', 号: '號', 电: '電', 应: '應', 总: '總', 计: '計', 数: '數', 期: '期',
  银: '銀', 码: '碼', 单: '單', 户: '戶', 头: '頭', 汇: '匯', 转: '轉', 编: '編', 销: '銷', 纳: '納', 务: '務',
  别: '別', 资: '資', 讯: '訊', 发: '發', 票: '票', 历: '歷', 当: '當', 欠: '欠', 违: '違', 迟: '遲', 收: '收',
  价: '價', 种: '種', 类: '類', 间: '間', 区: '區', 业: '業', 网: '網', 湾: '灣',
};
const SIMPLIFIED_RE = new RegExp(`[${Object.keys(SIMPLIFIED).filter((k) => k.length === 1 && SIMPLIFIED[k] !== k).join('')}]`, 'g');

export function normalizeOcrText(text) {
  return text
    .normalize('NFKC')
    .replace(SIMPLIFIED_RE, (c) => SIMPLIFIED[c])
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

// ---------- 依位置找值(Tesseract 的版面:每一行、每個字的範圍) ----------

/** 一行的字串接起來(去掉空白),記下每個字在字串裡的位置,才能把關鍵字對回照片上的範圍。 */
function compactLine(line) {
  let text = '';
  const spans = [];
  for (const w of line.words) {
    const t = normalizeOcrText(w.text).replace(/\s+/g, '');
    spans.push({ from: text.length, to: text.length + t.length, word: w });
    text += t;
  }
  return { text, spans };
}

/**
 * 跟 regionsAfter 一樣找「關鍵字後面的值」,但依照片上的位置:
 * 同一行關鍵字右邊的字 + 正下方(3 行內)跟關鍵字同一欄的字(左右各放寬關鍵字寬度的 30%)。
 * 表格「表頭一列、數值一列」時,只會拿到自己那一欄,不會混到隔壁欄(例如台電的電號、管理費的說明欄)。
 */
function layoutRegions(layout, keyword, skip, { notList = false } = {}) {
  const re = typeof keyword === 'string' ? new RegExp(escapeRe(keyword)) : keyword;
  const lines = [...layout].sort((a, b) => a.y0 - b.y0);
  const regions = [];
  for (const line of lines) {
    const { text, spans } = compactLine(line);
    const m = text.match(re);
    if (!m || skip?.test(text)) continue;
    const end = m.index + m[0].length;
    const kw = spans.filter((s) => s.to > m.index && s.from < end).map((s) => s.word);
    const after = spans.filter((s) => s.from >= end).map((s) => s.word);
    const x0 = Math.min(...kw.map((w) => w.x0));
    const x1 = Math.max(...kw.map((w) => w.x1));
    const h = Math.max(1, line.y1 - line.y0);
    const pad = Math.max((x1 - x0) * 0.3, h);
    const below = lines
      .filter((l) => l !== line && l.y0 > line.y0 + h * 0.5 && l.y0 < line.y1 + h * 3.5)
      // 字(框)有一半以上落在這一欄才算:PaddleOCR 常把一整段(例如「收費日期 … 抄表日期 115/09/14」)
      // 框成一個,只是擦到邊不能算進來
      .map((l) => l.words.filter((w) => Math.min(w.x1, x1 + pad) - Math.max(w.x0, x0 - pad) > 0.5 * (w.x1 - w.x0)))
      .filter((ws) => ws.length)
      .slice(0, 2);
    // 找金額時:關鍵字右邊沒有數字、正下方同一欄卻連續兩行都是數字 → 這是明細表的表頭
    // (管理費單「應繳費用」底下是 3,304 / 1,000 / 200),不是總額
    const hasNumber = (ws) => ws.some((w) => /\d{2,}/.test(w.text));
    if (notList && !hasNumber(after) && below.length === 2 && below.every(hasNumber)) continue;
    regions.push(normalizeOcrText([after, ...below].map((ws) => ws.map((w) => w.text).join(' ')).join(' \n ')));
  }
  return regions;
}

// 截止日關鍵字後面又出現另一個截止日關鍵字(例如台電「繳費期限 10/01 … 代收截止日 11/06」),
// 後面那段屬於另一個欄位,不算進來
const ANY_DUE_RE = new RegExp(DUE_KEYWORDS.map(escapeRe).join('|'));

/** 有版面時先用位置找,找不到再用文字的「後面兩行」。 */
const regionFinder = (lines, layout) => (re, skip, opts) => {
  if (!layout?.length) return regionsAfter(lines, re, skip);
  // 有版面時,依位置判斷是明細表頭的就不再用文字的「後面兩行」(文字版分不出欄位,會拿到同一個明細)
  const fromLayout = layoutRegions(layout, re, skip, opts);
  const listHeader = opts?.notList && layoutRegions(layout, re, skip).length > fromLayout.length;
  return [...fromLayout, ...(listHeader ? [] : regionsAfter(lines, re, skip))];
};

function findDueDate(lines, today, regionsOf = regionFinder(lines)) {
  for (const { re } of DUE_MATCHERS) {
    for (const full of regionsOf(re, DUE_SKIP)) {
      const cut = full.search(ANY_DUE_RE);
      const region = cut > 0 ? full.slice(0, cut) : full;
      // 截止日通常是附近日期裡最晚的那個(計費期間、出帳日都比較早)
      let dates = allDates(region).filter((d) => near(d.date, today, BARCODE_WINDOW_DAYS));
      if (!dates.length) dates = looseDates(region, today).filter((d) => near(d.date, today, BARCODE_WINDOW_DAYS));
      if (dates.length) return latest(dates);
    }
  }
  return null;
}

// 「基本費:200元」這種別的欄位的值。關鍵字下一行常是明細(瓦斯單「應繳總金額」下一行是「基本費:200元」),不能當總額
// (後面接 / . - 的是日期,不拿掉;拿掉的地方換成「|」,免得前後的數字黏成一個日期)
const OTHER_LABELED = new RegExp(`[${CJK}]{2,}\\s*[:]\\s*(?:NT\\$|\\$)?\\s*-?\\d[\\d,]*(?:\\.\\d+)?(?![\\d/.-])\\s*元?`, 'g');

function findAmountIn(region) {
  // 關鍵字那一行之後的幾行:拿掉別的欄位的值
  const [first, ...rest] = region.split(' \n ');
  let text = [first, ...rest.map((l) => l.replace(OTHER_LABELED, ' | '))].join(' \n ');
  // 遮罩過的號碼(信用卡「400000******1234」、門號「09000***00」)不是金額。
  // 星號前面要有數字:台電把金額寫成「****2219」(星號補位),那是金額
  text = text.replace(/[\dA-Z]+\*{2,}[\dA-Z]*/g, ' | ');
  // 先取出所有日期字串再刪(邊刪邊用 index 會錯位)
  for (const d of allDates(text).map((x) => text.substr(x.index, x.length))) text = text.replace(d, ' ');
  // OCR 常把千分位看錯:「2,.219」「2.219」→ 2,219(小數點後剛好 3 位,帳單金額不會這樣寫)
  text = text.replace(/(?<![\d.,])(\d{1,3})(?:\s?[,.]){1,2}\s?(?=\d{3}(?![\d.]))/g, '$1,');
  const nums = [...text.matchAll(/(NT\$|NTD|\$|新臺幣|新台幣)?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?\s*(元)?/g)]
    .map((m) => ({ value: Number(m[2].replace(/,/g, '')), marked: !!(m[1] || m[3]) }))
    .filter((n) => n.value >= MIN_AMOUNT && n.value <= MAX_AMOUNT);
  return (nums.find((n) => n.marked) || nums[0])?.value ?? null;
}

/** @returns {{ amount: number, rank: number } | null} rank 越小,找到它的關鍵字越可靠 */
function findAmount(lines, list = AMOUNT_MATCHERS, regionsOf = regionFinder(lines)) {
  for (const { re, rank } of list) {
    for (const region of regionsOf(re, AMOUNT_SKIP, { notList: true })) {
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
// 「發票期別 115年07-08月」是發票的期別、不是帳單月份(OCR 常把「票」看成「栗」)。
// 表頭和數值常被拆成兩行,表頭那行沒有數字時下一行也一起跳過。
const NOT_PERIOD = /發[票栗]|載具/;
const periodLines = (lines) => lines.filter((l, i) => !NOT_PERIOD.test(l)
  && !(i > 0 && NOT_PERIOD.test(lines[i - 1]) && !/\d/.test(lines[i - 1])));

function findPeriodRange(lines) {
  const m = periodLines(lines).join('\n').match(/(?<!\d)(\d{3,4})\s*年\s*(\d{1,2})\s*[-~至到]\s*(\d{1,2})\s*月/);
  if (!m) return null;
  const year = normalizeYear(+m[1]);
  const from = +m[2];
  const to = +m[3];
  if (!validDate(year, from, 1) || !validDate(year, to, 1)) return null;
  const months = ((to - from + 12) % 12) + 1;
  if (![2, 3, 6, 12].includes(months)) return null;
  return { period: `${year}-${String(from).padStart(2, '0')}`, cycleMonths: months };
}

/** 「115 年 09 月 繳費通知單」「繳費月份 115年09月」→ 帳單月份。 */
function findPeriodMonth(lines) {
  const text = periodLines(lines).join('\n');
  const m = text.match(/(?<!\d)(\d{3,4})\s*年\s*(\d{1,2})\s*月\s*份?\s*(?:繳費通知|繳費憑證|繳款通知|帳單|電費|水費|管理費|瓦斯|天然氣|電信費|[^\d\s]{0,6}帳單)/)
    || text.match(/(?:繳費月份|帳單月份|計費月份)\s*[::]?\s*\n?\s*(\d{3,4})\s*年\s*(\d{1,2})\s*月/);
  if (!m) return null;
  const year = normalizeYear(+m[1]);
  return validDate(year, +m[2], 1) ? { period: `${year}-${String(+m[2]).padStart(2, '0')}` } : null;
}

/**
 * 計費期間(例如台電「115/07/07 至 115/09/06」)的天數 → 週期。只在帳單上有「計費期間 / 用電期間 / 抄表」
 * 時才看,避免把稅單的「繳納期間 11/01 至 11/30」當成每月。
 */
function findCycleFromRange(lines) {
  const text = lines.join('\n');
  if (!/計費期間|用電期間|列帳期間|帳單期間|抄表/.test(text)) return null;
  const re = /(\d{3,4})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*(?:至|到|~|-)\s*(\d{3,4})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{1,2})/;
  const m = text.match(re);
  if (!m) return null;
  const from = validDate(normalizeYear(+m[1]), +m[2], +m[3]);
  const to = validDate(normalizeYear(+m[4]), +m[5], +m[6]);
  if (!from || !to) return null;
  const days = diffDays(from, to);
  if (days >= 25 && days <= 35) return { cycleMonths: 1 };
  if (days >= 55 && days <= 66) return { cycleMonths: 2 };
  return null;
}

/** 「代收截止日 115/11/06」(台電)、「延期繳費日 115年11月3日」(瓦斯)、「代收期限 1151121」(自來水)。 */
// 超商最後收單日的各種叫法:台電「代收截止日」、瓦斯「延期繳費日」、自來水「代收期限」
// (自來水另寫「於 115年11月21日前仍可至代收單位繳費」)
const COLLECT_RE = /代收截止|延期繳費|代收期限|仍可至代收/;

function findCollectCutoff(lines, today) {
  for (const region of regionsAfter(lines, COLLECT_RE)) {
    // 取最靠近關鍵字的那個(allDates 是依格式分批找的,不是依位置);沒有完整日期再看「1151121」這種
    const d = allDates(region).filter((x) => near(x.date, today, BARCODE_WINDOW_DAYS)).sort((a, b) => a.index - b.index)[0]
      || looseDates(region, today).find((x) => near(x.date, today, BARCODE_WINDOW_DAYS));
    if (d) return d.date;
  }
  return null;
}

const AUTO_PAY_RE = /轉帳代繳|自動扣繳|代扣繳|自動轉帳扣款|委託扣繳|已由您的帳戶扣繳/;

const textLines = (text) => normalizeOcrText(text).split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);

/**
 * layout(可省略):這次 OCR 的版面(scan.js 的 layoutLines),有的話金額和截止日先依位置找。
 */
export function parseBillText(text, today = todayISO(), layout = null) {
  const lines = textLines(text);
  const regionsOf = regionFinder(lines, layout);
  const result = {};
  const found = findAmount(lines, AMOUNT_MATCHERS, regionsOf);
  if (found) Object.assign(result, { amount: found.amount, amountRank: found.rank });
  // 帳單標題的「115年09月繳費通知單」最可靠;「115年09-10月」這種範圍另外提供週期
  const range = findPeriodRange(lines);
  Object.assign(result, range, findPeriodMonth(lines));
  if (!result.cycleMonths) Object.assign(result, findCycleFromRange(lines));
  // 自動扣款的帳單(台灣大哥大「繳款方式 轉帳代繳」、各家「自動扣繳」)
  if (AUTO_PAY_RE.test(lines.join('\n'))) result.autoPay = true;
  const cutoff = findCollectCutoff(lines, today);
  if (cutoff) result.collectCutoff = cutoff;
  Object.assign(result, findPayAccount(lines));
  const due = findDueDate(lines, today, regionsOf);
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
export function mergeScan(barcodeTexts, ocrTexts = [], today = todayISO(), layouts = []) {
  const fromBarcode = parseConvenienceBarcodes(barcodeTexts, today);
  const texts = (Array.isArray(ocrTexts) ? ocrTexts : [ocrTexts])
    .map((t, i) => (t ? parseBillText(t, today, layouts[i]) : null)).filter(Boolean);
  const fromText = {};
  const rawTexts = (Array.isArray(ocrTexts) ? ocrTexts : [ocrTexts]).filter(Boolean);
  // 好幾次 OCR 都找到金額時,採用「找到它的關鍵字最可靠」的那個;一樣可靠時,採用在帳單上出現最多次的
  // (例如一次把 2,219 看成「2,.219」得到 219,另一次在三個地方都讀到 2,219)
  const allText = rawTexts.map(normalizeOcrText).join('\n');
  const seen = (n) => [...allText.matchAll(/\d[\d,.]*/g)].filter((m) => Number(m[0].replace(/[,.]/g, '')) === n).length;
  let amountRank = Infinity;
  for (const r of texts) {
    if (r.amount != null && (r.amountRank < amountRank
      || (r.amountRank === amountRank && r.amount !== fromText.amount && seen(r.amount) > seen(fromText.amount)))) {
      fromText.amount = r.amount;
      amountRank = r.amountRank;
    }
    if (!fromText.accountNo && r.accountNo) fromText.accountNo = r.accountNo;
    if (!fromText.bankCode && r.bankCode && r.accountNo === fromText.accountNo) fromText.bankCode = r.bankCode;
    if (!fromText.period && r.period) Object.assign(fromText, { period: r.period });
    if (!fromText.cycleMonths && r.cycleMonths) fromText.cycleMonths = r.cycleMonths;
    if (!fromText.collectCutoff && r.collectCutoff) fromText.collectCutoff = r.collectCutoff;
    if (r.autoPay) fromText.autoPay = true;
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
  // 帳單種類(profiles.js):補名稱、類別、預設週期;有指定金額欄位的,改用那個欄位的金額
  const profile = detectProfile(allText, { taxQr: fromBarcode.taxQr });
  if (profile) {
    Object.assign(fromText, { profile: profile.id, profileLabel: profile.label, category: profile.category });
    if (profile.name) fromText.issuerName = profile.name;
    if (!fromText.cycleMonths && profile.cycleMonths) fromText.cycleMonths = profile.cycleMonths;
    if (profile.amountKeywords && fromBarcode.amount == null) {
      const preferred = (Array.isArray(ocrTexts) ? ocrTexts : [ocrTexts])
        .map((t, i) => t && findAmount(textLines(t), matchers(profile.amountKeywords), regionFinder(textLines(t), layouts[i])))
        .find(Boolean);
      if (preferred && preferred.amount !== fromText.amount) {
        fromText.amount = preferred.amount;
        amountSource = 'ocr';
      }
    }
  }
  const result = {
    ...fromText,
    ...fromBarcode,
    source: { amount: amountSource, dueDate: dueSource },
  };
  if (result.collectCutoff && !(result.dueDate && result.collectCutoff > result.dueDate)) delete result.collectCutoff;
  // 台電等帳單:條碼上的日期是「代收截止日」(超商最後收單日),比帳單上的「繳費期限」晚,
  // 過了繳費期限就開始算遲付費用。截止日改用繳費期限,代收截止日記成 collectCutoff(畫面上寫進備註)。
  if (dueSource === 'barcode' && fromText.dueDate && !fromText.dueDateGuessed && fromText.dueDate < fromBarcode.dueDate
    && diffDays(fromText.dueDate, fromBarcode.dueDate) <= 60 && rawTexts.some((t) => COLLECT_RE.test(normalizeOcrText(t)))) {
    result.collectCutoff = fromBarcode.dueDate;
    result.dueDate = fromText.dueDate;
    result.source.dueDate = 'ocr';
    return result;
  }
  // 稅單:條碼/表格上的「繳納截止日」是繳納期間屆滿後 3 日(稅單上有註明)。
  // 截止日改用繳納期間最後一天,條碼上的日期另外記成 taxCutoff(畫面上寫進備註)。
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
    .filter((t) => /^\d{6}[0-9A-Z]{3}$|^\d{4}[0-9A-Z-]{2}\d{9}$/.test(t));
  const r = parseConvenienceBarcodes(tokens, today);
  return { dueDate: r.dueDate, amount: r.amount, period: r.period };
}

const TAX_GRACE_DAYS = 3;
const TAX_GRACE_RE = /屆滿後\s*(?:3|三)\s*日/;

/** 判斷還需不需要再跑一次 OCR(換版面模式)。 */
export const scanComplete = (r) => r.amount != null && r.dueDate && r.source.dueDate !== 'guess';
