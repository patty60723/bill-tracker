// 進入點:註冊頁面、全域點擊動作、啟動時的自動扣款 / 通知 / 清理。

import * as db from './db.js';
import { renderBillForm } from './pages/bill-form.js';
import { renderBills } from './pages/bills.js';
import { promptInstall, renderHome } from './pages/home.js';
import { renderSettings } from './pages/settings.js';
import { renderTemplateForm, renderTemplates } from './pages/templates.js';
import { backupNow, collectGarbage, markPaid, runAutoPay, snoozeBackup } from './ui/actions.js';
import { $, copyText, toast, view } from './ui/dom.js';
import { enableNotifications, setupServiceWorker } from './ui/notifications.js';
import { registerRoutes, render, startRouter } from './ui/router.js';

view.addEventListener('click', async (e) => {
  if (e.target.closest('[data-backup-now]')) return backupNow();
  if (e.target.closest('[data-backup-snooze]')) return snoozeBackup();
  if (e.target.closest('[data-install]')) return promptInstall();
  if (e.target.closest('[data-dismiss-onboarding]')) {
    await db.setMeta('onboardingDismissed', true);
    toast('之後可以在「設定 → 新手引導」再打開');
    render();
    return;
  }
  if (e.target.closest('[data-enable-notify]')) {
    await enableNotifications();
    render();
    return;
  }
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    e.preventDefault();
    copyText(copy.dataset.copy, '帳號');
    return;
  }
  const pay = e.target.closest('[data-pay]');
  if (pay) {
    e.preventDefault();
    markPaid(pay.dataset.pay);
  }
});

$('#viewer').addEventListener('click', (e) => e.currentTarget.close());

registerRoutes({
  '': () => renderHome(),
  bills: ({ params }) => renderBills(params),
  bill: ({ id, params }) => renderBillForm(id, params),
  templates: () => renderTemplates(),
  template: ({ id }) => renderTemplateForm(id),
  settings: () => renderSettings(),
});

startRouter();

(async () => {
  const autoPaid = await runAutoPay().catch((e) => { console.warn('自動扣款處理失敗', e); return 0; });
  await render();
  if (autoPaid) toast(`已自動記錄 ${autoPaid} 筆自動扣款`);
})();

collectGarbage();

setupServiceWorker();
