# vendor/paddle

瀏覽器裡跑 PaddleOCR(文字辨識)用的檔案,由 `src/paddle.js` 載入。第一次用到時才下載,之後由 service worker 快取。

| 檔案 | 來源 | 授權 |
|---|---|---|
| `ort.wasm.min.mjs`、`ort-wasm-simd-threaded.mjs`、`ort-wasm-simd-threaded.wasm` | npm `onnxruntime-web` 1.30.0(Microsoft ONNX Runtime) | MIT,見 `LICENSE-onnxruntime.txt` |
| `ppocrv5_det.onnx`、`ppocrv5_rec.onnx`、`ppocrv5_dict.txt` | PaddleOCR PP-OCRv5 mobile(文字偵測 / 辨識,字典含繁體),ONNX 版取自 PyPI `onnxocr` 4.0.0 | Apache-2.0,見 `LICENSE-Apache-2.0.txt` |

更新時:換檔案後把 `src/version.js` 的版本號加一,重跑 `npm run test:all`。
