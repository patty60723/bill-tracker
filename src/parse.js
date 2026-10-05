// 從掃描結果(條碼文字、OCR 文字)推出繳費金額與截止日期。
//
// 台灣的超商代收繳費單是「三段式條碼」(Code 39):
//   第一段  9 碼:代收期限 YYMMDD(民國年末兩碼)+ 代收項目代號 3 碼
//   第二段 16 碼:銷帳編號
//   第三段 15 碼:應繳年月 YYMM + 檢查碼 2 碼 + 應繳金額 9 碼
// 不是每張單都長這樣(郵局劃撥、銀行、電信各有變化),所以全部都是「猜」,
// 結果只用來預填表單,使用者存檔前一定看得到、改得到。

import { normalizeYear, validDate } from './dates.js';

/** 民國年末兩碼 → 西元年。民國 100–199 年(2011–2110)都用得到。 */
function rocTwoDigitToYear(yy) {
  return 1911 + 100 + yy;
}

export function parseConvenienceBarcodes(texts) {
  const result = {};
  for (const raw of texts) {
    const t = raw.trim().toUpperCase();
    if (/^\d{6}[0-9A-Z]{3}$/.test(t) && !result.dueDate) {
      const due = validDate(rocTwoDigitToYear(+t.slice(0, 2)), +t.slice(2, 4), +t.slice(4, 6));
      if (due) {
        result.dueDate = due;
        result.collectionCode = t.slice(6);
      }
    } else if (/^\d{4}[0-9A-Z]{2}\d{9}$/.test(t) && result.amount == null) {
      const month = +t.slice(2, 4);
      const amount = +t.slice(6);
      if (month >= 1 && month <= 12 && amount > 0) {
        result.amount = amount;
        result.period = `${rocTwoDigitToYear(+t.slice(0, 2))}-${t.slice(2, 4)}`;
      }
    } else if (/^[0-9A-Z]{16}$/.test(t) && !result.accountNo) {
      result.accountNo = t;
    }
  }
  return result;
}

const AMOUNT_KEYWORDS = /(本期應繳(?:總)?金額|應繳(?:總)?金額|繳費金額|繳款金額|應付(?:總)?金額|本期金額|合計|總計|總金額|金額)/;
const DUE_KEYWORDS = /(繳費期限|繳款期限|繳款截止日?|繳費截止日?|截止日期?|最後繳費日|代收期限|繳納期限|到期日|期限)/;

const DATE_PATTERNS = [
  // 2026/10/31、2026-10-31、2026.10.31、115/10/31、115.10.31
  /(\d{2,4})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{1,2})/,
  // 115年10月31日、2026 年 10 月 31 日
  /(\d{2,4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/,
];

function findDate(text) {
  for (const re of DATE_PATTERNS) {
    const m = text.match(re);
    if (m) {
      const d = validDate(normalizeYear(+m[1]), +m[2], +m[3]);
      if (d) return { date: d, index: m.index };
    }
  }
  return null;
}

function findAmount(text) {
  const m = text.match(/(?:NT\$|NTD|\$|新臺幣|新台幣|元)?\s*([0-9]{1,3}(?:[,,][0-9]{3})+|[0-9]+)(?:\.\d{1,2})?\s*元?/);
  if (!m) return null;
  const n = Number(m[1].replace(/[,,]/g, ''));
  return n > 0 ? n : null;
}

/** OCR 出來的全文 → { amount?, dueDate? }。以關鍵字所在那一行(及下一行)為準。 */
export function parseBillText(text) {
  const lines = text
    .replace(/〇/g, '0')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const result = {};

  for (let i = 0; i < lines.length; i++) {
    const near = `${lines[i]} ${lines[i + 1] ?? ''}`;
    if (!result.dueDate) {
      const k = lines[i].search(DUE_KEYWORDS);
      if (k >= 0) {
        const found = findDate(near.slice(k));
        if (found) result.dueDate = found.date;
      }
    }
    if (result.amount == null) {
      const k = lines[i].search(AMOUNT_KEYWORDS);
      if (k >= 0) {
        // 金額關鍵字後面的文字,先把日期去掉,免得把 115/10/31 當成金額
        let rest = near.slice(k).replace(AMOUNT_KEYWORDS, '');
        for (const re of DATE_PATTERNS) rest = rest.replace(new RegExp(re, 'g'), ' ');
        const amount = findAmount(rest);
        if (amount != null) result.amount = amount;
      }
    }
  }
  return result;
}

/** 合併多種來源;條碼比 OCR 可靠,優先採用。 */
export function mergeScan(barcodeTexts, ocrText) {
  const fromBarcode = parseConvenienceBarcodes(barcodeTexts);
  const fromText = ocrText ? parseBillText(ocrText) : {};
  return {
    ...fromText,
    ...fromBarcode,
    source: {
      amount: fromBarcode.amount != null ? 'barcode' : fromText.amount != null ? 'ocr' : null,
      dueDate: fromBarcode.dueDate ? 'barcode' : fromText.dueDate ? 'ocr' : null,
    },
  };
}
