// 跨頁面的動作:讀資料、標記已繳(含上傳證明)、自動扣款、備份、清理孤兒檔案。

import { backupStatus, SNOOZE_DAYS } from '../backup.js';
import { todayISO } from '../dates.js';
import * as db from '../db.js';
import { ask } from '../modal.js';
import { compressImage } from '../scan.js';
import { AUTO_PAY_METHOD, planAutoPay } from '../schedule.js';
import { download, toast } from './dom.js';
import { render } from './router.js';

export async function loadAll() {
  const [templates, bills] = await Promise.all([db.getAll('templates'), db.getAll('bills')]);
  templates.sort((a, b) => a.name.localeCompare(b.name, 'zh-TW'));
  return { templates, bills };
}

// ---------- 首頁 ----------

export async function getBackupStatus(templates, bills) {
  return backupStatus({
    lastBackupAt: await db.getMeta('lastBackupAt'),
    snoozeUntil: await db.getMeta('backupSnoozeUntil'),
    records: [...bills, ...templates],
  });
}

/** 開檔案選擇器(拍照或選檔);使用者取消時回傳 []。要在點擊等使用者動作之後呼叫。 */
export function pickFiles({ camera = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = camera ? 'image/*' : 'image/*,application/pdf';
    if (camera) input.capture = 'environment';
    else input.multiple = true;
    input.onchange = () => resolve([...input.files]);
    input.oncancel = () => resolve([]);
    input.click();
  });
}

/**
 * 標記已繳,接著問要不要上傳繳費證明(拍照 / 選照片或 PDF / 之後再說),也可以在這裡復原。
 */
export async function markPaid(id) {
  const before = await db.get('bills', id);
  const paid = { ...before, status: 'paid', paidDate: todayISO(), updatedAt: new Date().toISOString() };
  await db.put('bills', paid);
  await render();
  const choice = await ask({
    title: `「${before.name}」已標記為已繳`,
    message: '要順便上傳繳費證明嗎?(收據、轉帳截圖、PDF)',
    cancelValue: 'later',
    actions: [
      { label: '📷 拍照上傳', value: 'camera', kind: 'primary' },
      { label: '🖼️ 選照片或 PDF', value: 'pick' },
      { label: '之後再說', value: 'later' },
      { label: '復原(其實還沒繳)', value: 'undo', kind: 'link' },
    ],
  });
  if (choice === 'undo') {
    await db.put('bills', before);
    toast('已復原為未繳');
    return render();
  }
  if (choice !== 'camera' && choice !== 'pick') return toast('已標記為已繳,之後可以在帳單頁上傳證明');
  const files = await pickFiles({ camera: choice === 'camera' });
  if (!files.length) return toast('已標記為已繳,之後可以在帳單頁上傳證明');
  const ids = [];
  for (const f of files) ids.push(await db.saveFile(await compressImage(f), f.name));
  const latest = await db.get('bills', id);
  await db.put('bills', { ...latest, proofFiles: [...(latest.proofFiles || []), ...ids], updatedAt: new Date().toISOString() });
  toast(`已上傳 ${ids.length} 個繳費證明`);
  render();
}

// ---------- 帳單編輯 ----------

/**
 * 備份:優先用分享選單(Android 可以直接選「雲端硬碟」,或 Gmail / LINE 傳給自己),
 * 不支援分享檔案時改成下載。成功(分享出去或已下載)才記下備份時間。
 */
export async function backupNow() {
  toast('準備備份檔…');
  const data = await db.exportAll();
  const name = `bill-tracker-backup-${todayISO()}`;
  const json = JSON.stringify(data);
  // Chrome 的分享只允許特定副檔名;.json 不行時改用 .txt(匯入時兩種都收)
  const candidates = [
    new File([json], `${name}.json`, { type: 'application/json' }),
    new File([json], `${name}.txt`, { type: 'text/plain' }),
  ];
  const shareable = candidates.find((f) => navigator.canShare?.({ files: [f] }));
  let result = 'downloaded';
  if (shareable) {
    result = await shareFile(shareable);
    if (result === 'needs-gesture') {
      // 準備檔案花太久,瀏覽器不再把這次當成使用者點擊:請使用者再點一次
      const again = await ask({
        title: '備份檔準備好了',
        message: `約 ${Math.max(1, Math.round(json.length / 1024 / 1024))} MB。點「分享」選擇雲端硬碟,或傳給自己保存。`,
        actions: [{ label: '分享 / 存到雲端', value: true, kind: 'primary' }, { label: '改用下載', value: false }],
        cancelValue: null,
      });
      if (again === null) return toast('沒有備份');
      result = again ? await shareFile(shareable) : 'download';
    }
    if (result === 'cancelled') return toast('沒有備份');
    if (result !== 'shared') result = 'download';
  }
  if (result !== 'shared') download(`${name}.json`, json, 'application/json');
  await db.setMeta('lastBackupAt', new Date().toISOString());
  await db.setMeta('backupSnoozeUntil', '');
  toast(result === 'shared' ? '已備份(記得存到雲端硬碟或傳給自己)' : '備份檔已下載到手機的「下載」資料夾');
  render();
}

export async function shareFile(file) {
  try {
    await navigator.share({ files: [file], title: '繳費小幫手備份' });
    return 'shared';
  } catch (e) {
    if (e.name === 'AbortError') return 'cancelled';
    if (e.name === 'NotAllowedError') return 'needs-gesture';
    console.warn('分享失敗', e);
    return 'failed';
  }
}

export async function snoozeBackup() {
  await db.setMeta('backupSnoozeUntil', new Date(Date.now() + SNOOZE_DAYS * 86400000).toISOString());
  toast(`${SNOOZE_DAYS} 天後再提醒`);
  render();
}

// ---------- 設定 ----------

/** 套用自動扣款(見 schedule.planAutoPay),回傳新記成已繳的筆數。 */
export async function runAutoPay() {
  const { templates, bills } = await loadAll();
  const plan = planAutoPay(templates, bills, todayISO());
  const now = new Date().toISOString();
  for (const b of plan.create) await db.put('bills', { ...b, id: db.uid(), createdAt: now, updatedAt: now });
  for (const { id, paidDate } of plan.markPaid) {
    const b = await db.get('bills', id);
    await db.put('bills', { ...b, status: 'paid', paidDate, paidMethod: b.paidMethod || AUTO_PAY_METHOD, autoPaid: true, updatedAt: now });
  }
  for (const { id, autoPayDone } of plan.templateUpdates) {
    await db.put('templates', { ...(await db.get('templates', id)), autoPayDone });
  }
  return plan.create.length + plan.markPaid.length;
}

/** 清掉沒有任何帳單引用的檔案(例如新增帳單到一半直接關掉 app)。 */
export async function collectGarbage() {
  const bills = await db.getAll('bills');
  const used = new Set(bills.flatMap((b) => [...(b.billFiles || []), ...(b.proofFiles || [])]));
  const dayAgo = Date.now() - 86400000;
  for (const f of await db.getAll('files')) {
    if (!used.has(f.id) && Date.parse(f.createdAt) < dayAgo) await db.del('files', f.id);
  }
}
