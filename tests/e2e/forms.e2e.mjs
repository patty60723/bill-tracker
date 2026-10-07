// 端對端:表單、離開前確認、自製對話框、刪除、重複帳單、所有帳單檢視。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { dbAll, launch, modalClick, openPage, seed, startServer, TODAY } from './helpers.mjs';

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

const where = async (page) => new URL(page.url()).hash;

test('沒改過的表單離開不用確認;改過的四種離開方式都會先問,選「繼續編輯」資料還在', async () => {
  const { page, context, errors } = await openPage(browser, server.url);
  await seed(page, server.url);
  await page.goto(`${server.url}#/`);
  await page.waitForSelector('.quick');
  await page.click('text=＋ 手動新增');
  await page.waitForSelector('#bill-form');
  await page.click('a.back');
  await page.waitForSelector('.segmented');
  assert.equal(await page.$('dialog.modal[open]'), null);

  await page.goto(`${server.url}#/`);
  await page.waitForSelector('.quick');
  await page.click('text=＋ 手動新增');
  await page.waitForSelector('#bill-form');
  await page.fill('[name=amount]', '777');

  await page.click('a.back');
  await modalClick(page, '繼續編輯');
  assert.equal(await where(page), '#/bill/new');
  await page.click('nav.tabs a[data-tab=settings]');
  await modalClick(page, '繼續編輯');
  assert.equal(await where(page), '#/bill/new');
  await page.goBack(); // 手機返回鍵
  await modalClick(page, '繼續編輯');
  assert.equal(await where(page), '#/bill/new');
  await page.click('#cancel');
  await modalClick(page, '繼續編輯');
  assert.equal(await page.inputValue('[name=amount]'), '777');

  // 「繼續編輯」之後,下一次返回鍵仍然會問,而且確實往前一頁走(沒有卡在重複的瀏覽紀錄上):
  // 前一頁是一開始去過的「紀錄」頁
  await page.goBack();
  await modalClick(page, '離開,不儲存');
  await page.waitForSelector('.segmented');
  assert.match(await where(page), /^#\/bills/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('儲存不會被攔;刪除用自製確認框;同月重複新增會提醒', async () => {
  const { page, context, errors } = await openPage(browser, server.url);
  await seed(page, server.url, {
    templates: [{ id: 't1', name: '電費', category: 'power', cycleMonths: 1, anchorMonth: 1, arrivalDay: 1, dueDay: 20, remindDays: 3, active: true, createdAt: '2026-01-01T00:00:00Z' }],
  });
  await page.goto(`${server.url}#/bill/new?template=t1&period=2026-10`);
  await page.waitForSelector('#bill-form');
  await page.fill('[name=amount]', '1000');
  await page.click('button[type=submit]');
  await page.waitForSelector('.bill-row');
  assert.equal(await page.$('dialog.modal[open]'), null);

  // 同一個固定繳費、同一個月再新增一筆
  await page.goto(`${server.url}#/bill/new?template=t1&period=2026-10`);
  await page.waitForSelector('#bill-form');
  await page.click('button[type=submit]');
  await page.waitForSelector('dialog.modal[open]');
  assert.match(await page.textContent('dialog.modal[open]'), /已經有這筆了/);
  await modalClick(page, '取消');
  assert.equal((await dbAll(page, 'bills')).length, 1);

  // 刪除
  await page.goto(`${server.url}#/bills?month=2026-10`);
  await page.click('.bill-row');
  await page.waitForSelector('#delete');
  await page.click('#delete');
  await modalClick(page, '刪除');
  await page.waitForSelector('.segmented');
  assert.equal((await dbAll(page, 'bills')).length, 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('固定繳費:新增、截止日比到單日早視為隔月、離開前確認', async () => {
  const { page, context, errors } = await openPage(browser, server.url);
  await seed(page, server.url);
  await page.goto(`${server.url}#/template/new`);
  await page.waitForSelector('#t-form');
  await page.fill('[name=name]', '中華電信');
  await page.selectOption('[name=arrivalDay]', '25');
  await page.selectOption('[name=dueDay]', '10');
  assert.match(await page.textContent('#due-hint'), /隔月截止/);
  await page.click('nav.tabs a[data-tab=bills]');
  await modalClick(page, '繼續編輯');
  await page.click('button[type=submit]');
  await page.waitForSelector('.card.row');
  assert.match(await page.textContent('.card.row'), /25 號左右到單 · 隔月 10 號截止/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('紀錄:這個月沒有帳單時提示其他月份,「所有帳單」依月份分組', async () => {
  const { page, context, errors } = await openPage(browser, server.url);
  await seed(page, server.url, {
    bills: [{ id: 'b1', name: '地價稅', period: '2025-12', amount: 502, dueDate: '2025-12-01', status: 'unpaid' }],
  });
  await page.goto(`${server.url}#/bills`);
  await page.waitForSelector('.empty');
  assert.match(await page.textContent('.empty'), /其他月份有 1 筆/);
  await page.click('.segmented a:has-text("所有帳單")');
  await page.waitForSelector('.group-head');
  assert.equal(await page.textContent('.group-head'), '2025 年 12 月');
  assert.match(await page.textContent('.bill-row'), new RegExp(`逾期 ${Math.round((Date.parse(TODAY) - Date.parse('2025-12-01')) / 864e5)} 天`));
  assert.deepEqual(errors, []);
  await context.close();
});
