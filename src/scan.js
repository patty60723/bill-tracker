// 掃描繳費單:條碼(zxing-wasm)+ 文字辨識(Tesseract.js),兩者都放在 vendor/,不靠外部 CDN。
// OCR 的引擎和中英文辨識資料約 12 MB,第一次用到才下載,之後由 service worker 快取、可離線。

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
export async function compressImage(file, maxDim = 1800, quality = 0.82) {
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
 * 在一張 canvas 上找條碼:先用內建偵測,再用 zxing。
 * 錯誤不丟出去,收集在 errors 裡(顯示在「辨識細節」)。
 */
export async function detectCanvas(canvas, { errors = [] } = {}) {
  const texts = new Set();
  try {
    const native = await nativeDetector();
    if (native) for (const r of await native.detect(canvas)) texts.add(r.rawValue);
  } catch (e) {
    errors.push(`內建條碼偵測:${e.message || e}`);
  }
  try {
    const zx = await loadZXing();
    const imageData = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
    const results = await zx.readBarcodes(imageData, {
      formats: ZXING_FORMATS, tryHarder: true, tryRotate: true, maxNumberOfSymbols: 12,
    });
    for (const r of results) if (r.isValid && r.text) texts.add(r.text);
  } catch (e) {
    errors.push(`zxing:${e.message || e}`);
  }
  return [...texts];
}

function cropCanvas(src, x, y, w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(src, x, y, w, h, 0, 0, w, h);
  return c;
}

/**
 * 讀照片裡的條碼:整張(原解析度)掃一次,isEnough(texts) 還不滿足再把照片切成
 * 重疊的橫條各掃一次(條碼常在帳單下方,切小一點比較容易對準)。
 * @returns {{ texts: string[], errors: string[] }}
 */
export async function readBarcodes(file, { isEnough = () => false } = {}) {
  const errors = [];
  const found = new Set();
  let canvas;
  try {
    canvas = await toCanvas(file, MAX_SCAN_DIM);
  } catch (e) {
    return { texts: [], errors: [`讀不到照片:${e.message || e}`] };
  }
  const add = (list) => list.forEach((t) => found.add(t));
  add(await detectCanvas(canvas, { errors }));
  const { width: W, height: H } = canvas;
  const size = Math.round(H / 3);
  for (let y = H - size; y >= 0 && !isEnough([...found]); y -= Math.round(size / 2)) {
    add(await detectCanvas(cropCanvas(canvas, 0, y, W, size), { errors }));
  }
  return { texts: [...found], errors: [...new Set(errors)] };
}

/**
 * OCR。先用自動版面分析(PSM 3);如果 isEnough(text) 說資訊還不夠,再用「零散文字」模式
 * (PSM 11)跑一次——表格式帳單用 PSM 11 讀得比較好。回傳每一次的文字。
 */
export async function readText(file, { onProgress, isEnough = () => true } = {}) {
  await loadScript(vendorUrl('tesseract/tesseract.min.js'));
  const passes = ['3', '11'];
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
  const texts = [];
  try {
    const canvas = await toCanvas(file, 2200);
    for (; pass < passes.length; pass++) {
      await worker.setParameters({ tessedit_pageseg_mode: passes[pass] });
      const { data } = await worker.recognize(canvas);
      texts.push(data.text);
      if (isEnough(texts)) break;
    }
  } finally {
    await worker.terminate();
  }
  return texts;
}
