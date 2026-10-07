// 端對端:自動扣款、標記已繳 → 上傳證明、統計 / 搜尋 / CSV、備份、新手引導、通知、行事曆。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dbAll, FIXTURES, launch, modalClick, openPage, seed, startServer } from './helpers.mjs';

let server;
let browser;
before(async () => {
  server = await startServer();
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await server?.close();
});

const unpaid = (id, name, extra = {}) => ({
  id, name, period: '2026-10', category: 'power', amount: 1000, dueDate: '2026-10-20', status: 'unpaid', ...extra,
});

test('自動扣款:開 app 時補記已到期的期別,不重複、不提醒拿單;表單開啟時記下開啟日', async () => {
  const { page, context, errors } = await openPage(browser, server.url);
  await seed(page, server.url, {
    templates: [{
      id: 'card', name: '信用卡', category: 'card', amount: 8000, cycleMonths: 1, anchorMonth: 1, arrivalDay: 1, dueDay: 5,
      remindDays: 3, active: true, autoPay: true, autoPayFrom: '2026-09-01', createdAt: '2026-09-01T00:00:00Z',
    }],
  });
  await page.goto(`${server.url}#/`);
  await page.waitForFunction(() => /自動記錄 2 筆/.test(document.querySelector('#toast')?.textContent || ''));
  assert.equal(await page.$$eval('#reminders .reminder', (e) => e.length), 0); // 沒有「去拿單」提醒
  const bills = await dbAll(page, 'bills');
  assert.deepEqual(bills.map((b) => [b.period, b.status, b.paidMethod, b.amount]).sort(),
    [['2026-09', 'paid', '自動扣繳', 8000], ['2026-10', 'paid', '自動扣繳', 8000]]);
  await page.reload();
  await page.waitForSelector('.quick');
  await page.waitForTimeout(500);
  assert.equal((await dbAll(page, 'bills')).length, 2);

  await page.goto(`${server.url}#/template/new`);
  await page.waitForSelector('#t-form');
  await page.fill('[name=name]', '電信');
  await page.check('[name=autoPay]');
  await page.click('button[type=submit]');
  await page.waitForSelector('.card.row');
  const tpl = (await dbAll(page, 'templates')).find((t) => t.name === '電信');
  assert.equal(tpl.autoPay, true);
  assert.equal(tpl.autoPayFrom, '2026-10-07');
  assert.deepEqual(errors, []);
  await context.close();
});

test('標記已繳 → 選照片上傳證明;「復原」改回未繳;「之後再說」維持已繳', async () => {
  const { page, context, errors } = await openPage(browser, server.url);
  await seed(page, server.url, { bills: [unpaid('p1', '電費'), unpaid('p2', '水費', { category: 'water' })] });
  await page.goto(`${server.url}#/bills?month=2026-10`);
  await page.click('.bill-row:has-text("電費") [data-pay]');
  await page.waitForSelector('dialog.modal[open]');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('dialog.modal[open] button:has-text("選照片或 PDF")'),
  ]);
  await chooser.setFiles(path.join(FIXTURES, 'tax-qr.png'));
  await page.waitForFunction(() => /已上傳 1 個/.test(document.querySelector('#toast')?.textContent || ''));
  const p1 = (await dbAll(page, 'bills')).find((b) => b.id === 'p1');
  assert.equal(p1.status, 'paid');
  assert.equal(p1.paidDate, '2026-10-07');
  assert.equal(p1.proofFiles.length, 1);

  await page.click('.bill-row:has-text("水費") [data-pay]');
  await modalClick(page, '復原');
  assert.equal((await dbAll(page, 'bills')).find((b) => b.id === 'p2').status, 'unpaid');
  await page.click('.bill-row:has-text("水費") [data-pay]');
  await modalClick(page, '之後再說');
  assert.equal((await dbAll(page, 'bills')).find((b) => b.id === 'p2').status, 'paid');
  assert.deepEqual(errors, []);
  await context.close();
});

test('統計(跟去年同期比)、搜尋(焦點不跳、返回後還在)、匯出 CSV', async () => {
  const { page, context, errors } = await openPage(browser, server.url);
  const bills = [];
  for (const y of [2025, 2026]) {
    for (let m = 1; m <= 12; m++) {
      const period = `${y}-${String(m).padStart(2, '0')}`;
      bills.push({ id: `c${y}${m}`, name: '信用卡', category: 'card', period, amount: y === 2026 ? 1100 : 1000, dueDate: `${period}-05`, status: 'paid' });
    }
  }
  bills.push({ id: 'pw', name: '台電電費', category: 'power', period: '2026-07', amount: 2400, dueDate: '2026-07-25', status: 'paid', notes: '住家', accountNo: '0012345678901234' });
  await seed(page, server.url, { bills });

  await page.goto(`${server.url}#/bills?view=stats`);
  await page.waitForSelector('.bar-chart');
  // 今天是 10 月:今年 1–10 月 1100×10 + 2400 = 13400,去年 1–10 月 10000 → 多 34%
  assert.match(await page.textContent('.yoy'), /比去年同期\(1–10 月\)多 34%/);
  await page.click('.bar-col:nth-child(7)');
  assert.match(await page.textContent('#chart-detail'), /7 月:\$3,500/);
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-export="2026"]')]);
  const csv = fs.readFileSync(await download.path(), 'utf8');
  assert.ok(csv.startsWith('﻿帳單月份,'));
  assert.equal(csv.trim().split('\r\n').length, 1 + 13);
  assert.ok(csv.includes('"=""0012345678901234"""'));

  await page.goto(`${server.url}#/bills`);
  await page.fill('#bill-search', '電費 住家');
  assert.match(await page.textContent('.search-summary'), /找到 1 筆,合計 \$2,400/);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'bill-search');
  await page.click('.bill-row');
  await page.waitForSelector('#bill-form');
  await page.goBack();
  await page.waitForSelector('#bill-search');
  assert.equal(await page.inputValue('#bill-search'), '電費 住家');
  assert.deepEqual(errors, []);
  await context.close();
});

test('備份:首頁提醒 → 下載;分享(需要再點一次、取消);延後提醒;匯入前顯示摘要', async () => {
  const { page, context, errors } = await openPage(browser, server.url);
  await seed(page, server.url, {
    bills: [1, 2, 3].map((i) => ({ ...unpaid(`b${i}`, `帳單${i}`), createdAt: '2026-09-01T00:00:00Z' })),
  });
  await page.goto(`${server.url}#/`);
  await page.waitForSelector('.backup-card');
  assert.match(await page.textContent('.backup-card'), /還沒備份過\(目前有 3 筆資料\)/);
  const reminders = await page.evaluate(async () => (await (await import('./src/notify.js')).urgentReminders()).map((r) => r.kind));
  assert.ok(reminders.includes('backup'));

  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-backup-now]')]);
  const backupFile = await download.path();
  assert.match(download.suggestedFilename(), /^bill-tracker-backup-2026-10-07\.json$/);
  await page.waitForTimeout(300);
  assert.equal(await page.$('.backup-card'), null);

  await page.goto(`${server.url}#/settings`);
  await page.waitForSelector('.backup-status');
  assert.match(await page.textContent('.backup-status'), /上次備份是今天/);
  await page.evaluate(() => {
    let calls = 0;
    navigator.canShare = (d) => d.files[0].name.endsWith('.txt');
    navigator.share = async (d) => {
      calls += 1;
      window.sharedName = d.files[0].name;
      if (calls === 1) throw Object.assign(new Error('expired'), { name: 'NotAllowedError' });
    };
  });
  await page.click('#export');
  await modalClick(page, '分享');
  assert.match(await page.evaluate(() => window.sharedName), /\.txt$/);
  await page.evaluate(() => { navigator.share = async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); }; });
  await page.click('#export');
  await page.waitForFunction(() => /沒有備份/.test(document.querySelector('#toast')?.textContent || ''));

  // 匯入:先看摘要再取代
  await page.setInputFiles('#import', backupFile);
  await page.waitForSelector('dialog.modal[open]');
  assert.match(await page.textContent('dialog.modal[open]'), /3 筆帳單、0 個固定繳費/);
  await modalClick(page, '取代並匯入');
  await page.waitForFunction(() => /匯入完成/.test(document.querySelector('#toast')?.textContent || ''));
  await page.setInputFiles('#import', { name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"foo":1}') });
  await page.waitForSelector('dialog.modal[open]');
  assert.match(await page.textContent('dialog.modal[open]'), /不是「繳費小幫手」的備份檔/);
  await modalClick(page, '知道了');

  // 延後提醒
  await seed(page, server.url, { meta: { onboardingDismissed: true, lastBackupAt: '2026-08-01T00:00:00Z' } });
  await page.goto(`${server.url}#/`);
  await page.waitForSelector('.backup-card');
  await page.click('[data-backup-snooze]');
  await page.waitForTimeout(300);
  assert.equal(await page.$('.backup-card'), null);
  assert.deepEqual(errors, []);
  await context.close();
});

test('新手引導:步驟自動打勾、模擬 Android 安裝、關閉後可在設定重新顯示', async () => {
  const { page, context, errors } = await openPage(browser, server.url, { permissions: ['notifications'] });
  await page.addInitScript(() => {
    let perm = 'default';
    Object.defineProperty(Notification, 'permission', { get: () => perm });
    Notification.requestPermission = async () => { perm = 'granted'; return perm; };
  });
  await seed(page, server.url, { meta: {} });
  await page.goto(`${server.url}#/`);
  await page.waitForSelector('.onboarding');
  const done = () => page.$$eval('.steps li', (els) => els.map((e) => e.classList.contains('done')));
  assert.deepEqual(await done(), [false, false, false]);
  await page.evaluate(() => {
    const e = new Event('beforeinstallprompt');
    e.prompt = () => { window.prompted = true; };
    e.userChoice = Promise.resolve({ outcome: 'accepted' });
    window.dispatchEvent(e);
  });
  await page.click('[data-install]');
  assert.equal(await page.evaluate(() => window.prompted), true);
  await page.click('.onboarding [data-enable-notify]');
  await page.waitForFunction(() => document.querySelectorAll('.steps li.done').length === 1);
  await page.click('[data-dismiss-onboarding]');
  await page.waitForTimeout(300);
  assert.equal(await page.$('.onboarding'), null);
  await page.goto(`${server.url}#/settings`);
  await page.click('#show-onboarding');
  await page.waitForSelector('.onboarding');
  assert.deepEqual(errors, []);
  await context.close();
});

test('通知:測試通知會真的顯示並回報;行事曆匯出', async () => {
  const { page, context, errors } = await openPage(browser, server.url, { permissions: ['notifications'] });
  await seed(page, server.url, {
    templates: [{ id: 't', name: '水費', category: 'water', cycleMonths: 2, anchorMonth: 1, arrivalDay: 5, dueDay: 20, remindDays: 3, active: true, createdAt: '2026-01-01T00:00:00Z' }],
  });
  await page.goto(`${server.url}#/settings`);
  await page.waitForSelector('#notif-test');
  assert.match(await page.textContent('.version'), /繳費小幫手 v\d+/);
  // service worker 接手後重新整理(導覽請求經過 sw 的 fetch)還是正常
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForSelector('#notif-test');
  assert.ok(await page.evaluate(() => !!navigator.serviceWorker.controller));
  await page.click('#notif-test');
  await page.waitForFunction(() => /✅/.test(document.querySelector('#notif-result')?.textContent || ''));
  const shown = await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => n.title));
  assert.ok(shown.some((t) => /測試通知/.test(t)));

  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#ics')]);
  const ics = fs.readFileSync(await download.path(), 'utf8');
  assert.match(ics, /RRULE:FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=20/);
  assert.deepEqual(errors, []);
  await context.close();
});
