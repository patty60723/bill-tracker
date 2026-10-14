// 掃描繳費單:條碼(zxing-wasm)+ 文字辨識(PaddleOCR,備援 Tesseract.js),都放在 vendor/,不靠外部 CDN。
// OCR 的引擎和模型(PaddleOCR 約 22 MB、Tesseract 約 12 MB)第一次用到才下載,之後由 service worker 快取、可離線。

import { enhanceDocument } from './enhance.js';
import { paddleOCR } from './paddle.js';

const ZXING_FORMATS = ['Code39', 'Code128', 'Code93', 'ITF', 'QRCode', 'EAN-13'];
const NATIVE_FORMATS = ['code_39', 'code_128', 'code_93', 'itf', 'qr_code', 'ean_13'];

const vendorUrl = (path) => new URL(`../vendor/${path}`, import.meta.url).href;

const scripts = new Map();
function loadScript(src) {
  if (!scripts.has(src)) {
    scripts.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => {
        scripts.delete(src);
        reject(new Error(`載入失敗:${src}`));
      };
      document.head.append(s);
    }));
  }
  return scripts.get(src);
}

async function loadZXing() {
  await loadScript(new URL('../vendor/zxing-reader.js', import.meta.url).href);
  const wasm = new URL('../vendor/zxing_reader.wasm', import.meta.url).href;
  window.ZXingWASM.setZXingModuleOverrides({ locateFile: () => wasm });
  return window.ZXingWASM;
}

/** 照片原始解析度(診斷用:拍出來的照片如果太小,條碼和小字就讀不到)。 */
export async function imageSize(file) {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close?.();
    return size;
  } catch {
    return null;
  }
}

async function toCanvas(file, maxDim) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas;
}

/** 照片縮小成 JPEG 再存,避免手機空間被原圖塞爆。PDF 等非圖片原樣保存。 */
export async function compressImage(file, maxDim = 2560, quality = 0.9) {
  if (!file.type.startsWith('image/')) return file;
  try {
    const canvas = await toCanvas(file, maxDim);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}

const MAX_SCAN_DIM = 4096; // 手機照片原尺寸大約 4000 px,不先縮小:繳費單的條碼線很細

let nativeDetectorPromise;
/** 瀏覽器內建的條碼偵測(Android Chrome 有,很快);沒有就回傳 null。 */
function nativeDetector() {
  nativeDetectorPromise ??= (async () => {
    if (!('BarcodeDetector' in window)) return null;
    const supported = await window.BarcodeDetector.getSupportedFormats();
    const formats = NATIVE_FORMATS.filter((f) => supported.includes(f));
    return formats.length ? new window.BarcodeDetector({ formats }) : null;
  })().catch(() => null);
  return nativeDetectorPromise;
}

/**
 * 在一張 canvas 上找條碼:先用內建偵測,再用 zxing。回傳 [{ text, box }],
 * box 是條碼在這張 canvas 上的範圍 { x, y, w, h }(拿來決定要放大重掃哪一塊)。
 * 錯誤不丟出去,收集在 errors 裡(顯示在「辨識細節」)。
 */
async function detectBoxes(canvas, errors, stats = newStats()) {
  const found = [];
  let t = performance.now();
  try {
    const native = await nativeDetector();
    if (native) {
      stats.native.runs++;
      for (const r of await native.detect(canvas)) {
        const b = r.boundingBox;
        stats.native.read++;
        found.push({ text: r.rawValue, engine: 'native', box: b && { x: b.x, y: b.y, w: b.width, h: b.height } });
      }
      stats.native.ms += performance.now() - t;
    }
  } catch (e) {
    errors.push(`內建條碼偵測:${e.message || e}`);
    // Android 的偵測服務有時候整個不能用(not implemented / service unavailable),之後就別再叫它
    if (/not implemented|unavailable|NotSupported/i.test(`${e.name} ${e.message}`)) nativeDetectorPromise = Promise.resolve(null);
  }
  t = performance.now();
  try {
    const zx = await loadZXing();
    const imageData = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
    stats.zxing.runs++;
    const results = await zx.readBarcodes(imageData, {
      formats: ZXING_FORMATS, tryHarder: true, tryRotate: true, maxNumberOfSymbols: 12,
    });
    stats.zxing.ms += performance.now() - t;
    for (const r of results) {
      if (!r.isValid || !r.text) {
        stats.zxing.invalid++;
        if (r.error) errors.push(`zxing 讀到但無效:${r.error}`);
        continue;
      }
      stats.zxing.read++;
      const pts = r.position ? [r.position.topLeft, r.position.topRight, r.position.bottomLeft, r.position.bottomRight] : [];
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      found.push({
        text: r.text,
        engine: 'zxing',
        box: pts.length ? { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) } : null,
      });
    }
  } catch (e) {
    errors.push(`zxing:${e.message || e}`);
  }
  return found;
}

const newStats = () => ({ native: { runs: 0, read: 0, ms: 0 }, zxing: { runs: 0, read: 0, invalid: 0, ms: 0 } });
const ENGINE_NAME = { native: '內建', zxing: 'zxing' };

/** 在一張 canvas 上找條碼,只回傳內容(即時掃描用)。 */
export async function detectCanvas(canvas, { errors = [] } = {}) {
  return [...new Set((await detectBoxes(canvas, errors)).map((r) => r.text))];
}

/** 從 src 切一塊 (x, y, w, h),放大 scale 倍。 */
function cropCanvas(src, x, y, w, h, scale = 1) {
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, x, y, w, h, 0, 0, c.width, c.height);
  return c;
}

// 可以當「條碼區在這裡」線索的條碼:長度像三段式條碼的一段(讀錯幾碼也算,位置還是對的)
const SEGMENT_HINT = /^\*?[0-9A-Z-]{8,20}\*?$/;
const UPSCALE = 2;
const MAX_CROP_DIM = 4096;
const MAX_ZOOMS = 5; // 最多放大幾欄(一個線索最多 3 欄:靠左、置中、靠右)
const MAX_ROWS = 12; // 每欄最多切幾條
const ZOOM_BUDGET_MS = 4000; // 放大重掃最多花這麼久(手機上 zxing 一次約 50 ms)

/**
 * 三段式條碼是上下疊在同一欄,各段長度不同(9 / 16 / 15 碼)。讀到其中一段(或讀錯但長度像)時,
 * 推算整欄的範圍,再切成一條條「只比條碼高一點」的細橫條放大重掃。
 * 實測(真實帳單照片):整張、大塊裁切都讀不到第三段——同一列左邊的文字和其他條碼會干擾 zxing,
 * 條碼又矮,大圖上 zxing 掃描的列間距太稀;切成條碼高度 2.5 倍的細條、放大 2 倍就穩定讀到。
 * u = 換算成 16 碼時的條碼寬度。各段可能靠左、置中或靠右對齊;短的那段(第一段)三種都試。
 * 回傳要掃的橫條清單(原圖座標)。
 */
function columnRows(hit, W, H) {
  const { box, text } = hit;
  const len = text.replace(/\*/g, '').length;
  const u = box.w * Math.max(1, 16 / len);
  const lefts = len >= 14 ? [box.x - 0.1 * u] : [box.x - 0.1 * u, box.x + box.w / 2 - 0.6 * u, box.x + box.w - 1.1 * u];
  // 條碼只在少數幾條掃描線上讀到時,回報的高度可能只有 1–2 px(實測一次切出幾百條、條碼花 26 秒),
  // 所以高度限制在 u 的 8%–25%(超商條碼高度大約是寬度的 10%–20%),每欄最多 MAX_ROWS 條
  const bh = Math.min(Math.max(box.h, 0.08 * u), 0.25 * u);
  const top = Math.max(0, box.y - 0.6 * u);
  const bottom = Math.min(H, box.y + box.h + 0.6 * u);
  const count = Math.max(1, Math.min(MAX_ROWS, Math.ceil((bottom - top) / (bh * 1.25))));
  const step = (bottom - top) / count;
  const rowH = Math.max(bh * 2.5, step * 1.5);
  const columns = [];
  for (const left of lefts) {
    const x = Math.max(0, left);
    const w = Math.min(W, left + 1.2 * u) - x;
    const rows = [];
    for (let i = 0; i < count; i++) {
      const y = top + i * step;
      const h = Math.min(H, y + rowH) - y;
      if (w > 0 && h > 0) rows.push({ x, y, w, h });
    }
    columns.push({ region: { x, y: rows[0]?.y ?? 0, w, h: (rows.at(-1)?.y ?? 0) + rowH - (rows[0]?.y ?? 0) }, rows });
  }
  return columns;
}

const overlaps = (a, b) => {
  const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return ix > 0 && iy > 0 && ix * iy > 0.5 * Math.min(a.w * a.h, b.w * b.h);
};

/**
 * 讀照片裡的條碼:
 * 1. 整張(原解析度)掃一次;
 * 2. 讀到像三段式條碼的一段(讀錯也算)、但 isEnough(texts) 還不滿足 → 那一欄放大 2 倍重掃;
 * 3. 還不夠 → 把照片切成重疊的橫條各掃一次(條碼常在帳單下方,切小一點比較容易對準),
 *    橫條裡讀到新的一段,一樣放大那一欄重掃。
 * @returns {{ texts: string[], errors: string[], engines: string, sources: Object<string, string> }}
 *   engines / sources 是診斷用:各引擎掃了幾次、花多久;每個條碼是哪個引擎讀到的。
 */
export async function readBarcodes(file, { isEnough = () => false, timings } = {}) {
  const t0 = performance.now();
  const errors = [];
  const found = new Set();
  let canvas;
  try {
    canvas = await toCanvas(file, MAX_SCAN_DIM);
  } catch (e) {
    return { texts: [], errors: [`讀不到照片:${e.message || e}`] };
  }
  const { width: W, height: H } = canvas;
  const steps = [];
  const zoomed = [];
  const stats = newStats();
  const sources = {};
  const enough = () => isEnough([...found]);
  /** 掃 canvas(在原圖的 (ox, oy)、縮放 scale),回傳可當線索的條碼(位置換回原圖座標)。 */
  const scan = async (c, ox = 0, oy = 0, scale = 1) => {
    const hits = [];
    for (const r of await detectBoxes(c, errors, stats)) {
      found.add(r.text);
      (sources[r.text] ??= new Set()).add(ENGINE_NAME[r.engine]);
      const text = r.text.trim().toUpperCase();
      if (r.box && r.box.w > 0 && SEGMENT_HINT.test(text)) {
        hits.push({ text, box: { x: ox + r.box.x / scale, y: oy + r.box.y / scale, w: r.box.w / scale, h: r.box.h / scale } });
      }
    }
    return hits;
  };
  let zoomDeadline = null; // 第一次放大時開始計時,超過 ZOOM_BUDGET_MS 就不再放大
  const overBudget = () => zoomDeadline !== null && performance.now() > zoomDeadline;
  const zoomColumns = async (hits) => {
    for (const hit of hits) {
      if (enough() || zoomed.length >= MAX_ZOOMS || overBudget()) return;
      zoomDeadline ??= performance.now() + ZOOM_BUDGET_MS;
      for (const { region, rows } of columnRows(hit, W, H)) {
        // 同一塊已經放大掃過就不再掃
        if (enough() || !rows.length || zoomed.some((z) => overlaps(z, region))) continue;
        zoomed.push(region);
        for (const r of rows) {
          if (enough() || overBudget()) break;
          const scale = Math.min(UPSCALE, MAX_CROP_DIM / Math.max(r.w, r.h));
          await scan(cropCanvas(canvas, r.x, r.y, r.w, r.h, scale), r.x, r.y, scale);
        }
      }
    }
  };

  await zoomColumns(await scan(canvas));
  const size = Math.round(H / 3);
  let strips = 0;
  for (let y = H - size; y >= 0 && !enough(); y -= Math.round(size / 2)) {
    const scale = Math.min(UPSCALE, MAX_CROP_DIM / W);
    const hits = await scan(cropCanvas(canvas, 0, y, W, size, scale), 0, y, scale);
    strips++;
    await zoomColumns(hits);
  }
  if (zoomed.length) steps.unshift(`放大 ${zoomed.length} 區`);
  if (strips) steps.push(`${strips} 條`);
  timings?.push({ label: steps.length ? `條碼(整張 + ${steps.join(' + ')})` : '條碼', ms: performance.now() - t0 });
  const sec = (ms) => `${(ms / 1000).toFixed(1)}s`;
  const engines = [
    stats.native.runs ? `內建 ${stats.native.runs} 次 ${sec(stats.native.ms)} 讀到 ${stats.native.read} 個` : '內建:這個瀏覽器沒有',
    `zxing ${stats.zxing.runs} 次 ${sec(stats.zxing.ms)} 讀到 ${stats.zxing.read} 個${stats.zxing.invalid ? `(另有 ${stats.zxing.invalid} 個無效)` : ''}`,
  ].join(' · ');
  // zxing 讀到的排前面:內建偵測偶爾會讀錯幾碼(實測把 092057000004504 讀成 0920570004504),
  // 同一段有兩個版本時 parse 會採用先出現的那個
  const byZxing = (t) => (sources[t]?.has('zxing') ? 0 : 1);
  return {
    texts: [...found].sort((a, b) => byZxing(a) - byZxing(b)),
    errors: [...new Set(errors)],
    engines,
    sources: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, [...v].join('+')])),
  };
}

/** 文件增強後的 canvas(去陰影、去色塊底、拉對比),見 enhance.js。 */
function enhancedCanvas(src) {
  const ctx = src.getContext('2d', { willReadFrequently: true });
  const enhanced = enhanceDocument(ctx.getImageData(0, 0, src.width, src.height));
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  c.getContext('2d').putImageData(new ImageData(enhanced.data, src.width, src.height), 0, 0);
  return c;
}

/**
 * OCR。先用 PaddleOCR(準、有多執行緒時也快);不夠(isEnough 不成立)或載入失敗,再用 Tesseract
 * 依序試:增強後的影像(自動版面)→ 增強後(零散文字模式)→ 原始照片。每次跑完問 isEnough(texts, layouts),
 * 夠了就停。回傳每一次的文字、版面(每一行、每個字的位置)、用的引擎(labels)和錯誤。
 * onProgress({ engine, loading?, progress?, pass? });timings(可省略):每個步驟花多久,顯示在「辨識細節」。
 */
export async function readText(file, { onProgress, isEnough = () => true, timings } = {}) {
  let t = performance.now();
  const lap = (label) => {
    const now = performance.now();
    timings?.push({ label, ms: now - t });
    t = now;
  };
  const texts = [];
  const layouts = [];
  const labels = [];
  const errors = [];
  try {
    const r = await paddleOCR(file, { lap, onProgress: (p) => onProgress?.({ engine: 'paddle', ...p }) });
    texts.push(r.text);
    layouts.push(r.layout);
    labels.push(`PaddleOCR・${r.boxes} 個文字框`);
    if (isEnough(texts, layouts)) return { texts, layouts, labels, errors };
  } catch (e) {
    console.warn(e);
    errors.push(`PaddleOCR:${e?.message || e}`);
    lap('PaddleOCR 失敗');
  }

  await loadScript(vendorUrl('tesseract/tesseract.min.js'));
  const original = await toCanvas(file, 2200);
  lap('準備照片');
  const enhanced = enhancedCanvas(original);
  lap('影像增強');
  const passes = [[enhanced, '3', '增強・自動版面'], [enhanced, '11', '增強・零散文字'], [original, '3', '原圖']];
  let pass = 0;
  const worker = await window.Tesseract.createWorker('chi_tra+eng', 1, {
    workerPath: vendorUrl('tesseract/worker.min.js'),
    corePath: vendorUrl('tesseract/'),
    langPath: vendorUrl('tesseract/'),
    logger: (m) => {
      if (m.status === 'recognizing text') onProgress?.({ engine: 'tesseract', pass: pass + 1, total: passes.length, progress: m.progress });
      else if (/loading|initializ/.test(m.status)) onProgress?.({ engine: 'tesseract', loading: true });
    },
  });
  lap('載入 Tesseract');
  try {
    for (; pass < passes.length; pass++) {
      const [canvas, psm, label] = passes[pass];
      await worker.setParameters({ tessedit_pageseg_mode: psm });
      const { data } = await worker.recognize(canvas);
      texts.push(data.text);
      layouts.push(layoutLines(data));
      labels.push(`Tesseract・${label}`);
      lap(`Tesseract #${pass + 1}(${label})`);
      if (isEnough(texts, layouts)) break;
    }
  } finally {
    await worker.terminate();
  }
  return { texts, layouts, labels, errors };
}

/**
 * Tesseract 的版面結果 → 每一行的文字、範圍和每個字(詞)的範圍,給 parse.js 依位置找值用
 * (例如表格「應繳金額」表頭正下方那一格)。座標是送進 OCR 的那張圖的像素。
 */
function layoutLines(data) {
  const box = (b) => ({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 });
  return (data.blocks || []).flatMap((b) => b.paragraphs || []).flatMap((p) => p.lines || [])
    .map((l) => ({ text: l.text, ...box(l.bbox), words: (l.words || []).map((w) => ({ text: w.text, ...box(w.bbox) })) }))
    .filter((l) => l.words.length);
}
