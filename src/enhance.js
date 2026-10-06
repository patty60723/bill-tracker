// 文件影像增強:讓帳單照片更好辨識(文字辨識、條碼都用)。
//
// 拍繳費單常見的問題:半邊有陰影、色塊底的表格(粉紅/淺綠欄位)、淺灰色的小字、整張偏暗。
// 辨識引擎內部用「一個門檻」把整張圖分黑白,光線不均時會整塊吃掉文字。這裡先做:
//   1. 灰階
//   2. 估計「紙張背景」亮度(形態學閉運算把文字筆畫抹掉),再用它去除 → 陰影、色塊都變成白底
//   3. 拉對比:最深的文字拉到接近黑
// 純計算、不碰 DOM,瀏覽器和 node 測試都能用。輸入輸出都是 { data: RGBA, width, height }。

const RADIUS = 6; // 半解析度下的濾波半徑:比這粗(約 24 px)的深色區塊才會被當成背景,文字筆畫不會

/** 灰階 Uint8Array */
function toGray({ data, width, height }) {
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
  }
  return gray;
}

/** 一維最大(isMax)/最小值濾波,半徑 r;horizontal 決定方向。寫成平鋪的迴圈,手機上才夠快。 */
function rankFilter(src, w, h, r, horizontal, isMax) {
  const out = new Uint8Array(src.length);
  const len = horizontal ? w : h;
  const lines = horizontal ? h : w;
  const step = horizontal ? 1 : w;
  for (let line = 0; line < lines; line++) {
    const base = horizontal ? line * w : line;
    for (let i = 0; i < len; i++) {
      const from = i - r < 0 ? 0 : i - r;
      const to = i + r >= len ? len - 1 : i + r;
      let v = src[base + from * step];
      if (isMax) {
        for (let j = from + 1; j <= to; j++) { const u = src[base + j * step]; if (u > v) v = u; }
      } else {
        for (let j = from + 1; j <= to; j++) { const u = src[base + j * step]; if (u < v) v = u; }
      }
      out[base + i * step] = v;
    }
  }
  return out;
}

/**
 * 估計紙張背景:形態學「閉運算」(先取局部最大值把深色文字抹掉,再取局部最小值把背景的邊界
 * 還原)。色塊底、陰影這種大面積的明暗會保留下來、邊緣也不會糊掉;文字筆畫則被抹掉。
 * 在半解析度上算,速度快很多。
 */
function estimateBackground(gray, width, height) {
  const w = Math.ceil(width / 2);
  const h = Math.ceil(height / 2);
  const half = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x0 = x * 2;
      const y0 = y * 2;
      const x1 = Math.min(width - 1, x0 + 1);
      const y1 = Math.min(height - 1, y0 + 1);
      half[y * w + x] = (gray[y0 * width + x0] + gray[y0 * width + x1] + gray[y1 * width + x0] + gray[y1 * width + x1]) >> 2;
    }
  }
  let bg = rankFilter(half, w, h, RADIUS, true, true);
  bg = rankFilter(bg, w, h, RADIUS, false, true);
  bg = rankFilter(bg, w, h, RADIUS, true, false);
  bg = rankFilter(bg, w, h, RADIUS, false, false);
  return { bg, w, h };
}

function bgAt({ bg, w, h }, x, y) {
  const fx = Math.min(w - 1, x / 2);
  const fy = Math.min(h - 1, y / 2);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const ax = fx - x0;
  const ay = fy - y0;
  const top = bg[y0 * w + x0] * (1 - ax) + bg[y0 * w + x1] * ax;
  const bottom = bg[y1 * w + x0] * (1 - ax) + bg[y1 * w + x1] * ax;
  return top * (1 - ay) + bottom * ay;
}

/**
 * 增強後的影像(灰階,存成 RGBA)。
 * @returns {{ data: Uint8ClampedArray, width: number, height: number }}
 */
export function enhanceDocument(image) {
  const { width, height } = image;
  const gray = toGray(image);
  const bgInfo = estimateBackground(gray, width, height);

  // 1. 除以背景:紙張(不管原本多暗、什麼顏色)→ 255
  const norm = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const b = Math.max(8, bgAt(bgInfo, x, y));
      norm[i] = Math.min(255, Math.round((gray[i] * 255) / b));
    }
  }

  // 2. 拉對比:取最暗的 0.5% 當「黑」,讓淡色字也變深;再用 gamma 讓筆畫更飽滿
  const hist = new Uint32Array(256);
  for (const v of norm) hist[v]++;
  let lo = 0;
  for (let acc = 0; lo < 255; lo++) { acc += hist[lo]; if (acc > norm.length * 0.005) break; }
  const hi = 240; // 背景除完後紙張約 240–255,一律當白
  const span = Math.max(20, hi - lo);
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    const t = Math.min(1, Math.max(0, (v - lo) / span));
    lut[v] = Math.round(255 * t ** 1.6);
  }

  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, p = 0; i < norm.length; i++, p += 4) {
    const v = lut[norm[i]];
    out[p] = v; out[p + 1] = v; out[p + 2] = v; out[p + 3] = 255;
  }
  return { data: out, width, height };
}
