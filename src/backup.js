// 備份提醒的判斷(純函式,頁面與 service worker 共用)。
//
// 網頁 app 不能在背景自己存檔或上傳,所以「自動備份」=「該備份時提醒 + 一鍵用分享選單存到雲端硬碟」。

const DAY = 86400000;
export const BACKUP_INTERVAL_DAYS = 30; // 距離上次備份多久要提醒
const FIRST_BACKUP_AFTER_DAYS = 3; // 從沒備份過:開始用幾天後提醒
const MANY_CHANGES = 20; // 改了很多筆時,一週就提醒
const MANY_CHANGES_AFTER_DAYS = 7;
export const SNOOZE_DAYS = 7;

const time = (iso) => (iso ? Date.parse(iso) : NaN);

/**
 * @param lastBackupAt  上次備份時間(ISO),沒有就是從沒備份過
 * @param snoozeUntil   「之後再提醒」到期時間(ISO)
 * @param records       帳單 + 固定繳費(看 createdAt / updatedAt)
 * @returns {{ due, never, daysSince, changes, hasData }}
 *   changes = 上次備份之後新增或修改過的筆數(從沒備份過 = 全部)
 */
export function backupStatus({ lastBackupAt, snoozeUntil, records, now = Date.now() }) {
  const hasData = records.length > 0;
  const last = time(lastBackupAt);
  const never = Number.isNaN(last);
  const changedAt = (r) => Math.max(time(r.updatedAt) || 0, time(r.createdAt) || 0);
  const changes = never ? records.length : records.filter((r) => changedAt(r) > last).length;
  const daysSince = never ? null : Math.floor((now - last) / DAY);

  let due = false;
  if (hasData) {
    if (never) {
      const firstUse = Math.min(...records.map((r) => time(r.createdAt) || now));
      due = now - firstUse >= FIRST_BACKUP_AFTER_DAYS * DAY;
    } else {
      due = changes > 0 && (daysSince >= BACKUP_INTERVAL_DAYS
        || (changes >= MANY_CHANGES && daysSince >= MANY_CHANGES_AFTER_DAYS));
    }
  }
  if (due && time(snoozeUntil) > now) due = false;
  return { due, never, daysSince, changes, hasData };
}

/** 給畫面用的一句話,例如「上次備份是 45 天前,之後新增或修改了 12 筆」。 */
export function backupSummary(status) {
  if (!status.hasData) return '還沒有資料';
  if (status.never) return `還沒備份過(目前有 ${status.changes} 筆資料)`;
  const when = status.daysSince === 0 ? '今天' : ` ${status.daysSince} 天前`;
  return `上次備份是${when}${status.changes ? `,之後新增或修改了 ${status.changes} 筆` : ',之後沒有變更'}`;
}

/** 備份檔內容摘要(匯入前讓使用者確認)。不是這個 app 的備份檔就丟錯。 */
export function describeBackup(data) {
  if (data?.app !== 'bill-tracker') throw new Error('這不是「繳費小幫手」的備份檔');
  return {
    exportedAt: data.exportedAt || '',
    bills: data.bills?.length || 0,
    templates: data.templates?.length || 0,
    files: data.files?.length || 0,
  };
}
