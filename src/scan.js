// 掃描繳費單:條碼(zxing-wasm)+ 文字辨識(Tesseract.js),兩者都放在 vendor/,不靠外部 CDN。
// OCR 的引擎和中英文辨識資料約 12 MB,第一次用到才下載,之後由 service worker 快取、可離線。

import { enhanceDocument } from './enhance.js';

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
async function detectBoxes(canvas, errors) {
  const found = [];
  try {
    const native = await nativeDetector();
    if (native) {
      for (const r of await native.detect(canvas)) {
        const b = r.boundingBox;
        found.push({ text: r.rawValue, box: b && { x: b.x, y: b.y, w: b.width, h: b.height } });
      }
    }
  } catch (e) {
    errors.push(`內建條碼偵測:${e.message || e}`);
  }
  try {
    const zx = await loadZXing();
    const imageData = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
    const results = await zx.readBarcodes(imageData, {
      formats: ZXING_FORMATS, tryHarder: true, tryRotate: true, maxNumberOfSymbols: 12,
    });
    for (const r of results) {
      if (!r.isValid || !r.text) continue;
      const pts = r.position ? [r.position.topLeft, r.position.topRight, r.position.bottomLeft, r.position.bottomRight] : [];
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      found.push({
        text: r.text,
        box: pts.length ? { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) } : null,
      });
    }
  } catch (e) {
    errors.push(`zxing:${e.message || e}`);
  }
  return found;
}

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

// 超商三段式條碼的樣子:第一段 9 碼、第二段 16 碼、第三段 15 碼
const TW_SEGMENT = /^\*?[0-9A-Z]{9}\*?$|^\*?[0-9A-Z]{15,16}\*?$/;
const UPSCALE = 2;
const MAX_CROP_DIM = 4096;

/**
 * 三段式條碼是上下疊在同一欄。讀到其中一段時,把那一欄(左右、上下各留一些)切出來放大重掃:
 * 細條碼在手機照片上常常糊成一片,放大後 zxing 比較讀得到。實測同一張帳單,
 * 照片縮小到 40% 整張讀不到任何條碼,這一欄放大 2 倍還是讀得到第一、三段。
 */
function columnRegion(boxes, W, H) {
  const x0 = Math.min(...boxes.map((b) => b.x));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  const bw = x1 - x0;
  const x = Math.max(0, x0 - bw * 0.2);
  const y = Math.max(0, y0 - bw * 0.8);
  const w = Math.min(W, x1 + bw * 0.2) - x;
  const h = Math.min(H, y1 + bw * 0.8) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

/**
 * 讀照片裡的條碼:
 * 1. 整張(原解析度)掃一次;
 * 2. 讀到三段式條碼的其中一段、但 isEnough(texts) 還不滿足 → 那一欄放大 2 倍重掃;
 * 3. 還不夠 → 把照片切成重疊的橫條各掃一次(條碼常在帳單下方,切小一點比較容易對準),
 *    橫條裡讀到新的一段,一樣放大那一欄重掃。
 * @returns {{ texts: string[], errors: string[] }}
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
  const enough = () => isEnough([...found]);
  /** 掃 canvas(在原圖的 (ox, oy)、縮放 scale),回傳讀到的三段式條碼位置(原圖座標)。 */
  const scan = async (c, ox = 0, oy = 0, scale = 1) => {
    const boxes = [];
    for (const r of await detectBoxes(c, errors)) {
      found.add(r.text);
      if (r.box && TW_SEGMENT.test(r.text.trim().toUpperCase())) {
        boxes.push({ x: ox + r.box.x / scale, y: oy + r.box.y / scale, w: r.box.w / scale, h: r.box.h / scale });
      }
    }
    return boxes;
  };
  const zoomColumn = async (boxes) => {
    const region = boxes.length && !enough() && columnRegion(boxes, W, H);
    // 同一塊已經放大掃過就不再掃
    if (!region || zoomed.some((z) => Math.abs(z.x - region.x) < region.w * 0.2 && Math.abs(z.y - region.y) < region.h * 0.2)) return;
    zoomed.push(region);
    const scale = Math.min(UPSCALE, MAX_CROP_DIM / Math.max(region.w, region.h));
    await scan(cropCanvas(canvas, region.x, region.y, region.w, region.h, scale), region.x, region.y, scale);
    steps.push('放大條碼區');
  };

  await zoomColumn(await scan(canvas));
  const size = Math.round(H / 3);
  let strips = 0;
  for (let y = H - size; y >= 0 && !enough(); y -= Math.round(size / 2)) {
    const scale = Math.min(UPSCALE, MAX_CROP_DIM / W);
    const boxes = await scan(cropCanvas(canvas, 0, y, W, size, scale), 0, y, scale);
    strips++;
    await zoomColumn(boxes);
  }
  if (strips) steps.push(`${strips} 條`);
  timings?.push({ label: steps.length ? `條碼(整張 + ${steps.join(' + ')})` : '條碼', ms: performance.now() - t0 });
  return { texts: [...found], errors: [...new Set(errors)] };
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
 * OCR。依序試:增強後的影像(自動版面)→ 增強後(零散文字模式,表格比較好)→ 原始照片,
 * 每次跑完問 isEnough(texts),夠了就停。回傳每一次的文字。
 * timings(陣列,可省略):記錄每個步驟花了多久,顯示在「辨識細節」。
 */
export async function readText(file, { onProgress, isEnough = () => true, timings } = {}) {
  let t = performance.now();
  const lap = (label) => {
    const now = performance.now();
    timings?.push({ label, ms: now - t });
    t = now;
  };
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
      if (m.status === 'recognizing text') onProgress?.({ pass: pass + 1, total: passes.length, progress: m.progress });
      else if (/loading|initializ/.test(m.status)) onProgress?.({ loading: true });
    },
  });
  lap('載入文字辨識');
  const texts = [];
  try {
    for (; pass < passes.length; pass++) {
      const [canvas, psm, label] = passes[pass];
      await worker.setParameters({ tessedit_pageseg_mode: psm });
      const { data } = await worker.recognize(canvas);
      texts.push(data.text);
      lap(`文字辨識 #${pass + 1}(${label})`);
      if (isEnough(texts)) break;
    }
  } finally {
    await worker.terminate();
  }
  return texts;
}
