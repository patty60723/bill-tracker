// 端對端:掃描繳費單(條碼、稅單 QR、OCR、影像增強、同一表單掃兩張、即時掃描)。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  barcodeBill, dbAll, FIXTURES, textBill, fakeCameraVideo, launch, modalClick, openPage, paperWithImage, seed, startServer, waitScan,
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

// 掃描測試預設開啟開發者模式,才看得到「辨識細節」
const DEBUG_META = { meta: { onboardingDismissed: true, debugMode: true } };
async function newBillPage({ debug = true, ...opts } = {}) {
  const ctx = await openPage(browser, server.url, opts);
  await seed(ctx.page, server.url, debug ? DEBUG_META : undefined);
  await ctx.page.goto(`${server.url}#/bill/new`);
  await ctx.page.waitForSelector('#scan-btn');
  return ctx;
}
const value = (page, name) => page.inputValue(`[name=${name}]`);
/** 結果卡片:{ 金額: '$1,234 條碼', … } */
const cards = (page) => page.$$eval('.scan-fields .sf', (els) => Object.fromEntries(els.map((e) => [
  e.querySelector('.sf-label').textContent, [e.querySelector('.sf-value').textContent, e.querySelector('.src')?.textContent].filter(Boolean).join(' '),
])));
const pick = (page, name, buffer, mimeType = 'image/jpeg') => page.setInputFiles('#pick-input', { name, mimeType, buffer });

test('超商三段式條碼:截止日與金額從條碼帶入', async () => {
  const { page, context, errors } = await newBillPage();
  await pick(page, 'bill.jpg', await barcodeBill(page, ['151031K6A', '1510AB000001234']));
  const status = await waitScan(page);
  assert.match(status, /辨識完成/); // 合成圖片解析度低,會多一個「解析度偏低」的提醒
  assert.match(await page.textContent('.scan-warnings'), /解析度偏低/);
  const c = await cards(page);
  assert.equal(c['金額'], '$1,234 條碼');
  assert.equal(c['截止日'], '10/31 條碼');
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

test('內建條碼偵測讀錯幾碼時,以 zxing 的結果為準', async () => {
  const ctx = await openPage(browser, server.url);
  const { page, context, errors } = ctx;
  // 模擬 Android 的 BarcodeDetector:第三段讀錯成 9999
  await page.addInitScript(() => {
    window.BarcodeDetector = class {
      static async getSupportedFormats() { return ['code_39']; }
      async detect() { return [{ rawValue: '1510AB000009999', boundingBox: { x: 120, y: 400, width: 600, height: 140 } }]; }
    };
  });
  await seed(page, server.url, DEBUG_META);
  await page.goto(`${server.url}#/bill/new`);
  await page.waitForSelector('#scan-btn');
  await pick(page, 'bill.jpg', await barcodeBill(page, ['151031K6A', '1510AB000001234']));
  await waitScan(page);
  assert.equal(await value(page, 'amount'), '1234');
  const detail = await page.textContent('.scan-detail pre');
  assert.match(detail, /1510AB000009999〔內建〕/);
  assert.match(detail, /條碼引擎:內建 \d+ 次/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('記住同一張帳單:存成固定繳費時記下特徵,下次掃到自動選上那個固定繳費', async () => {
  const { page, context, errors } = await newBillPage();
  const bill = await barcodeBill(page, ['151031K6A', '1510AB000001234']);
  await pick(page, 'bill.jpg', bill);
  await waitScan(page);
  await page.fill('[name=name]', '我家電費');
  await page.check('[name=saveTemplate]');
  await page.click('button[type=submit]');
  await page.waitForSelector('.bill-row');
  const [tpl] = await dbAll(page, 'templates');
  assert.equal(tpl.scanHints.collectionCode, 'K6A');

  // 下一期:新增帳單、掃同一種帳單 → 自動選上「我家電費」
  await page.goto(`${server.url}#/bill/new`);
  await page.waitForSelector('#scan-btn');
  await pick(page, 'next.jpg', await barcodeBill(page, ['151130K6A', '1511AB000001500']));
  await waitScan(page);
  assert.equal(await value(page, 'templateId'), tpl.id);
  assert.equal(await value(page, 'name'), '我家電費');
  assert.equal(await value(page, 'amount'), '1500');
  assert.match(await page.textContent('#scan-status'), /認出是固定繳費「我家電費」\(同一個條碼代收代號\)/);
  assert.equal(await page.isHidden('#save-template'), true);
  assert.deepEqual(errors, []);
  await context.close();
});

test('放大條碼區有上限:條碼位置高度只有 1 px、又一直讀不齊時,不會掃幾百次', async () => {
  const { page, context, errors } = await openPage(browser, server.url);
  await page.addInitScript(() => {
    window.BarcodeDetector = class {
      static async getSupportedFormats() { return ['code_39']; }
      // 第三段的線索(讀錯一碼),高度 1 px
      async detect() { return [{ rawValue: '1510AB00000123X', boundingBox: { x: 120, y: 400, width: 600, height: 1 } }]; }
    };
  });
  await seed(page, server.url, DEBUG_META);
  await page.goto(`${server.url}#/bill/new`);
  await page.waitForSelector('#scan-btn');
  await pick(page, 'bill.jpg', await barcodeBill(page, ['151031K6A'])); // 只有第一段,永遠讀不齊
  await waitScan(page);
  const detail = await page.textContent('.scan-detail pre');
  const runs = Number(detail.match(/zxing (\d+) 次/)[1]);
  assert.ok(runs <= 60, `zxing 跑了 ${runs} 次`);
  assert.deepEqual(errors, []);
  await context.close();
});

test('結果畫面:欄位卡片標出來源;開發者模式關閉時不顯示辨識細節', async () => {
  const { page, context, errors } = await newBillPage({ debug: false });
  await pick(page, 'bill.jpg', await barcodeBill(page, ['151031K6A', '1510AB000001234']));
  await waitScan(page);
  const c = await cards(page);
  assert.equal(c['金額'], '$1,234 條碼');
  assert.equal(await page.$('.scan-detail'), null);
  // 設定頁打開開發者模式後,下一次掃描就有辨識細節
  await page.goto(`${server.url}#/settings`);
  await modalClick(page, '離開,不儲存');
  await page.check('#debug-mode');
  await page.waitForFunction(() => /已開啟/.test(document.querySelector('#toast')?.textContent || ''));
  await page.goto(`${server.url}#/bill/new`);
  await page.waitForSelector('#scan-btn');
  await pick(page, 'bill.jpg', await barcodeBill(page, ['151031K6A', '1510AB000001234']));
  await waitScan(page);
  assert.match(await page.textContent('.scan-detail pre'), /條碼解讀/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('同一張帳單的另一頁:兩頁金額不同時可以加總,明細寫進備註', async () => {
  const { page, context, errors } = await newBillPage();
  await pick(page, 'p1.jpg', await barcodeBill(page, ['151102K6A', '1510AB000002495']));
  await waitScan(page);
  assert.equal(await value(page, 'amount'), '2495');
  await page.evaluate(() => { document.querySelector('#scan-status').textContent = ''; });
  await pick(page, 'p2.jpg', await barcodeBill(page, ['151102K6A', '1510AB000001398']));
  await modalClick(page, '同一張帳單的另一頁');
  await page.waitForSelector('dialog.modal[open] >> text=這一頁也有金額', { timeout: 120000 });
  await modalClick(page, '加總');
  await waitScan(page);
  assert.equal(await value(page, 'amount'), '3893');
  assert.equal((await cards(page))['金額'], '$3,893 多頁加總');
  assert.match(await value(page, 'notes'), /2 頁加總:\$2,495 \+ \$1,398 = \$3,893/);
  assert.equal(await page.$$eval('#bill-files .file', (e) => e.length), 2); // 兩頁照片都留著
  assert.deepEqual(errors, []);
  await context.close();
});

test('帳單寫著轉帳代繳:存成固定繳費時預設自動扣款', async () => {
  const { page, context, errors } = await newBillPage();
  await pick(page, 'auto.jpg', await textBill(page, [
    '115年10月 電信費用帳單', '應繳總額  繳款截止日  繳款方式', '2,495  115/11/02  轉帳代繳',
  ]));
  await waitScan(page);
  assert.equal(await value(page, 'amount'), '2495');
  assert.equal(await page.isChecked('[name=autoPay]'), true);
  assert.match(await page.textContent('.scan-notes'), /自動扣款/);
  assert.deepEqual(errors, []);
  await context.close();
});

const pdfFile = (name) => ({ name, mimeType: 'application/pdf', buffer: fs.readFileSync(path.join(FIXTURES, '../pdf', name)) });

test('PDF 電子帳單:直接讀 PDF 裡的文字(不用辨識),條碼從畫出來的頁面讀', async () => {
  const { page, context, errors } = await newBillPage();
  await page.setInputFiles('#pick-input', pdfFile('ebill.pdf'));
  await waitScan(page);
  assert.equal(await value(page, 'amount'), '1286');
  assert.equal(await value(page, 'dueDate'), '2026-10-27');
  assert.equal(await value(page, 'accountNo'), '9999000011112222');
  assert.equal(await value(page, 'bankCode'), '822');
  const detail = await page.textContent('.scan-detail pre');
  assert.match(detail, /文字辨識 #1\(PDF 文字・第 1 頁\)/);
  assert.doesNotMatch(detail, /PaddleOCR/);
  assert.match(detail, /151027K6A/); // 條碼
  assert.equal(await page.$$eval('#bill-files .file', (e) => e.length), 1); // 存原本的 PDF
  assert.deepEqual(errors, []);
  await context.close();
});

test('PDF 有密碼:輸入錯會再問一次;取消就不加任何東西', async () => {
  const { page, context, errors } = await newBillPage();
  await page.setInputFiles('#pick-input', pdfFile('ebill-locked.pdf'));
  await page.waitForSelector('dialog.modal[open] >> text=這個 PDF 有密碼');
  await page.fill('dialog.modal[open] input', 'WRONG');
  await page.press('dialog.modal[open] input', 'Enter');
  await page.waitForSelector('dialog.modal[open] >> text=密碼不對');
  await page.fill('dialog.modal[open] input', 'A123456789');
  await modalClick(page, '開啟');
  await waitScan(page);
  assert.equal(await value(page, 'amount'), '1286');

  await page.goto(`${server.url}#/`);
  await modalClick(page, '離開,不儲存');
  await page.goto(`${server.url}#/bill/new`);
  await page.waitForSelector('#scan-btn');
  await page.setInputFiles('#pick-input', pdfFile('ebill-locked.pdf'));
  await modalClick(page, '取消');
  await page.waitForFunction(() => /已取消/.test(document.querySelector('#toast')?.textContent || ''));
  assert.equal(await page.$$eval('#bill-files .file', (e) => e.length), 0);
  assert.equal(await value(page, 'amount'), '');
  assert.deepEqual(errors, []);
  await context.close();
});

test('壞掉的 PDF:說明讀不出來,不加照片', async () => {
  const { page, context, errors } = await newBillPage();
  await page.setInputFiles('#pick-input', { name: 'bad.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 not really') });
  await page.waitForFunction(() => /讀不出這個 PDF/.test(document.querySelector('#scan-status')?.textContent || ''));
  assert.equal(await page.$$eval('#bill-files .file', (e) => e.length), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('PDF 密碼:勾「記住」之後下次自動試,不再問;設定頁可以清除', async () => {
  const { page, context, errors } = await newBillPage();
  await page.setInputFiles('#pick-input', pdfFile('ebill-locked.pdf'));
  await page.waitForSelector('dialog.modal[open] >> text=這個 PDF 有密碼');
  await page.fill('dialog.modal[open] .modal-input', 'A123456789');
  await page.check('dialog.modal[open] .modal-remember input');
  await modalClick(page, '開啟');
  await waitScan(page);
  assert.deepEqual(await page.evaluate(async () => (await import('./src/db.js')).getMeta('pdfPasswords')), ['A123456789']);

  await page.goto(`${server.url}#/`);
  await modalClick(page, '離開,不儲存');
  await page.goto(`${server.url}#/bill/new`);
  await page.waitForSelector('#scan-btn');
  await page.setInputFiles('#pick-input', pdfFile('ebill-locked.pdf'));
  await waitScan(page); // 沒有跳密碼框
  assert.equal(await value(page, 'amount'), '1286');

  await page.goto(`${server.url}#/settings`);
  await modalClick(page, '離開,不儲存');
  assert.match(await page.textContent('#pw-status'), /已記住 1 組密碼/);
  await page.click('#pw-clear');
  await modalClick(page, '清除');
  await page.waitForFunction(() => /還沒有記住/.test(document.querySelector('#pw-status')?.textContent || ''));
  assert.deepEqual(errors, []);
  await context.close();
});

test('從別的 app 分享 PDF 過來(share target):自動開新增帳單並辨識', async () => {
  const { page, context, errors } = await openPage(browser, server.url);
  await seed(page, server.url, DEBUG_META);
  await page.goto(`${server.url}#/`);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // 讓 service worker 接手
  await page.waitForSelector('.quick');
  const pdf = fs.readFileSync(path.join(FIXTURES, '../pdf/ebill.pdf')).toString('base64');
  // 模擬 Android 分享:POST multipart 到 share-target,service worker 收下後導到新增帳單
  const landed = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const form = new FormData();
    form.append('file', new File([bytes], '電費帳單.pdf', { type: 'application/pdf' }));
    // redirect: 'manual' 才看得出 service worker 回了轉址(fetch 跟著轉址後的網址不含 # 後面)
    const res = await fetch('share-target', { method: 'POST', body: form, redirect: 'manual' });
    const waiting = (await (await caches.open('bill-tracker-share')).keys()).length;
    return { type: res.type, waiting };
  }, pdf);
  assert.deepEqual(landed, { type: 'opaqueredirect', waiting: 1 });
  await page.goto(`${server.url}#/bill/new?shared=1`);
  await waitScan(page);
  assert.equal(await value(page, 'amount'), '1286');
  assert.equal(await page.$$eval('#bill-files .file', (e) => e.length), 1);
  assert.equal(new URL(page.url()).hash, '#/bill/new'); // 拿掉 shared,重新整理不會再辨識一次
  assert.equal(await page.evaluate(async () => (await (await caches.open('bill-tracker-share')).keys()).length), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('掃描成 PDF(只有圖片):改用文字辨識', async () => {
  const { page, context, errors } = await newBillPage();
  await page.setInputFiles('#pick-input', pdfFile('scanned.pdf'));
  await waitScan(page);
  assert.equal(await value(page, 'amount'), '1286');
  assert.equal(await value(page, 'dueDate'), '2026-10-27');
  assert.match(await page.textContent('.scan-detail pre'), /文字辨識 #1\(PaddleOCR/);
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

test('OCR:表格式帳單(PaddleOCR);辨識細節可以一鍵複製', async () => {
  const { page, context, errors } = await newBillPage({ permissions: ['clipboard-read', 'clipboard-write'] });
  await pick(page, 'table.png', fs.readFileSync(path.join(FIXTURES, 'ocr-table.png')), 'image/png');
  await waitScan(page);
  assert.equal((await cards(page))['金額'], '$1,286 文字');
  assert.equal(await value(page, 'amount'), '1286');
  assert.equal(await value(page, 'dueDate'), '2026-10-27');
  // 辨識細節列出每個步驟的耗時(用來量手機上的速度)
  const detail = await page.textContent('.scan-detail pre');
  assert.match(detail, /耗時:條碼.*載入 PaddleOCR [\d.]+s.*找文字框\(\d+ 個\) [\d.]+s.*辨識文字\(.*執行緒\) [\d.]+s.*\(共 [\d.]+s\)/);
  assert.match(detail, /文字辨識 #1\(PaddleOCR・\d+ 個文字框\)/);
  assert.match(detail, /條碼解讀:第一段\(截止日\)✗ 沒讀到/);
  await page.click('.scan-detail summary');
  await page.click('[data-copy-detail]');
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent === '已複製辨識細節');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), detail);
  assert.deepEqual(errors, []);
  await context.close();
});

test('OCR:PaddleOCR 載入失敗時改用 Tesseract,錯誤列在辨識細節', async () => {
  // service worker 處理的請求 Playwright 攔不到,這個測試先關掉 service worker
  const { page, context, errors } = await newBillPage({ serviceWorkers: 'block' });
  await page.route('**/vendor/paddle/ppocrv5_rec.onnx', (route) => route.abort());
  await pick(page, 'table.png', fs.readFileSync(path.join(FIXTURES, 'ocr-table.png')), 'image/png');
  await waitScan(page);
  assert.equal(await value(page, 'amount'), '1286');
  assert.equal(await value(page, 'dueDate'), '2026-10-27');
  const detail = await page.textContent('.scan-detail pre');
  assert.match(detail, /文字辨識 #1\(Tesseract・增強・自動版面\)/);
  assert.match(detail, /錯誤:[\s\S]*PaddleOCR:/);
  // 擋掉的那個請求會被記成網路錯誤,其他不該有錯
  assert.deepEqual(errors.filter((e) => !/ppocrv5_rec/.test(e)), []);
  await context.close();
});

test('OCR:色塊底的帳單(讀得到金額、截止日、帳號)', async () => {
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
  await seed(page, server.url, DEBUG_META);
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
