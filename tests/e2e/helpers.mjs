// 端對端測試的共用工具:靜態伺服器、瀏覽器、資料庫種子、合成條碼、假相機影片。
// 只依賴 playwright(devDependency),其他都用 node 內建模組。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const FIXTURES = path.join(ROOT, 'tests/fixtures/images');
/** 測試裡的「今天」。頁面時鐘固定在這裡,日期相關的斷言才不會隨真實日期變動。 */
export const TODAY = '2026-10-07';
export const NOW = new Date(`${TODAY}T10:00:00`);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.wasm': 'application/wasm', '.gz': 'application/gzip',
};

/** 把 repo 根目錄當靜態網站服務(127.0.0.1、隨機 port)。 */
export function startServer() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({ url: `http://127.0.0.1:${port}/`, close: () => new Promise((r) => server.close(r)) });
  }));
}

/** 新版 headless Chromium(舊版 headless shell 的 Notification.permission 永遠是 denied)。 */
export function launch({ args = [] } = {}) {
  return chromium.launch({ channel: 'chromium', args });
}

/**
 * 開一個頁面:固定時鐘、收集頁面錯誤、偵測原生對話框(app 不該再用 confirm/alert)。
 * @returns {{ page, context, errors: string[] }}
 */
export async function openPage(browser, base, { scheme = 'light', permissions = [], width = 412 } = {}) {
  const context = await browser.newContext({
    viewport: { width, height: 860 }, deviceScaleFactor: 1, colorScheme: scheme, acceptDownloads: true,
  });
  if (permissions.length) await context.grantPermissions(permissions, { origin: base });
  const page = await context.newPage();
  await page.clock.setFixedTime(NOW);
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('dialog', (d) => { errors.push(`native dialog: ${d.message()}`); d.dismiss(); });
  page.on('response', (r) => { if (r.status() >= 400 && r.url().startsWith(base)) errors.push(`${r.status()} ${r.url()}`); });
  return { page, context, errors };
}

/**
 * 在開啟 app 之前先寫入資料。預設把新手引導關掉,免得干擾畫面。
 */
export async function seed(page, base, { templates = [], bills = [], meta = { onboardingDismissed: true } } = {}) {
  await page.goto(`${base}manifest.webmanifest`);
  await page.evaluate(({ templates, bills, meta }) => new Promise((resolve, reject) => {
    const req = indexedDB.open('bill-tracker', 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('templates', { keyPath: 'id' });
      db.createObjectStore('bills', { keyPath: 'id' }).createIndex('period', 'period');
      db.createObjectStore('files', { keyPath: 'id' });
      db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const tx = req.result.transaction(['templates', 'bills', 'meta'], 'readwrite');
      templates.forEach((t) => tx.objectStore('templates').put(t));
      bills.forEach((b) => tx.objectStore('bills').put({ billFiles: [], proofFiles: [], notes: '', cycleMonths: 1, ...b }));
      Object.entries(meta).forEach(([key, value]) => tx.objectStore('meta').put({ key, value }));
      tx.oncomplete = () => { req.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  }), { templates, bills, meta });
}

/** 讀出資料庫某個 store 的全部內容。 */
export function dbAll(page, store) {
  return page.evaluate((store) => new Promise((resolve) => {
    const req = indexedDB.open('bill-tracker');
    req.onsuccess = () => {
      const q = req.result.transaction(store).objectStore(store).getAll();
      q.onsuccess = () => { req.result.close(); resolve(q.result); };
    };
  }), store);
}

/** 等掃描結果出現(✅ 或 ⚠️),回傳第一行文字。 */
export async function waitScan(page, timeout = 180000) {
  await page.waitForFunction(() => /✅|⚠️/.test(document.querySelector('#scan-status')?.textContent || ''), null, { timeout });
  return page.$eval('#scan-status', (e) => e.innerText.split('\n')[0]);
}

/** 點自製對話框的按鈕(依文字)。 */
export async function modalClick(page, label) {
  await page.waitForSelector('dialog.modal[open]');
  await page.click(`dialog.modal[open] button:has-text("${label}")`);
  await page.waitForTimeout(200);
}

// Code 39:每個字 9 個元素(條/空交錯),n = 窄、w = 寬
const CODE39 = {
  0: 'nnnwwnwnn', 1: 'wnnwnnnnw', 2: 'nnwwnnnnw', 3: 'wnwwnnnnn', 4: 'nnnwwnnnw', 5: 'wnnwwnnnn', 6: 'nnwwwnnnn',
  7: 'nnnwnnwnw', 8: 'wnnwnnwnn', 9: 'nnwwnnwnn', A: 'wnnnnwnnw', B: 'nnwnnwnnw', K: 'wnnnnnnww', '*': 'nwnnwnwnn',
};

/**
 * 在頁面裡畫一張只有 Code 39 條碼的「繳費單」,回傳 JPEG Buffer。
 * @param codes 每一列一個條碼內容
 */
export async function barcodeBill(page, codes, { width = 1400, height = 900, narrow = 3 } = {}) {
  const b64 = await page.evaluate(({ codes, CODE39, width, height, narrow }) => {
    const c = document.createElement('canvas');
    c.width = width; c.height = height;
    const g = c.getContext('2d');
    g.fillStyle = '#f2efe6'; g.fillRect(0, 0, width, height);
    g.fillStyle = '#111';
    codes.forEach((code, row) => {
      let x = 120;
      for (const ch of `*${code}*`) {
        [...CODE39[ch]].forEach((w, i) => {
          const wd = w === 'w' ? narrow * 2.5 : narrow;
          if (i % 2 === 0) g.fillRect(x, 150 + row * 250, wd, 140);
          x += wd;
        });
        x += narrow;
      }
    });
    return c.toDataURL('image/jpeg', 0.92).split(',')[1];
  }, { codes, CODE39, width, height, narrow });
  return Buffer.from(b64, 'base64');
}

/** 把一張圖片 fixture 貼在一張紙上(模擬拍到的稅單),回傳 JPEG Buffer。 */
export async function paperWithImage(page, fixture, { width = 1200, height = 800 } = {}) {
  const src = fs.readFileSync(path.join(FIXTURES, fixture)).toString('base64');
  const b64 = await page.evaluate(async ({ src, width, height }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${src}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = width; c.height = height;
    const g = c.getContext('2d');
    g.fillStyle = '#f2efe6'; g.fillRect(0, 0, width, height);
    g.drawImage(img, width - img.width - 80, height - img.height - 80);
    return c.toDataURL('image/jpeg', 0.92).split(',')[1];
  }, { src, width, height });
  return Buffer.from(b64, 'base64');
}

/**
 * 產生假相機用的 Y4M 影片(每個條碼一段,各 frames 格),回傳檔案路徑。
 * 影格在頁面 canvas 上畫,RGB → I420 在 node 這邊換算(不需要 ffmpeg / sharp)。
 */
export async function fakeCameraVideo(page, codes, { frames = 15, w = 1280, h = 720 } = {}) {
  const parts = [Buffer.from(`YUV4MPEG2 W${w} H${h} F10:1 Ip A1:1 C420jpeg\n`)];
  for (const code of codes) {
    const rgba = Buffer.from(await page.evaluate(({ code, CODE39, w, h }) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d');
      g.fillStyle = '#d8d4cc'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#f5f2ea'; g.fillRect(80, 160, w - 160, 400);
      g.fillStyle = '#111';
      let x = 160; const n = 3.2;
      for (const ch of `*${code}*`) {
        [...CODE39[ch]].forEach((s, i) => { const wd = s === 'w' ? n * 2.5 : n; if (i % 2 === 0) g.fillRect(x, 250, wd, 200); x += wd; });
        x += n;
      }
      const d = g.getImageData(0, 0, w, h).data;
      let bin = '';
      for (let i = 0; i < d.length; i += 0x8000) bin += String.fromCharCode(...d.subarray(i, i + 0x8000));
      return btoa(bin);
    }, { code, CODE39, w, h }), 'base64');
    const y = Buffer.alloc(w * h);
    const u = Buffer.alloc((w * h) / 4);
    const v = Buffer.alloc((w * h) / 4);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const p = (j * w + i) * 4;
        const [r, gg, b] = [rgba[p], rgba[p + 1], rgba[p + 2]];
        y[j * w + i] = Math.min(255, Math.max(0, 0.257 * r + 0.504 * gg + 0.098 * b + 16));
        if (j % 2 === 0 && i % 2 === 0) {
          const q = (j / 2) * (w / 2) + i / 2;
          u[q] = Math.min(255, Math.max(0, -0.148 * r - 0.291 * gg + 0.439 * b + 128));
          v[q] = Math.min(255, Math.max(0, 0.439 * r - 0.368 * gg - 0.071 * b + 128));
        }
      }
    }
    const yuv = Buffer.concat([y, u, v]);
    for (let k = 0; k < frames; k++) parts.push(Buffer.from('FRAME\n'), yuv);
  }
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bill-cam-')), 'cam.y4m');
  fs.writeFileSync(file, Buffer.concat(parts));
  return file;
}
