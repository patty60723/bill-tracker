# vendor/pdfjs

PDF 電子帳單用的 [pdf.js](https://github.com/mozilla/pdf.js)(npm `pdfjs-dist` 6.4.299,Apache-2.0,見 `LICENSE`),由 `src/pdf.js` 載入:
讀出 PDF 裡的文字(含位置)、把頁面畫成圖片讀條碼。第一次用到才下載,之後由 service worker 快取。

- `pdf.min.mjs`、`pdf.worker.min.mjs`:`legacy/build/` 裡的同名檔(legacy 版有補新語法,一般版用了 `Map.getOrInsertComputed`,很多手機瀏覽器還沒有)
- `cmaps/*.bcmap`:中文 PDF 的字元對照表(CID 字型要靠它才讀得出正確的字)
- `wasm/`:`qcms_bg.wasm`(圖片色彩)、`openjpeg.wasm`(JPEG 2000)、`jbig2.wasm`(掃描檔常用的黑白壓縮),授權見同目錄 `LICENSE_*`

更新時:換檔案後把 `src/version.js` 的版本號加一、`sw.js` 的 `VENDOR_CACHE` 改名,重跑 `npm run test:all`。
