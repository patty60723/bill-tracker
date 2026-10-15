// PDF 電子帳單:用 pdf.js(vendor/pdfjs/)讀出每一頁的文字(含位置)、把頁面畫成圖片給條碼辨識用。
// 電子帳單的 PDF 通常本來就有文字,直接讀比 OCR 準;條碼也是向量畫的,畫成大圖後很清楚。
// 掃描成 PDF 的(只有圖片、沒有文字)就交給 OCR。

import { toLines } from './paddle.js';

const vendorUrl = (path) => new URL(`../vendor/pdfjs/${path}`, import.meta.url).href;

const MAX_PAGES = 3; // 帳單資訊都在前幾頁;後面多半是說明、廣告
const RENDER_LONG_SIDE = 3000; // 畫成圖片的長邊(條碼線條夠粗、OCR 字夠大)
const MIN_TEXT_CHARS = 30; // 一頁讀出的字少於這個,當成掃描檔(沒有文字層)

let libPromise;
function loadLib() {
  libPromise ??= import(vendorUrl('pdf.min.mjs')).then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = vendorUrl('pdf.worker.min.mjs');
    return lib;
  });
  libPromise.catch(() => { libPromise = null; });
  return libPromise;
}

export const isPdf = (file) => file?.type === 'application/pdf' || /\.pdf$/i.test(file?.name || '');

/**
 * 讀 PDF。askPassword(wrong: boolean) 回傳密碼字串,或 null 表示使用者取消。
 * @returns {Promise<null | { numPages, pages: [{ text, layout, hasText, image: Blob, width, height }] }>}
 *   使用者取消輸入密碼時回傳 null。
 */
export async function readPdf(file, { askPassword } = {}) {
  const lib = await loadLib();
  const task = lib.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    cMapUrl: vendorUrl('cmaps/'),
    cMapPacked: true,
    wasmUrl: vendorUrl('wasm/'), // 圖片色彩(qcms)、JPEG 2000、JBIG2(掃描檔常用)
    isEvalSupported: false,
  });
  let cancelled = false;
  // 有密碼的電子帳單(信用卡、電信常用身分證字號當密碼)
  task.onPassword = async (update, reason) => {
    const pw = await askPassword?.(reason === lib.PasswordResponses.INCORRECT_PASSWORD);
    if (pw == null) {
      cancelled = true;
      task.destroy();
    } else update(pw);
  };
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    if (cancelled) return null;
    throw e;
  }
  try {
    const pages = [];
    for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES); n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(4, RENDER_LONG_SIDE / Math.max(base.width, base.height)) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      const image = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      const layout = textLayout(lib, await page.getTextContent(), viewport);
      const text = layout.map((l) => l.text).join('\n');
      pages.push({ text, layout, hasText: text.replace(/\s/g, '').length >= MIN_TEXT_CHARS, image, width: canvas.width, height: canvas.height });
      page.cleanup();
    }
    return { numPages: doc.numPages, pages };
  } finally {
    await task.destroy();
  }
}

/** pdf.js 的文字項目 → 跟 OCR 一樣的版面格式(每一行、每個字的位置;座標是畫出來那張圖的像素)。 */
function textLayout(lib, content, viewport) {
  const words = [];
  for (const item of content.items) {
    const str = item.str?.trim();
    if (!str) continue;
    const t = lib.Util.transform(viewport.transform, item.transform);
    const h = Math.hypot(t[2], t[3]); // 字的高度
    const x0 = t[4];
    const y1 = t[5];
    words.push({ text: str, x0, x1: x0 + item.width * viewport.scale, y0: y1 - h, y1 });
  }
  return toLines(words);
}
