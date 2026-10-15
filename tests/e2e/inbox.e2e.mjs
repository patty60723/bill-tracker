// 端對端:Gmail 收件匣(假的 Apps Script)→ 設定、首頁卡片、全部記錄(有把握的自動存、其他的停下來)、背景同步。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { dbAll, FIXTURES, launch, openPage, seed, startInboxMock, startServer, waitScan } from './helpers.mjs';

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

const PDF = path.join(FIXTURES, '../pdf');
const files = () => [
  { id: 'm1:0', subject: '某某電力 10 月電子帳單', name: 'ebill.pdf', type: 'application/pdf', path: path.join(PDF, 'ebill.pdf') },
  { id: 'm2:0', subject: '自來水 電子帳單', name: 'water.pdf', type: 'application/pdf', path: path.join(PDF, 'scanned.pdf') },
];
// 電費已經是固定繳費、而且記得它的條碼代收代號 → 有把握;水費沒有固定繳費 → 停下來給使用者確認
const power = { id: 'tp', name: '電費', category: 'power', cycleMonths: 2, anchorMonth: 1, arrivalDay: 1, dueDay: 27, remindDays: 3, active: true, scanHints: { collectionCode: 'K6A' }, createdAt: '2026-01-01T00:00:00Z' };

test('設定頁:貼上網址測試連線;金鑰錯會說明', async () => {
  const mock = await startInboxMock(files());
  const { page, context, errors } = await openPage(browser, server.url);
  await seed(page, server.url);
  await page.goto(`${server.url}#/settings`);
  await page.fill('#inbox-url', mock.url.replace('key=k', 'key=wrong'));
  await page.click('#inbox-save');
  await page.waitForFunction(() => /金鑰不對/.test(document.querySelector('#inbox-status')?.textContent || ''));
  await page.fill('#inbox-url', mock.url);
  await page.click('#inbox-save');
  await page.waitForFunction(() => /連上了/.test(document.querySelector('#inbox-status')?.textContent || ''));
  assert.match(await page.textContent('#inbox-status'), /「帳單」裡有 2 張待記錄/);
  assert.deepEqual(errors, []);
  await context.close();
  await mock.close();
});

test('收件匣:首頁卡片 → 全部記錄:有把握的自動存,沒把握的停下來,存完標成已處理', async () => {
  const mock = await startInboxMock(files());
  const { page, context, errors } = await openPage(browser, server.url);
  await seed(page, server.url, { templates: [power], meta: { onboardingDismissed: true, inboxUrl: mock.url } });
  await page.goto(`${server.url}#/`);
  await page.waitForSelector('a[href="#/inbox"].card', { timeout: 10000 }); // 啟動時取清單,首頁出現卡片
  assert.match(await page.textContent('a[href="#/inbox"].card'), /收件匣有 2 張電子帳單/);
  await page.click('a[href="#/inbox"].card');
  await page.waitForSelector('#inbox-all');
  assert.equal(await page.$$eval('.inbox-item', (e) => e.length), 2);
  await page.click('#inbox-all');

  // 第一張:電費(認得固定繳費、條碼有金額和截止日)→ 自動存,接著第二張
  await page.waitForFunction(() => /inbox=m2/.test(location.hash), null, { timeout: 120000 });
  let bills = await dbAll(page, 'bills');
  assert.equal(bills.length, 1);
  assert.equal(bills[0].templateId, 'tp');
  assert.equal(bills[0].amount, 1286);
  assert.deepEqual(mock.acked, ['m1:0']);

  // 第二張:掃描檔、沒有固定繳費 → 停下來,使用者按儲存
  await waitScan(page);
  assert.equal(await page.inputValue('[name=amount]'), '1286');
  await page.click('button[type=submit]');
  await page.waitForFunction(() => location.hash === '#/inbox');
  await page.waitForSelector('#inbox-list .empty');
  bills = await dbAll(page, 'bills');
  assert.equal(bills.length, 2);
  assert.deepEqual(mock.acked, ['m1:0', 'm2:0']);
  assert.deepEqual(errors, []);
  await context.close();
  await mock.close();
});

test('收件匣:已經記過的(同一個固定繳費、同一個月)自動略過;背景同步會先下載、只回報新的', async () => {
  const mock = await startInboxMock(files().slice(0, 1));
  const { page, context, errors } = await openPage(browser, server.url);
  await seed(page, server.url, {
    templates: [power],
    bills: [{ id: 'old', name: '電費', templateId: 'tp', category: 'power', period: '2026-10', amount: 1286, dueDate: '2026-10-27', status: 'unpaid' }],
    meta: { onboardingDismissed: true, inboxUrl: mock.url },
  });
  await page.goto(`${server.url}#/`);
  await page.waitForSelector('.quick');
  // 背景同步(service worker 的 periodicsync 會呼叫同一個函式)
  const fresh = await page.evaluate(async () => (await import('./src/inbox.js')).syncInboxInBackground());
  assert.deepEqual(fresh.map((i) => i.id), ['m1:0']);
  assert.deepEqual(await page.evaluate(async () => (await import('./src/inbox.js')).syncInboxInBackground()), []); // 通知過的不再通知
  const cached = await page.evaluate(async () => (await (await caches.open('bill-tracker-inbox')).keys()).length);
  assert.equal(cached, 1);

  await page.goto(`${server.url}#/bill/new?inbox=m1%3A0`);
  await page.waitForFunction(() => location.hash === '#/inbox', null, { timeout: 120000 });
  assert.equal((await dbAll(page, 'bills')).length, 1); // 沒有重複新增
  assert.deepEqual(mock.acked, ['m1:0']);
  assert.deepEqual(errors, []);
  await context.close();
  await mock.close();
});
