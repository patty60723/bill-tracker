// 端對端:掃描繳費單(條碼、稅單 QR、OCR、影像增強、同一表單掃兩張、即時掃描)。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  barcodeBill, FIXTURES, fakeCameraVideo, launch, modalClick, openPage, paperWithImage, seed, startServer, waitScan,
} from './helpers.mjs';

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

async function newBillPage(opts) {
  const ctx = await openPage(browser, server.url, opts);
  await seed(ctx.page, server.url);
  await ctx.page.goto(`${server.url}#/bill/new`);
  await ctx.page.waitForSelector('#scan-btn');
  return ctx;
}
const value = (page, name) => page.inputValue(`[name=${name}]`);
const pick = (page, name, buffer, mimeType = 'image/jpeg') => page.setInputFiles('#pick-input', { name, mimeType, buffer });

test('超商三段式條碼:截止日與金額從條碼帶入', async () => {
  const { page, context, errors } = await newBillPage();
  await pick(page, 'bill.jpg', await barcodeBill(page, ['151031K6A', '1510AB000001234']));
  const status = await waitScan(page);
  assert.match(status, /金額 \$1,234\(條碼\)/);
  assert.match(status, /截止日 10\/31\(條碼\)/);
  assert.equal(await value(page, 'amount'), '1234');
  assert.equal(await value(page, 'dueDate'), '2026-10-31');
  assert.equal(await page.$$eval('#bill-files .file', (e) => e.length), 1);
  const detail = await page.textContent('.scan-detail pre');
  assert.match(detail, /條碼解讀:第一段\(截止日\)✓ 10\/31 · 第三段\(金額\)✓ \$1,234/);
  assert.match(detail, /151031K6A〔zxing〕/); // 每個條碼標出是哪個引擎讀到的
  assert.match(detail, /條碼引擎:內建:這個瀏覽器沒有 · zxing \d+ 次 [\d.]+s 讀到 \d+ 個/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('稅單 QR:繳款類別、銷帳編號、金額;截止日往前 3 天,條碼日期寫進備註', async () => {
  const { page, context, errors } = await newBillPage();
  await pick(page, 'tax.jpg', await paperWithImage(page, 'tax-qr.png'));
  await waitScan(page);
  assert.equal(await value(page, 'amount'), '502');
  assert.equal(await value(page, 'dueDate'), '2025-12-01');
  assert.equal(await value(page, 'bankCode'), '11331');
  assert.equal(await value(page, 'accountNo'), '1234567890123456');
  assert.equal(await value(page, 'period'), '2025-12'); // 截止日離本月很遠 → 帳單月份跟著改
  assert.match(await value(page, 'notes'), /條碼上的繳納截止日是 12\/4/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('OCR:表格式帳單(增強影像 + 版面模式);辨識細節可以一鍵複製', async () => {
  const { page, context, errors } = await newBillPage({ permissions: ['clipboard-read', 'clipboard-write'] });
  await pick(page, 'table.png', fs.readFileSync(path.join(FIXTURES, 'ocr-table.png')), 'image/png');
  const status = await waitScan(page);
  assert.match(status, /文字辨識/);
  assert.equal(await value(page, 'amount'), '1286');
  assert.equal(await value(page, 'dueDate'), '2026-10-27');
  // 辨識細節列出每個步驟的耗時(用來量手機上的速度)
  const detail = await page.textContent('.scan-detail pre');
  assert.match(detail, /耗時:條碼.*影像增強 [\d.]+s.*文字辨識 #1\(增強・自動版面\) [\d.]+s.*\(共 [\d.]+s\)/);
  assert.match(detail, /條碼解讀:第一段\(截止日\)✗ 沒讀到/);
  await page.click('.scan-detail summary');
  await page.click('[data-copy-detail]');
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent === '已複製辨識細節');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), detail);
  assert.deepEqual(errors, []);
  await context.close();
});

test('OCR:色塊底的帳單(影像增強後讀得到金額、截止日、帳號)', async () => {
  const { page, context, errors } = await newBillPage();
  await pick(page, 'colorbox.jpg', fs.readFileSync(path.join(FIXTURES, 'colorbox-bill.jpg')));
  await waitScan(page);
  assert.equal(await value(page, 'amount'), '3286');
  assert.equal(await value(page, 'dueDate'), '2026-10-28');
  assert.equal(await value(page, 'accountNo'), '9876543210987654');
  assert.deepEqual(errors, []);
  await context.close();
});

test('同一表單掃第二張:選「另一張帳單」會清掉上一張的資料與照片,保留自己打的', async () => {
  const { page, context, errors } = await newBillPage();
  await page.fill('[name=name]', '我自己打的');
  await pick(page, 'tax.jpg', await paperWithImage(page, 'tax-qr.png'));
  await waitScan(page);
  await page.evaluate(() => { document.querySelector('#scan-status').textContent = ''; });
  await pick(page, 'power.jpg', await barcodeBill(page, ['151105K6A', '1511AB000001888']));
  await modalClick(page, '另一張帳單');
  await waitScan(page);
  assert.equal(await value(page, 'amount'), '1888');
  assert.equal(await value(page, 'dueDate'), '2026-11-05');
  assert.equal(await value(page, 'accountNo'), '');
  assert.equal(await value(page, 'notes'), '');
  assert.equal(await value(page, 'name'), '我自己打的');
  assert.equal(await page.$$eval('#bill-files .file', (e) => e.length), 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('對準條碼掃:假相機依序拍到兩段條碼,讀齊後自動關閉並帶入', async () => {
  const helperBrowser = await launch();
  const tmp = await openPage(helperBrowser, server.url);
  await tmp.page.goto(`${server.url}manifest.webmanifest`);
  const video = await fakeCameraVideo(tmp.page, ['151031K6A', '1510AB000004504']);
  await helperBrowser.close();

  const cam = await launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${video}`],
  });
  const { page, errors } = await openPage(cam, server.url, { permissions: ['camera'] });
  await seed(page, server.url);
  await page.goto(`${server.url}#/bill/new`);
  await page.click('#live-btn');
  await page.waitForSelector('dialog.live-scan video');
  await page.waitForFunction(() => !document.querySelector('dialog.live-scan'), null, { timeout: 60000 });
  assert.equal(await value(page, 'amount'), '4504');
  assert.equal(await value(page, 'dueDate'), '2026-10-31');
  assert.deepEqual(errors, []);
  await cam.close();
  fs.rmSync(path.dirname(video), { recursive: true, force: true });
});
