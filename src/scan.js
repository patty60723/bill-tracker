// 掃描繳費單:條碼(離線,用 repo 內附的 zxing-wasm)+ 文字辨識(OCR,需要網路)。

const ZXING_FORMATS = ['Code39', 'Code128', 'Code93', 'ITF', 'QRCode', 'EAN-13'];
const NATIVE_FORMATS = ['code_39', 'code_128', 'code_93', 'itf', 'qr_code', 'ean_13'];
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';

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

export async function readBarcodes(file) {
  const texts = new Set();
  const canvas = await toCanvas(file, 2400);
  const imageData = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);

  if ('BarcodeDetector' in window) {
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      const formats = NATIVE_FORMATS.filter((f) => supported.includes(f));
      if (formats.length) {
        for (const r of await new window.BarcodeDetector({ formats }).detect(canvas)) texts.add(r.rawValue);
      }
    } catch { /* 有些瀏覽器宣稱支援但實際丟錯,交給 zxing */ }
  }

  try {
    const zx = await loadZXing();
    const results = await zx.readBarcodes(imageData, {
      formats: ZXING_FORMATS, tryHarder: true, tryRotate: true, maxNumberOfSymbols: 12,
    });
    for (const r of results) if (r.isValid && r.text) texts.add(r.text);
  } catch (e) {
    console.warn('zxing 掃描失敗', e);
  }
  return [...texts];
}

export async function readText(file, onProgress) {
  await loadScript(TESSERACT_URL);
  const worker = await window.Tesseract.createWorker('chi_tra+eng', 1, {
    logger: (m) => m.status === 'recognizing text' && onProgress?.(m.progress),
  });
  try {
    const canvas = await toCanvas(file, 2000);
    const { data } = await worker.recognize(canvas);
    return data.text;
  } finally {
    await worker.terminate();
  }
}
