// PaddleOCR(PP-OCRv5 mobile)在瀏覽器裡跑:onnxruntime-web(WASM)。
// 流程:文字偵測(DB)找出每個文字框 → 每個框裁切後辨識(CTC)→ 依位置排成行。
// 前處理參數照 PaddleOCR / onnxocr 的預設(BGR、偵測用 ImageNet 正規化、辨識高 48)。
// 模型與執行環境在 vendor/paddle/(約 22 MB,第一次用到才下載,之後 service worker 快取)。
//
// 實測(三張真實帳單,跑一次就解析):PaddleOCR 14/14 欄位正確、Tesseract 9/14;
// 速度靠多執行緒(需要 crossOriginIsolated,由 sw.js 加 COOP/COEP 標頭),單執行緒時約慢 2–3 倍。

import { VENDOR_CACHE } from './version.js';

const vendorUrl = (path) => new URL(`../vendor/paddle/${path}`, import.meta.url).href;

// PaddleOCR 用到的所有檔案與大小(解壓後的 bytes,算下載進度用;實際傳輸有 gzip,約 22 MB)
export const PADDLE_FILES = [
  ['ort.wasm.min.mjs', 50126],
  ['ort-wasm-simd-threaded.mjs', 24381],
  ['ort-wasm-simd-threaded.wasm', 14239897],
  ['ppocrv5_det.onnx', 4819576],
  ['ppocrv5_rec.onnx', 16631306],
  ['ppocrv5_dict.txt', 92395],
];
export const PADDLE_TOTAL_BYTES = PADDLE_FILES.reduce((a, [, n]) => a + n, 0);

/** PaddleOCR 的檔案是不是都已經在快取裡(可以離線用)。瀏覽器沒有 Cache API 時回傳 null。 */
export async function paddleDownloaded() {
  if (!('caches' in self)) return null;
  for (const [f] of PADDLE_FILES) {
    if (!(await caches.match(vendorUrl(f), { ignoreSearch: true }))) return false;
  }
  return true;
}

/**
 * 預先下載(設定頁):把還沒快取的檔案下載進 VENDOR_CACHE,onProgress(已下載 bytes, 總 bytes)。
 * 自己寫進快取,不靠 service worker(第一次開 app 時它還沒接手)。
 */
export async function downloadPaddle(onProgress) {
  const cache = await caches.open(VENDOR_CACHE);
  let done = 0;
  for (const [f, size] of PADDLE_FILES) {
    const url = vendorUrl(f);
    if (await caches.match(url, { ignoreSearch: true })) {
      done += size;
      onProgress?.(done, PADDLE_TOTAL_BYTES);
      continue;
    }
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${f} 下載失敗(${res.status})`);
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      chunks.push(value);
      got += value.length;
      onProgress?.(done + Math.min(got, size), PADDLE_TOTAL_BYTES);
    }
    await cache.put(url, new Response(new Blob(chunks), { headers: { 'Content-Type': res.headers.get('Content-Type') || '' } }));
    done += size;
    onProgress?.(done, PADDLE_TOTAL_BYTES);
  }
}

/** 刪掉已下載的 PaddleOCR 檔案(釋放約 34 MB;下次拍照辨識會再下載)。 */
export async function removePaddle() {
  const names = await caches.keys();
  for (const name of names) {
    const cache = await caches.open(name);
    for (const [f] of PADDLE_FILES) await cache.delete(vendorUrl(f), { ignoreSearch: true });
  }
  enginePromise = null;
}

const DET_MAX_SIDE = 1600; // 偵測用的圖長邊;1280 會漏掉小字(實測 13/14),再大只是變慢
const DET_THRESH = 0.2; // 機率圖二值化門檻
const DET_BOX_THRESH = 0.45; // 文字框平均機率低於這個就丟掉
const DET_UNCLIP = 1.4; // 文字框往外擴(DB 的輸出框比實際文字小一圈)
const REC_HEIGHT = 48;
const REC_MAX_WIDTH = 3200;
const MIN_CONFIDENCE = 0.5; // 辨識信心太低的框(多半是條碼、圖案)不要

let enginePromise;
/** 載入 onnxruntime 與模型(只做一次)。onProgress 可以顯示「下載中」。 */
function loadEngine() {
  enginePromise ??= (async () => {
    const ort = await import(vendorUrl('ort.wasm.min.mjs'));
    ort.env.wasm.wasmPaths = vendorUrl('');
    // 多執行緒要 crossOriginIsolated(sw.js 會加標頭;第一次開 app 時 service worker 還沒接手,只能單執行緒)
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    const [det, rec, dict] = await Promise.all([
      ort.InferenceSession.create(vendorUrl('ppocrv5_det.onnx')),
      ort.InferenceSession.create(vendorUrl('ppocrv5_rec.onnx')),
      fetch(vendorUrl('ppocrv5_dict.txt')).then((r) => {
        if (!r.ok) throw new Error(`字典下載失敗(${r.status})`);
        return r.text();
      }),
    ]);
    // 索引 0 是 CTC 的空白;字典最後補一個空格(use_space_char)
    const lines = dict.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    return { ort, det, rec, chars: ['', ...lines, ' '], threads: ort.env.wasm.numThreads };
  })();
  enginePromise.catch(() => { enginePromise = null; });
  return enginePromise;
}

function context(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c.getContext('2d', { willReadFrequently: true });
}

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

/** 文字偵測:回傳原圖座標的文字框 [{ x0, y0, x1, y1 }]。 */
async function detect(e, bmp) {
  const W = bmp.width;
  const H = bmp.height;
  const scale = Math.min(1, DET_MAX_SIDE / Math.max(W, H));
  const w = Math.max(32, Math.round((W * scale) / 32) * 32);
  const h = Math.max(32, Math.round((H * scale) / 32) * 32);
  const g = context(w, h);
  g.drawImage(bmp, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;
  const n = w * h;
  const input = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    // BGR 順序:channel 0 是 B
    input[i] = (px[i * 4 + 2] / 255 - MEAN[0]) / STD[0];
    input[n + i] = (px[i * 4 + 1] / 255 - MEAN[1]) / STD[1];
    input[2 * n + i] = (px[i * 4] / 255 - MEAN[2]) / STD[2];
  }
  const out = await e.det.run({ [e.det.inputNames[0]]: new e.ort.Tensor('float32', input, [1, 3, h, w]) });
  const prob = out[e.det.outputNames[0]].data;

  // DB 後處理(簡化版):二值化 → 4 連通區塊 → 外接矩形 → 依面積/周長往外擴。
  // 帳單是平的,用軸對齊的矩形就夠,不做旋轉框。
  const label = new Uint8Array(n);
  const stack = [];
  const boxes = [];
  for (let i = 0; i < n; i++) {
    if (label[i] || prob[i] <= DET_THRESH) continue;
    let x0 = w; let y0 = h; let x1 = 0; let y1 = 0; let sum = 0; let count = 0;
    label[i] = 1;
    stack.push(i);
    while (stack.length) {
      const p = stack.pop();
      const x = p % w;
      const y = (p - x) / w;
      sum += prob[p];
      count++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && !label[p - 1] && prob[p - 1] > DET_THRESH) { label[p - 1] = 1; stack.push(p - 1); }
      if (x < w - 1 && !label[p + 1] && prob[p + 1] > DET_THRESH) { label[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && !label[p - w] && prob[p - w] > DET_THRESH) { label[p - w] = 1; stack.push(p - w); }
      if (y < h - 1 && !label[p + w] && prob[p + w] > DET_THRESH) { label[p + w] = 1; stack.push(p + w); }
    }
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    if (count < 4 || Math.min(bw, bh) < 3 || sum / count < DET_BOX_THRESH) continue;
    const d = (bw * bh * DET_UNCLIP) / (2 * (bw + bh));
    boxes.push({
      x0: Math.max(0, (x0 - d) * (W / w)),
      y0: Math.max(0, (y0 - d) * (H / h)),
      x1: Math.min(W, (x1 + 1 + d) * (W / w)),
      y1: Math.min(H, (y1 + 1 + d) * (H / h)),
    });
  }
  return boxes;
}

/** 辨識一個文字框(從原圖裁,高 48、寬依比例),CTC 貪婪解碼。 */
async function recognize(e, bmp, b) {
  const bw = b.x1 - b.x0;
  const bh = b.y1 - b.y0;
  const H = REC_HEIGHT;
  const W = Math.max(H, Math.min(REC_MAX_WIDTH, Math.ceil((H * bw) / bh)));
  const g = context(W, H);
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, b.x0, b.y0, bw, bh, 0, 0, W, H);
  const px = g.getImageData(0, 0, W, H).data;
  const n = W * H;
  const input = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    input[i] = px[i * 4 + 2] / 127.5 - 1;
    input[n + i] = px[i * 4 + 1] / 127.5 - 1;
    input[2 * n + i] = px[i * 4] / 127.5 - 1;
  }
  const out = await e.rec.run({ [e.rec.inputNames[0]]: new e.ort.Tensor('float32', input, [1, 3, H, W]) });
  const t = out[e.rec.outputNames[0]];
  const [, T, C] = t.dims;
  let text = '';
  let last = -1;
  let conf = 0;
  let count = 0;
  for (let k = 0; k < T; k++) {
    let best = 0;
    let bp = -Infinity;
    for (let j = 0; j < C; j++) {
      const v = t.data[k * C + j];
      if (v > bp) { bp = v; best = j; }
    }
    if (best !== 0 && best !== last) {
      text += e.chars[best] ?? '';
      conf += bp;
      count++;
    }
    last = best;
  }
  return { text, conf: count ? conf / count : 0 };
}

/** 文字框依位置排成行(垂直重疊超過一半算同一行),格式跟 scan.js 的 layoutLines 一樣。 */
export function toLines(words) {
  const lines = [];
  for (const w of [...words].sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1))) {
    const line = lines.find((l) => Math.min(l.y1, w.y1) - Math.max(l.y0, w.y0) > 0.5 * Math.min(l.y1 - l.y0, w.y1 - w.y0));
    if (line) {
      line.words.push(w);
      line.x0 = Math.min(line.x0, w.x0);
      line.x1 = Math.max(line.x1, w.x1);
      line.y0 = Math.min(line.y0, w.y0);
      line.y1 = Math.max(line.y1, w.y1);
    } else {
      lines.push({ x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1, words: [w] });
    }
  }
  for (const l of lines) {
    l.words.sort((a, b) => a.x0 - b.x0);
    l.text = l.words.map((w) => w.text).join(' ');
  }
  return lines.sort((a, b) => a.y0 - b.y0);
}

/**
 * 辨識一張照片。回傳 { text, layout, threads, boxes }。
 * onProgress({ loading }) / onProgress({ progress: 0–1 })。timings 同 scan.js。
 */
export async function paddleOCR(file, { onProgress, lap = () => {} } = {}) {
  onProgress?.({ loading: true });
  const e = await loadEngine();
  lap('載入 PaddleOCR');
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const boxes = await detect(e, bmp);
    lap(`找文字框(${boxes.length} 個)`);
    const words = [];
    for (let i = 0; i < boxes.length; i++) {
      const r = await recognize(e, bmp, boxes[i]);
      if (r.text.trim() && r.conf >= MIN_CONFIDENCE) words.push({ ...boxes[i], text: r.text.trim() });
      if (i % 5 === 4) onProgress?.({ progress: (i + 1) / boxes.length });
    }
    lap(`辨識文字(${e.threads > 1 ? `${e.threads} 執行緒` : '單執行緒'})`);
    const layout = toLines(words);
    return { text: layout.map((l) => l.text).join('\n'), layout, threads: e.threads, boxes: boxes.length };
  } finally {
    bmp.close?.();
  }
}
