// 日期一律用本地時區的 "YYYY-MM-DD" 字串存,避免 UTC 換算造成差一天。

export const pad2 = (n) => String(n).padStart(2, '0');

export function toISO(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function fromISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function todayISO() {
  return toISO(new Date());
}

export function daysInMonth(year, month /* 1-12 */) {
  return new Date(year, month, 0).getDate();
}

/** 指定年月的第 day 天;day 超過該月天數(例如 31 = 月底)就取月底。 */
export function clampedDate(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(Math.min(day, daysInMonth(year, month)))}`;
}

export function addMonths(year, month, delta) {
  const idx = year * 12 + (month - 1) + delta;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

export function addDays(iso, n) {
  const d = fromISO(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
}

export function diffDays(fromIso, toIso) {
  return Math.round((fromISO(toIso) - fromISO(fromIso)) / 86400000);
}

export function periodKey(year, month) {
  return `${year}-${pad2(month)}`;
}

export function parsePeriod(key) {
  const [year, month] = key.split('-').map(Number);
  return { year, month };
}

/** 檢查 y/m/d 是不是一個真的存在的日期,是的話回傳 ISO 字串。 */
export function validDate(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m))) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** 民國年(< 1911)轉西元年。 */
export function normalizeYear(y) {
  return y < 1911 ? y + 1911 : y;
}

export function formatDate(iso) {
  if (!iso) return '';
  const [, m, d] = iso.split('-');
  return `${Number(m)}/${Number(d)}`;
}

export function formatPeriod(key) {
  const { year, month } = parsePeriod(key);
  return `${year} 年 ${month} 月`;
}
