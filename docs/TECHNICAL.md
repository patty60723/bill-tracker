# 繳費小幫手 技術文件

這份文件說明**實作方式與演算法**:架構、資料結構、掃描辨識管線、影像處理、日期與提醒計算、
通知與快取機制、測試方式,以及開發時踩過的坑。功能面的說明見 [`README.md`](../README.md)。

---

## 1. 架構總覽

- **純前端、零建置**:原生 ES modules(`<script type="module">`),沒有框架、沒有打包工具,執行時沒有 npm 相依
  (`devDependencies` 只有 Playwright 與 ESLint,給測試與 lint 用)。部署 = 把 repo 放上任何 HTTPS 靜態空間。
- **資料只在本機**:IndexedDB。沒有後端。
- **PWA**:`manifest.webmanifest` + `sw.js`(service worker,以 `type: 'module'` 註冊)。
- **第三方程式碼全部 vendor 進 repo**(`vendor/`),執行時不依賴 CDN。

```
index.html ── src/app.js(進入點:註冊頁面、全域點擊動作、啟動)
                │
                ├─ pages/  home · bills · bill-form · templates · settings   各頁 render 函式
                │     │
                ├─ ui/     router ─── 路由、離開前確認(頁面透過 registerRoutes 註冊,router 不 import 頁面)
                │          actions ── 讀資料、標記已繳、自動扣款、備份、清理
                │          notifications ── SW 註冊、權限、背景提醒、測試通知
                │          components ── 共用畫面片段     dom ── 小工具、提示列
                │
                └─ 邏輯與服務(頁面、ui 都可用):
                   db.js ─────────── IndexedDB
                   dates.js
                   schedule.js ───── 週期 / 提醒 / 自動扣款 / 月統計
                   parse.js ──────── 條碼、QR、OCR 文字 → 欄位
                   scan.js ───┬───── vendor/zxing-reader.js + .wasm
                              ├───── vendor/tesseract/(OCR,動態載入)
                              └───── enhance.js(影像增強)
                   livescan.js ───── 即時相機掃條碼(用 scan.detectCanvas)
                   notify.js ─────── 通知(也被 sw.js import)
                   stats.js ──────── 年度統計、搜尋、CSV
                   backup.js ─────── 備份提醒判斷(也被 notify.js 用)
                   ics.js ────────── 行事曆匯出
                   modal.js ──────── 對話框
sw.js ── notify.js / schedule.js / db.js / backup.js(背景提醒)
```

**模組邊界**

- `dates / schedule / parse / ics / enhance / stats / backup`:純函式、不碰 DOM,直接在 node 測試。
- `db / notify`:只用 IndexedDB 與 Notification API,可在 service worker 內執行。
- `ui/*`、`pages/*`、`app / scan / livescan / modal`:碰 DOM。
- **依賴方向**:`app → pages → ui → 邏輯模組`。`ui/router.js` 不 import 任何頁面,頁面由 `app.js`
  呼叫 `registerRoutes()` 註冊,避免循環相依。跨模組共用的可變狀態(目前網址、縮圖 URL、
  安裝提示事件)只在各自模組內修改,對外提供函式(`replaceHash()`、`revokeObjectUrls()`、`promptInstall()`)。

**日期一律用本地時區的 `YYYY-MM-DD` 字串**(`dates.js`),比較大小直接用字串比較,
避免 `Date` 在 UTC 換算時差一天。帳單月份用 `YYYY-MM`。

---

## 2. 資料層(`src/db.js`)

### Schema(資料庫 `bill-tracker`,version 2)

| store | keyPath | 內容 |
|---|---|---|
| `templates` | `id` | 固定繳費 |
| `bills` | `id`(index:`period`) | 每期帳單 |
| `files` | `id` | 照片 / PDF:`{ id, blob, name, type, createdAt }` |
| `meta` | `key` | 雜項狀態:`lastNotified: { date, keys[] }`、`lastBackupAt`、`backupSnoozeUntil`、`onboardingDismissed` |

```js
template = { id, name, category, amount, cycleMonths, anchorMonth, arrivalDay, dueDay,
             remindDays, accountNo, bankCode, active, notes, createdAt,
             autoPay, autoPayFrom /* YYYY-MM-DD 開啟日 */, autoPayDone /* YYYY-MM 處理到哪期 */ }
bill     = { id, name, templateId, category, period, cycleMonths, amount, dueDate,
             accountNo, bankCode, status: 'paid'|'unpaid', paidDate, paidMethod, notes,
             autoPaid /* 由自動扣款記成已繳 */,
             billFiles: [fileId], proofFiles: [fileId], createdAt, updatedAt }
```

- `dueDay = 31` 代表「月底」。`dueDay < arrivalDay` 代表截止日在到單的**下個月**。
- `bankCode` 同時用來放銀行代碼(3 碼)或稅單的繳款類別(5 碼)。

### 升級

`onupgradeneeded` 依 `oldVersion` 逐步建立(`< 1` 建三個 store、`< 2` 加 `meta`),舊資料不動。
`onversionchange` 時關閉連線,讓其他分頁或 service worker 可以升級。

### 檔案生命週期

- 照片進來先壓縮(`scan.compressImage`:長邊 ≤ 2560 px、JPEG q0.9,比原檔大就保留原檔;PDF 原樣存)。
- 表單加照片時**立刻**寫入 `files`(為了顯示縮圖),id 記在 `addedFiles`。
  使用者確定離開沒存的表單 → 刪掉 `addedFiles`。
- 保險機制 `collectGarbage()`:啟動時刪掉**沒被任何帳單引用、且超過 1 天**的檔案
  (例如新增到一半直接關掉 app)。
- `deleteBill` 連同 `billFiles`、`proofFiles` 一起刪。

### 備份格式

`exportAll()` → `{ app: 'bill-tracker', version: 1, exportedAt, templates, bills, files }`,
檔案的 blob 轉成 data URL。`importAll()` 會先清空三個 store 再寫入(取代,不合併)。

### 備份提醒與存檔(`src/backup.js`、`ui/actions.js` 的 `backupNow()`)

`backupStatus({ lastBackupAt, snoozeUntil, records })`(records = 帳單 + 固定繳費):

- `changes` = `max(createdAt, updatedAt) > lastBackupAt` 的筆數(從沒備份過 = 全部)。
- `due`:有資料,且
  - 從沒備份過:最早一筆資料建立已滿 3 天;或
  - `changes > 0` 且(距上次備份 ≥ 30 天,或 `changes ≥ 20` 且 ≥ 7 天)。
  - `snoozeUntil` 未到期時一律 false(「7 天後再提醒」)。
- 通知:`notify.urgentReminders()` 在 `due` 時加一個 `kind: 'backup'` 項目,去重 key 用月份,
  所以同一個月最多通知一次。

存檔用 Web Share API Level 2(`navigator.share({ files })`):

- Chrome 只允許分享特定副檔名,`.json` 不在清單內 → 依序用 `canShare()` 試 `.json`、`.txt`
  (匯入兩種都收);都不行就 `download`。
- `share()` 需要使用者手勢(transient activation);匯出含大量照片時準備檔案可能超過時限而丟
  `NotAllowedError` → 彈出對話框讓使用者再點一次「分享」。
- `AbortError`(在分享選單按取消)→ 不記錄;分享成功或已下載 → 寫入 `lastBackupAt`、清掉 snooze。
  分享成功不代表使用者真的存到了雲端,只能在提示文字中提醒。
- 匯入:`describeBackup()` 驗證 `app === 'bill-tracker'` 並統計內容,確認對話框列出備份時間、
  筆數與目前會被清掉的筆數;匯入成功後把 `lastBackupAt` 設成備份檔的 `exportedAt`。

---

## 3. 畫面與路由(`src/app.js`、`src/ui/`、`src/pages/`)

### Hash router

`location.hash` → `ui/router.js` 的 `render()`,依路徑第一段查 `registerRoutes()` 註冊的表
(`app.js` 註冊;查不到就是首頁):

| hash | 頁面 |
|---|---|
| `#/` | 首頁(提醒、本月統計) |
| `#/bills?month=…&filter=…&q=…`(month:`YYYY-MM` 或 `all`;filter:`all` / `paid` / `unpaid`;q:搜尋字) | 紀錄 |
| `#/bills?view=stats&year=YYYY` | 統計 |
| `#/bill/new?template=&period=&scan=1`、`#/bill/:id` | 帳單表單 |
| `#/templates`、`#/template/new`、`#/template/:id` | 固定繳費 |
| `#/settings` | 設定 |

每頁都是 `view.innerHTML = 模板字串` 再綁事件;動態文字一律經 `esc()` 轉義。
每次 render 前會 `revokeObjectUrls()` 釋放上一頁產生的縮圖 URL。
畫面上的共用動作(標記已繳、複製帳號、立即備份、開啟通知、安裝 app…)用 `data-*` 屬性標記,
由 `app.js` 在 `#view` 上做一次事件委派處理。

### 離開前確認(leave guard)

表單頁呼叫 `guardForm()` 設定全域 `leaveGuard = { isDirty, onLeave }`;`input`/`change` 事件、
掃描帶入、加減照片都會標記 dirty。儲存或刪除成功後 `release()`。離開的路徑有三種,處理方式不同:

1. **點連結 / 下方分頁**:`document` 上的 capture-phase click 監聽,在瀏覽器換頁**之前**
   `preventDefault()`,問完再 `go()`。這樣使用者選「繼續編輯」時不會多出一筆瀏覽紀錄。
2. **程式換頁**(例如表單的「取消」):走 `navigate(hash)`,一樣先問。
3. **手機返回鍵 / 返回手勢**:網址已經變了,只能在 `hashchange` 裡先用
   `history.replaceState` 把網址改回原頁(不會觸發 hashchange、不會重繪,資料不動),
   再非同步問;確定離開才把 `location.hash` 設回目標。`askingLeave` 旗標避免重複跳窗。

重新整理 / 關閉分頁只能用 `beforeunload`,瀏覽器只會顯示它自己的提示。

### 對話框(`src/modal.js`)

`ask({ title, message, actions, cancelValue })` 回傳 Promise,用 `<dialog>.showModal()`。
Esc(`cancel` 事件)或點 backdrop(click 的 target 是 dialog 本身)都回傳 `cancelValue`;
預設焦點放在「安全」的按鈕上。`confirmDialog`、`alertDialog`、`copyDialog` 是包裝。

### 提示列(toast)

`toast(msg, action?)`:有動作按鈕(例如「復原」)時停留 6 秒、可點,否則 2.4 秒。
### 標記已繳 → 上傳證明

`markPaid(id)`:先寫入已繳並重繪,再開 `ask()` 對話框(📷 拍照上傳 / 🖼️ 選照片或 PDF / 之後再說 / 復原)。
選上傳時用動態建立的 `<input type=file>`(拍照:`accept=image/*` + `capture=environment`;
選檔:`image/*,application/pdf` + `multiple`)並 `click()`——對話框按鈕的點擊提供了開檔案選擇器所需的
使用者手勢(transient activation 在 await 之後仍有效)。使用者取消選擇器時靠 `cancel` 事件回傳空陣列。
檔案壓縮後存進 `files`,id 附加到帳單的 `proofFiles`(重新讀一次帳單再寫,避免蓋掉期間的變更)。
復原是把標記前的整筆物件 `put` 回去。

### 紀錄頁的搜尋

搜尋框輸入時只重畫下方的 `#bills-body`(整頁重畫會讓輸入框失去焦點、手機鍵盤收起),
並用 `history.replaceState` 把 `q` 寫進網址(不產生瀏覽紀錄),點進帳單再返回時搜尋字還在。
同時更新 `currentHash`,避免離開前確認把網址改回舊的。

### 新手引導

- 狀態存在 `meta.onboardingDismissed`;設定頁可以設回 `false`。
- 三個步驟的「完成」都是即時判斷,不另外存:
  - 已安裝:`matchMedia('(display-mode: standalone)')` 或 iOS 的 `navigator.standalone`。
  - 通知:`Notification.permission === 'granted'`。
  - 建立第一筆:有任何固定繳費或帳單。
- Android Chrome 判定可安裝時會發 `beforeinstallprompt`:`preventDefault()` 後存起來,首頁顯示
  「安裝 app」按鈕,點擊時呼叫 `prompt()`(每個事件只能用一次,用完清掉)。沒有這個事件時
  (iOS、已安裝、或 Chrome 還沒判定)改顯示文字步驟,依 user agent 區分 iPhone / Android。

---

## 4. 掃描管線

```
照片(拍照 / 相簿)──┬─► 條碼:BarcodeDetector + zxing ──► 條碼文字[]
                    │       整張(≤ 4096 px)→ 不夠再由下往上切橫條
                    │
                    └─► OCR(只在條碼不夠時):
                            增強影像 PSM 3 → 增強影像 PSM 11 → 原圖 PSM 3
                            每輪後檢查 scanComplete(),夠了就停
                                        │
即時相機 ── 每 200 ms 一格 ── detectCanvas ─┘
                                        ▼
                     mergeScan(條碼[], OCR文字[]) ── parse.js
                                        ▼
                     applyScan():fill() 寫入欄位並記住原值
```

### 掃描狀態與多次掃描(`pages/bill-form.js`)

```js
scan = { barcodes: Set, texts: [], errors: [], size,
         photos: [fileId],        // 這次掃描加的照片
         before: { field: 原值 },   // 被掃描改寫前的值
         filled: { field: 寫入值 } } // 掃描寫入的值
```

- 同一張帳單的多次掃描(拍照 + 對準條碼掃、正反面)會**累加** barcodes / texts 再一起 `mergeScan`。
- 已經掃過時再掃,先問「另一張帳單 / 同一張的另一頁」。選另一張 → `resetScan()`:
  欄位若仍等於 `filled` 的值就還原成 `before`(使用者之後手動改過的保留)、刪掉 `photos`、清空狀態。
  > 這是為了修一個真實 bug:稅單 QR Code 留在 barcodes 裡,因為優先權最高,之後掃什麼都被它蓋過。

### 讀條碼(`scan.readBarcodes`)

1. `createImageBitmap(file, { imageOrientation: 'from-image' })`(套用 EXIF 方向),
   畫到 canvas,長邊上限 4096 px。**不先縮小**:實驗顯示 Code 39 窄線寬在原圖約 2 px 時,
   縮到 2400 px(線寬 ~1.2 px)就讀不到。
2. `detectCanvas()`:先用瀏覽器內建 `BarcodeDetector`(Android Chrome 有,底層是 ML Kit),
   再用 zxing-wasm(`tryHarder`、`tryRotate`、最多 12 個符號),結果聯集。錯誤收集起來顯示在「辨識細節」。
3. **放大條碼欄**:讀到長度像三段式條碼一段的條碼(8–20 碼,**讀錯幾碼也算**,位置還是對的)、
   但 `isEnough()`(由呼叫端提供:讀到截止日 + 金額)還不滿足時,用它的位置(BarcodeDetector 的
   `boundingBox`、zxing 的 `position`)推算整欄:u = 換算成 16 碼時的條碼寬度,欄寬 1.2u、
   上下各延伸 0.6u。短的那段(第一段 9 碼)不知道各段怎麼對齊,靠左/置中/靠右三種都試。
   這一欄再切成高度 = 條碼高 × 2.5、間隔條碼高 × 1.25 的**細橫條**,各放大 2 倍掃,夠了就停。
   最多放大 5 欄,重疊的不重掃。
4. 還不夠時,把照片切成高度 H/3、重疊 1/2 的橫條,**從下往上**逐條掃(條碼通常在帳單下方),
   橫條也放大 2 倍;橫條裡讀到新線索,一樣放大那一欄。
5. 回傳時 zxing 讀到的排前面:Android 內建偵測實測會讀錯幾碼(`092057000004504` → `0920570004504`),
   同一段有兩個版本時以 zxing 為準。辨識細節列出每個條碼是哪個引擎讀到的、各引擎的次數與耗時。
6. zxing 在 `vendor/zxing-reader.js`(IIFE build),wasm 路徑用 `setZXingModuleOverrides({ locateFile })`
   指向 `vendor/zxing_reader.wasm`。

實驗結論(合成 3024×4032 照片、模糊 1 px、旋轉 2°):窄線 ≥ 3 px 都讀得到;≤ 2 px 時不論放大、
裁切、換 binarizer(LocalAverage / GlobalHistogram)都救不回來 → 因此提供「對準條碼掃」。
真實帳單照片(2268×4032,社區管理費)另外測過:照片縮到 80%、65% 時整張掃讀不齊/讀不到,
加上放大條碼欄、放大橫條後三段都讀得到;縮到 50% 只剩第一段,40% 讀不到。
另一張(2270×4032,紙張彎曲、條碼很矮)整張掃 zxing 一段都讀不到,把三段條碼各自緊緊切出來卻讀得到:
同一列左邊的文字、表格裡的小條碼會干擾,大圖上掃描列又太稀。整張垂直模糊、細長全寬橫條、
1/2 × 1/8 方格都不行;以第一段位置推算的欄切細橫條放大 2 倍可以穩定讀到第一、三段(約 0.4–1 秒)。

**代收截止日**:台電等帳單的條碼第一段是「代收截止日」(超商最後收單日,例如 11/06),
比帳單上的「繳費期限」(10/01,之後第 8 天起加計遲付費用)晚。條碼有日期、文字辨識也找到
比它早 60 天內的截止日,而且帳單上有「代收截止」字樣時,截止日改用繳費期限,
條碼日期記成 `collectCutoff` 寫進備註。台電第三段印成 `00000-000002219`(第 5–6 碼含「-」),格式也接受。

**條碼下方數字**:條碼都沒讀到時,`mergeScan` 會在 OCR 文字裡找單獨成一行、符合第一段
(`\d{6}[0-9A-Z]{3}`)或第三段(`\d{4}[0-9A-Z]{2}\d{9}`)格式的字串(印在條碼下方的人眼可讀字),
用同一套 `parseConvenienceBarcodes` 解析,來源標成 `printed`。截止日在文字辨識沒有找到
(或只是推測)時採用;金額因為 15 碼數字也可能是別的號碼,只有跟文字辨識的金額一致、
或前 4 碼是近期年月時才採用。

### 即時掃描(`src/livescan.js`)

`getUserMedia({ facingMode: 'environment', 1920×1080 ideal })`,每 200 ms(扣掉處理時間)把影格畫到
canvas 呼叫 `detectCanvas()`;讀到新條碼就震動、更新清單(✅ 截止日 / ✅ 金額),
`isEnough` 滿足後停 0.5 秒讓使用者看到打勾再自動關閉。關閉時一定 `track.stop()`。

### OCR(`scan.readText`)

- Tesseract.js 5.1.1,語言 `chi_tra+eng`,OEM 1(LSTM only)。`workerPath`、`corePath`、`langPath`
  全指向 `vendor/tesseract/`(core 有 SIMD 與非 SIMD 兩版,由 tesseract.js 自動挑)。
  辨識資料用 `4.0.0_best_int`(chi_tra 1.6 MB + eng 2.9 MB,gzip)。
- 影像先縮到長邊 2200 px,再做增強(見第 6 節)。
- 依序嘗試 `[增強, PSM 3]`、`[增強, PSM 11]`、`[原圖, PSM 3]`,每輪後 `isEnough(texts)`
  (= `scanComplete(mergeScan(...))`:有金額、有截止日且不是推測的)。
  - PSM 3 = 自動版面分析;PSM 11 = sparse text,表格式帳單(值在表頭下一列)讀得比較好。
  - **注意**:tesseract.js 預設是 PSM 6(single block),實測對表格最差,所以一定要明確設定。

---

## 5. 解析演算法(`src/parse.js`)

### 5.1 超商三段式條碼(Code 39)

| 段 | 長度 | 格式 | 用途 |
|---|---|---|---|
| 1 | 9 | `YYMMDD` + 代收項目 3 碼 | 代收期限 → 截止日 |
| 2 | 16 | 業者自訂 | 銷帳編號(只記錄,不填欄位) |
| 3 | 15 | 4 碼 + 檢查碼 2 碼 + 金額 9 碼 | 金額;前 4 碼若是民國 YYMM 就當帳單月份 |

以 regex 依長度/型態辨認:`^\d{6}[0-9A-Z]{3}$`、`^\d{4}[0-9A-Z]{2}\d{9}$`、`^[0-9A-Z]{16}$`。

**兩碼年份的歧義**:規格寫民國年末兩碼,但實務上也有用西元年末兩碼的。`twoDigitYearDate(yy, mm, dd)`
同時產生 `2011 + yy`(民國 1yy 年)與 `2000 + yy`(西元)兩個候選,丟掉不存在的日期和離今天
超過 400 天的,取離今天最近的。2011–2099 年間兩者相差 11 年,不會同時落在 ±400 天內,所以沒有真正的衝突。

第三段的前 4 碼各家不同(民國 YYMM 或 MMDD),所以**金額不依賴前 4 碼是否合法**;
只有能解讀成近期(±120 天)的民國年月時才當帳單月份。

### 5.2 稅單 QR Code(全國繳稅網)

`https://paytax.nat.gov.tw/QRCODE.aspx?par=<數字>`,`par` 的前 37 碼:

| 位置 | 長度 | 欄位 |
|---|---|---|
| 0–4 | 5 | 繳款類別 → `bankCode` |
| 5–20 | 16 | 銷帳編號 → `accountNo` |
| 21–30 | 10 | 繳款金額 |
| 31–36 | 6 | 繳納截止日(民國 YYMMDD) |

這是從一張真實地價稅單反推、並與單上印的四個欄位逐一核對的格式;後面其餘位數未使用。
稅單 QR 存在時優先於其他條碼與 OCR(OCR 曾把銷帳編號看錯一位)。

**寬限 3 日**:稅單註明「繳納截止日為繳納(展延)期間屆滿後 3 日」。`mergeScan` 偵測到稅單
(有 paytax QR,或 OCR 文字含 `屆滿後3日`)且截止日不是推測時:`taxCutoff = 截止日`、
`dueDate = 截止日 − 3 天`。從條碼日期往回推,遇到假日展延也自然正確
(範例:11/30 是週日 → 展延到 12/1 → 條碼是 12/4 → 推回 12/1)。

### 5.3 OCR 文字正規化

`normalizeOcrText()`:

1. `NFKC`:全形數字/符號轉半形。
2. `〇` → `0`。
3. **刪除中文字之間的空白**:`([CJK])[ \t]+(?=[CJK])` → `$1`。
   > Tesseract `chi_tra` 會在每個中文字之間插空白(「繳 費 期 限」),不處理的話所有關鍵字都比對不到。
   > 這是早期「截止日完全辨識不到」的根本原因。
4. 數字中間的 `O/o` → `0`、`l/I` → `1`(只在前後是數字或日期分隔符時)。

接著依行切開、壓縮空白、去掉空行。

### 5.4 關鍵字比對(排名 + 容錯)

`DUE_KEYWORDS`、`AMOUNT_KEYWORDS`、`ACCOUNT_KEYWORDS` 都依**可靠度**排序。`matchers()` 把每個關鍵字
展開成:

- 精確比對,`rank = i × 2`
- 「錯一個字」比對,`rank = i × 2 + 1`:把第 j 個字換成 `[^\s\d]`,n 個字就 n 種變體 OR 起來。
  只對 ≥ 4 字、且含「期限 / 截止 / 金額」的關鍵字開放,避免「收費日期」被當成「繳費日期」。

例:「應 弧 金 額」(繳 被看成 弧)→ 命中 `應繳金額` 的容錯版本。

`regionsAfter(lines, matcher)`:每個命中位置取「同一行關鍵字之後的文字 + 後面兩行」。
往下看兩行是因為表格式帳單的值在表頭下一列,而 OCR 有時會在中間插一行雜訊。

### 5.5 截止日

1. 依 matcher 排名逐一嘗試;在 region 裡找所有完整日期(`allDates`):
   - `(\d{3,4})[/.-](\d{1,2})[/.-](\d{1,2})`、`(\d{3,4})年(\d{1,2})月(\d{1,2})日`
   - 年份限 3 碼(民國)或 4 碼(西元),避免把 `15~115/09/14` 這種片段湊成日期;< 1911 視為民國。
   - 過濾離今天超過 400 天的。
   - **取最晚的**:關鍵字附近常同時有計費期間、出帳日,截止日幾乎總是最晚的那個。
   - region 在下一個截止日關鍵字出現的地方截斷:台電寫「繳費期限 10/01 … 代收截止日 11/06」,
     不截斷的話「取最晚」會拿到代收截止日。
2. region 裡沒有完整日期時改用 `looseDates`(只在截止日關鍵字後面才用,避免誤判):
   - 沒寫年份:`10月31日`、`10/31` → 在去年/今年/明年中取離今天最近的。
   - 擠成一串:7 碼民國 `1151031`、8 碼西元 `20261031`、6 碼 `141204`(用 `twoDigitYearDate`)。
3. 都沒有 → **推測**:全文中落在 [今天 − 60 天, 今天 + 150 天] 的日期取最晚的,
   標記 `dueDateGuessed`,畫面上顯示「推測」。

### 5.5.1 帳單月份、週期、機構

- 帳單月份:先找帳單標題「115 年 09 月 繳費通知單」或「繳費月份 115年09月」;「115年09-10月管理費」這種範圍
  同時給出週期。含「發票 / 發栗(OCR 誤認)/ 載具」的行不看,表頭沒有數字時下一行也跳過
  (台電「發票期別 115年07-08月」曾被當成帳單月份)。
- 週期:沒有範圍寫法時,帳單上有「計費期間 / 用電期間 / 抄表」字樣才看「日期 至 日期」的天數:
  25–35 天 → 每月,55–66 天 → 雙月。稅單的「繳納期間 11/01 至 11/30」因此不會被當成每月。
- 機構:台電、自來水、中華電信、台灣大哥大、遠傳、瓦斯、管委會 → 名稱與類別,
  只在名稱還空著、類別還是「其他」時帶入。
- 代收截止日:「代收截止」後面最靠近的日期;比截止日晚才保留,寫進備註。

### 5.6 金額

在 region 中先刪掉日期字串,再抓 `(NT$|$|新臺幣)? 數字(含千分位)(.小數)? (元)?`;
抓之前先修正 OCR 看錯的千分位:`2,.219`、`2.219`(小數點後剛好 3 位)→ `2,219`。
丟掉 < 10 的(個位數多半是雜訊),**有貨幣標記的優先**,否則取第一個。
含「最低 / 已繳 / 上期 / 前期 / 預繳 / 折抵 / 手續費」的行整行跳過。
`應繳費用` 排在最後,因為它常是明細表的表頭(底下第一個數字是其中一項費用,不是總額)。

**跨多次 OCR 合併**:每次結果帶 `amountRank`(找到它的 matcher 排名),
`mergeScan` 取 rank 最小的,而不是第一次找到的;rank 一樣時取在所有 OCR 文字裡出現最多次的數字。
> 真實案例:第一輪只讀到「應繳費用」表頭 → 3,304(明細第一項);第二輪讀到「應繳金額」→ 4,504。

### 5.7 繳費帳號、銀行代碼、帳單月份

- 帳號 regex:`\d{4}([ -]\d{4}){1,2}([ -]\d{1,4})?` 或連續 `\d{10,16}`,前後不能接數字或 `-`。
  `(822)` 這種括號內的銀行代碼先移除,免得黏成一串。含「扣款帳號 / 扣繳帳號 / 約定帳號」的行跳過
  (那是付款方帳戶)。
- 銀行代碼:先找 `銀行代碼 822` 這類寫法;再找「代碼 / 代號」之後(可隔兩行)單獨的 3 位數;
  稅單則找「繳款類別」之後的 5 位數。
- 帳單月份:`(\d{3,4})年(\d{1,2})[-~至到](\d{1,2})月` → `period = 起始月`、
  `cycleMonths = 月數`(只接受 2 / 3 / 6 / 12)。

### 5.8 合併(`mergeScan`)

```
結果 = { ...OCR 結果, ...條碼結果, source: { amount, dueDate } }   // 條碼覆蓋 OCR
source.dueDate ∈ 'barcode' | 'ocr' | 'guess' | null
```

OCR 端:金額取 rank 最小;帳號取第一個;銀行代碼必須跟帳號來自同一次 OCR;
截止日「有關鍵字的」優先於「推測的」。最後套用稅單寬限規則(5.2)。

### 5.9 套用到表單(`applyScan`)

- 用 `fill(name, value)` 寫入,同時記錄 `before` / `filled`(供 `resetScan` 還原)。
- 帳號只在欄位空白時才填(不覆蓋固定繳費帶入的帳號)。
- 帳單上沒寫月份、但截止日跟目前選的帳單月份差超過 1 個月 → 帳單月份改成截止日那個月,並在結果中提示。

---

## 6. 文件影像增強(`src/enhance.js`)

Tesseract 內部用**單一全域門檻**二值化,遇到半邊陰影、色塊底的表格、淡灰字就會整塊吃掉文字。
增強的目標:讓紙張(不論多暗、什麼顏色)變成純白,文字變成深色。

輸入 / 輸出都是 `{ data: RGBA, width, height }`,純計算,瀏覽器與 node 共用。

### 步驟

1. **灰階**:`g = (77R + 150G + 29B) >> 8`。
2. **估計紙張背景**:形態學**閉運算**(closing),在**半解析度**上做。
   - 2×2 平均降採樣。
   - `max` 濾波(膨脹,dilation):半徑 r = 6(半解析度下視窗 13 px ≈ 原圖 26 px),
     比視窗細的深色筆畫被周圍的亮紙蓋掉。
   - `min` 濾波(侵蝕,erosion):同半徑,把大面積明暗區域(色塊、陰影)的**邊界還原到原位**。
   - 兩者都做成可分離的一維濾波(水平再垂直),寫成平鋪迴圈(不用 closure),複雜度 O(N·r)。
3. **除以背景**:`norm = min(255, g × 255 / max(8, bg))`,`bg` 用雙線性內插回原解析度。
   紙張 → ~255,文字保留相對於當地背景的對比。
4. **對比拉伸**:
   - `lo` = 最暗 0.5% 像素的值;`hi` = 240(除完後紙張約 240–255,一律視為白)。
   - `t = clamp((v − lo) / max(20, hi − lo))`,`out = 255 × t^1.6`(gamma 讓筆畫更飽滿)。
   - 用 256 格查表(LUT)套用。

### 為什麼不用其他做法

| 做法 | 問題 |
|---|---|
| 每 16×16 格取第 90 百分位 + 鄰格最大值 + 平滑 | 色塊邊緣被平滑抹開,產生一圈灰色光暈,Tesseract 會當成線條;實測讓一個欄位讀丟 |
| 只拉全域對比 | 解決不了陰影與色塊 |
| 局部二值化(Sauvola 等) | 實作與參數成本高,且輸出黑白後 Tesseract 失去灰階資訊;目前的結果已足夠 |

閉運算的關鍵優點是**保邊**:大面積區域的邊界不會被模糊。

### 量測

合成 5 張困難帳單(半邊陰影、色塊底、低對比、偏暗、全部混合;2400×1700、模糊 1.2 px、JPEG 0.85),
每張要讀出截止日、金額、帳號 3 個欄位:

| | 讀對欄位 |
|---|---|
| 原圖 | 13 / 15 |
| 增強後 | **15 / 15**(色塊底那張 1/3 → 3/3,其他無退步) |

速度(node,2400×1700):closure 版約 1.1–1.5 s,改成平鋪迴圈後 0.3–0.5 s。手機上未量測。

---

## 7. 週期與提醒(`src/schedule.js`)

### 週期

- `occursIn(t, year, month)`:`((month − anchorMonth) mod cycleMonths + cycleMonths) mod cycleMonths === 0`。
- `periodDates(t, 'YYYY-MM')`:`arrival = 該月 arrivalDay`;
  `due = (dueDay ≥ arrivalDay ? 同月 : 下個月) 的 dueDay`。日期超過該月天數就取月底(`clampedDate`)。
- `nextPeriod(t, from)`:從上個月起往後找第一個 `due ≥ from` 的期別(上個月的單可能下個月才截止)。

### 提醒清單 `buildReminders(templates, bills, today)`

**固定繳費、這期還沒登記帳單**(檢查今天前 2 個月到後 1 個月的期別;建立日期之前就截止的期別略過):

| 條件 | kind | level |
|---|---|---|
| 到單前 ≤ 3 天 | `collect-soon` | info |
| 已到單、未過截止,剩餘天數 > remindDays | `collect` | warn |
| 已到單、剩餘天數 ≤ remindDays | `collect` | danger |
| 已過截止 ≤ 31 天 | `missing` | danger |

**已登記、未繳的帳單**:逾期 → `overdue`(danger);≤ remindDays → `due-soon`(warn);其他 → `unpaid`(info)。

排序:level(danger → warn → info),再依日期。

**自動扣款**的固定繳費(`autoPay`)不產生上面這些「拿單/沒登記」提醒;它的未繳帳單一律是
`autopay`(info,「M/D 自動扣款」)。

### 自動扣款 `planAutoPay(templates, bills, today)`

純函式,回傳要做的事,由 `ui/actions.js` 的 `runAutoPay()` 寫入資料庫(app 啟動時、儲存固定繳費後、
從帳單建立固定繳費後各跑一次):

```
for 每個 active && autoPay 的 template:
  起點 = autoPayDone 的下一個月;沒有的話 = (autoPayFrom 或 createdAt) 的前 2 個月
  依月份往後走(最多 36 個月,不超過本月),只看 occursIn 的期別:
    effectiveDue = 該期已有帳單的 dueDate ?? periodDates().due
    effectiveDue > today → 停(之後的期別只會更晚)
    autoPayDone = 這期
    effectiveDue < (autoPayFrom 或建立日) → 跳過(開啟前就截止的不補)
    已有帳單且未繳 → markPaid(paidDate = effectiveDue)
    沒有帳單      → create(已繳、paidMethod '自動扣繳'、autoPaid、金額 = 預估金額)
  autoPayDone 有前進 → templateUpdates
```

- **`autoPayDone` 水位線**讓處理具有冪等性:重開 app 不會重複建立;使用者刪掉自動建立的紀錄後也不會再冒出來。
- **`autoPayFrom`**:在表單把 `autoPay` 從關變開時設成今天並清空 `autoPayDone`,
  避免對建立很久的項目一開就補出好幾個月的「已繳」。
- 以帳單自己的 `dueDate` 為準(掃描讀到的實際扣款日可能跟固定繳費設定差一兩天)。

### 從帳單推固定繳費的預設日 `suggestTemplateDays(period, dueDate, today)`

- `dueDay` = 截止日的日(≥ 29 視為月底 31)。
- `arrivalDay` = 今天(若帳單月份就是本月,最多 28)否則 1。
- 截止日在帳單月份當月:若 `arrivalDay > dueDay` 改成 1。
- 截止日在下個月:`arrivalDay` 必須 > `dueDay`(才代表「隔月截止」),否則取 `max(dueDay + 1, 20)`(上限 28)。
- 單元測試驗證:推出的設定能用 `periodDates` 還原出原本的截止日。

---

## 8. 統計、搜尋、CSV(`src/stats.js`)

### 年度統計 `yearStats(bills, year, throughMonth)`

- 以**帳單月份**(`period`)歸年,和月統計一致(不是用繳費日期或截止日)。
- `byMonth`:12 格的總額、已繳、筆數;`byCategory`:依金額排序,含筆數。
- **跟去年比較用同期**:`throughMonth` = 今年的本月(過去年份 = 12),今年與去年都只加總
  1 月 ~ `throughMonth` 月(`compareTotal` vs `prevTotal`),`change = (compareTotal − prevTotal) / prevTotal`。
  > 若直接拿今年 1–10 月比去年全年,會系統性地顯示「比去年少」。
- `monthlyAvg` = 總額 ÷ 有帳單的月數(不是 ÷ 12,避免年初的平均被低估)。
- 金額空白當 0 計入筆數。

### 長條圖

純 HTML/CSS(沒有圖表函式庫):12 欄 grid,欄距 2 px;長條高度 = 該月 / 全年最大月 × 100%,
有金額的月份至少 3% 讓它看得到;上緣 4 px 圓角、貼齊底線;只在最高的那個月標數字,其他月份點長條
後在下方顯示明細(金額、已繳、筆數、「看這個月」連結),點選時其他長條變淡。單一系列只用主色,
已繳/未繳不用顏色區分(以文字呈現)。每根長條是 `<button>` 並有 `aria-label`(月份 + 金額)。

### 搜尋 `matchBill(bill, query, categoryLabel)`

空白切成多個關鍵字,**每一個**都要出現在下列欄位串起來的字串中(不分大小寫):名稱、備註、帳號、代碼、
金額(同時放 `1286` 與 `1,286` 兩種寫法)、類別名稱、帳單月份、繳費方式。關鍵字開頭的 `$` 會被忽略。

### CSV `billsToCSV(bills, categoryLabel)`

- 開頭加 UTF-8 BOM、換行用 CRLF:Excel(特別是 Windows 繁中版)直接雙擊開啟才不會亂碼。
- 欄位含 `"`、`,`、換行時用雙引號包起來,內部 `"` 變 `""`(RFC 4180)。
- **8 位以上的純數字**(帳號、銷帳編號)輸出成 `="0012…"`:否則 Excel 會轉成科學記號並吃掉開頭的 0。
- 依帳單月份、截止日排序;欄位:帳單月份、名稱、類別、金額、截止日、狀態、繳費日期、繳費方式、
  帳單週期、代碼、帳號/銷帳編號、照片數、證明數、備註。

---

## 9. 通知(`src/notify.js`、`sw.js`)

- `urgentReminders()`:`buildReminders` 中 level 不是 info 的。
- `notifyReminders(registration, { force, background })`:
  - 背景觸發時只在 8:00–22:00 發。
  - 去重:`meta.lastNotified = { date, keys }`,key 是 `kind:billId|templateId:period`。
    同一天只有出現**新的** key 時才再通知;換日重置。
  - `registration.showNotification()`(頁面與 SW 共用,所以不用 `new Notification`)。
- **背景定期提醒**:Periodic Background Sync(只有 Android Chrome、且 app 已安裝)。
  權限 `periodic-background-sync` 為 granted 時 `reg.periodicSync.register('bill-reminders',
  { minInterval: 6h })`;實際頻率由瀏覽器依使用程度決定(約一天一次)。SW 的 `periodicsync` 事件呼叫
  `notifyReminders(self.registration, { background: true })`。
- **SW 以 module 註冊**(`type: 'module'`),才能 `import` 共用的 notify / schedule / db。
- **測試通知**:點擊當下 `Notification.requestPermission()`(在使用者手勢內)→ `showNotification`(tag
  `bill-test`)→ 1 秒後 `getNotifications({ tag })` 確認有沒有真的顯示,結果寫在按鈕下方。
- **圖示**:Android 通知與 WebAPK 安裝都需要 PNG(SVG 不行):`icon-192/512.png`、`icon-maskable-512.png`
  (內容縮到 80% 安全區)、`badge-96.png`(單色,Android 只看 alpha)。

---

## 10. 行事曆匯出(`src/ics.js`)

每個啟用中的固定繳費產生兩個重複事件(全天):

- 到單:`DTSTART = 下一期到單日`、`RRULE:FREQ=MONTHLY;INTERVAL=cycleMonths;BYMONTHDAY=d`。
- 截止:同上,用截止日。
- `d ≥ 29` 時用 `BYMONTHDAY=-1`(月底),否則短月份會被跳過。
- 全天事件的 `TRIGGER` 以當天 00:00 為基準:`PT9H` = 當天 9 點;
  `-P{n−1}DT15H` = n 天前的 9 點(n = remindDays,0 時省略)。
- `UID = <templateId>-collect|due@bill-tracker`,重新匯入會更新而不是重複。
- 文字依 RFC 5545 轉義 `\ ; ,` 與換行,行尾 CRLF。

---

## 11. Service worker 與快取(`sw.js`)

- `install`:把 app shell(HTML/CSS/JS/圖示/zxing)用 `cache: 'reload'` 預先快取,`skipWaiting()`。
- `activate`:刪掉其他版本的 cache,`clients.claim()`。
- `fetch`(同源 GET):**network-first**,成功就更新快取,失敗才用快取 → 有網路時永遠是新版,
  離線時可用。`vendor/tesseract/`(約 12 MB)不預先下載,第一次 OCR 時經由這裡順便快取。
  - app 檔案用 `cache: 'no-cache'` 抓(每次跟伺服器確認,沒變只回 304)。GitHub Pages 回
    `Cache-Control: max-age=600`,沒加的話推上去後 10 分鐘內手機可能拿到舊檔,甚至新舊模組混用
    (真實案例:測新功能時其實還在跑舊版)。`vendor/` 不會變,照一般 HTTP 快取。
  - 導覽請求(`mode: 'navigate'`)不能帶 init 重建 Request,改用 `fetch(url, init)`。
- 註冊時 `updateViaCache: 'none'`:檢查 `sw.js` 與它 import 的模組有沒有更新時不經 HTTP 快取。
- 開著 app 時新版接手(`controllerchange`)→ toast「已下載新版本 · 重新整理」;畫面上跑的仍是舊程式,
  不自動重新整理,免得打斷正在填的表單。
- **改任何前端檔案都要把 `src/version.js` 的 `VERSION` 加一**:快取名稱是 `bill-tracker-${VERSION}`,
  瀏覽器偵測到 `sw.js` 或它 import 的檔案改變時重新 install,整批換新離線快取。
  設定頁最下面顯示版本號,測試前可以先確認手機上是不是新版。
- `notificationclick`:聚焦已開啟的視窗,沒有就開新視窗。

---

## 12. 測試

### 單元測試(`npm test`)

`node --test tests/*.test.mjs`,不需安裝套件。涵蓋:三段式條碼(民國/西元年、MMDD)、稅單 QR、
OCR 文字(含 Tesseract 真實輸出的空白、表格、雜訊行、錯字、全形)、日期寬鬆格式、帳號與銀行代碼、
稅單寬限、跨 OCR 合併、週期、提醒、自動扣款、月統計、年度統計與同期比較、搜尋、CSV 跳脫、備份提醒、ICS、
影像增強(用合成像素驗證紙張變白、文字保持深色)。

`tests/fixtures/*.txt` 是真實帳單的 OCR 輸出,姓名、地址、帳號、銷帳編號都換成假的(格式不變)。

### 端對端測試(`npm run test:e2e`,`tests/e2e/`)

`node:test` + Playwright(版本鎖在 1.56.1,配合下載的 Chromium),16 個案例、3 個檔案:

| 檔案 | 涵蓋 |
|---|---|
| `scan.e2e.mjs` | Code 39 照片、稅單 QR(寬限 3 日、備註、帳單月份)、表格式帳單 OCR、色塊底帳單(影像增強)、同一表單掃兩張、假相機即時掃描 |
| `forms.e2e.mjs` | 四種離開方式的確認(含「繼續編輯」後返回鍵仍有效)、儲存不被攔、重複帳單提醒、刪除、固定繳費表單、所有帳單檢視 |
| `features.e2e.mjs` | 自動扣款、標記已繳 → 上傳證明 / 復原 / 之後再說、統計與同期比較、搜尋、CSV、備份(提醒、下載、分享含再點一次與取消、延後、匯入摘要、錯誤檔案)、新手引導、測試通知、ICS |

`helpers.mjs` 的作法:

- **靜態伺服器**:node `http` 寫的(不需要 Python),隨機 port,`Cache-Control: no-store`。
- **固定時鐘**:`page.clock.setFixedTime('2026-10-07T10:00')`,日期相關的斷言(逾期天數、同期比較、
  自動扣款期別)不會隨真實日期改變;計時器照常運作。
- **資料種子**:在同源的 `manifest.webmanifest` 頁面上直接寫 IndexedDB,再開 app。
- **不准出現原生對話框**:任何 `confirm/alert/prompt` 都會被記成錯誤,每個案例最後檢查錯誤清單為空
  (同時收集 pageerror 與同源 4xx/5xx)。
- **合成帳單**:在頁面 canvas 上依 `n/w` 窄寬表畫 Code 39;稅單 QR、表格帳單、色塊帳單用
  `tests/fixtures/images/` 的合成圖片(假號碼)。
- **假相機**:在頁面 canvas 畫影格、取 RGBA,在 node 端手動換算 I420 寫成 Y4M,用
  `--use-fake-device-for-media-stream --use-file-for-fake-video-capture=…` 餵給 `getUserMedia`。
- **通知**:`grantPermissions(['notifications'])` 後用 `getNotifications()` 確認;要測「還沒允許」的流程時,
  用 `addInitScript` 覆寫 `Notification.permission` 與 `requestPermission`。
- **分享 / 安裝**:覆寫 `navigator.canShare / share`、手動 dispatch `beforeinstallprompt`。

### Lint(`npm run lint`)

ESLint 9 flat config(`eslint.config.js`),只開 `recommended`(未定義 / 未使用變數、重複宣告…),不管排版。

### CI

`.github/workflows/test.yml`:每次 push / PR 依序跑 lint → 單元測試 → 安裝 Chromium → 端對端測試。

### 其他自動檢查

單元測試裡有一個案例確認 `sw.js` 的離線快取清單包含 `src/` 下所有 JS 檔
(新增模組忘了加,離線時整個 app 會載入失敗)。

### OCR 基準(開發時手動)

node 端用 `tesseract.js` + `sharp`,對同一組合成困難帳單比較原圖 / 增強後的欄位正確數(見第 6 節)。

---

## 13. 踩過的坑

| 問題 | 原因 | 解法 |
|---|---|---|
| OCR 有文字但截止日、金額都抓不到 | Tesseract `chi_tra` 在中文字之間插空白 | 正規化時刪除 CJK 之間的空白(5.3) |
| 表格式帳單讀成亂碼 | tesseract.js 預設 PSM 6 | 明確指定 PSM 3,不夠再 PSM 11 |
| 從 CDN 載入 OCR 在某些網路失敗 | jsdelivr 可能被擋 | 全部 vendor 進 repo |
| 金額抓成明細第一項 | 多次 OCR 取「第一個找到的」 | 依關鍵字可靠度排名取最好的(5.6) |
| 稅單掃完再掃電費仍顯示稅單金額 | 同一表單的條碼累加,稅單 QR 優先權最高 | 第二次掃描先問,選「另一張」就完整重置(第 4 節) |
| 帳單「消失」 | 掃描把帳單月份改到截止日那個月(去年 12 月),紀錄頁預設只看本月 | 加「所有帳單」、空月份提示其他月份、掃描時明確提示 |
| 照片裡條碼讀不到 | 先縮圖再掃,窄線 < 1.5 px | 原解析度 + 橫條;另提供即時掃描 |
| 色塊邊緣出現灰框 | 背景估計平滑跨越色塊邊界 | 改用保邊的形態學閉運算(第 6 節) |
| 測試通知按了沒反應 | 權限狀態不一致時 `showNotification` 失敗被吞掉;manifest 只有 SVG 圖示 | 點擊時重新要求權限並驗證顯示結果;補 PNG 圖示 |
| 「繼續編輯」後手機返回鍵沒反應 | 攔截 hashchange 時用 replaceState 留下重複的歷史紀錄 | 連結點擊改在 capture 階段、換頁前攔截 |
| 統計顯示「比去年少」,其實是今年還沒過完 | 拿今年 1–10 月比去年全年 | 改成跟去年同期比較,並在文字上寫出比較的月份(第 8 節) |
| headless Chromium 的 `Notification.permission` 永遠是 denied | 舊版 headless shell 的限制 | 測試用 `channel: 'chromium'`(新版 headless) |

---

## 14. 第三方程式碼

| 套件 | 版本 | 授權 | 位置 | 更新方式 |
|---|---|---|---|---|
| zxing-wasm(reader) | 2.2.4 | MIT | `vendor/zxing-reader.js`、`vendor/zxing_reader.wasm` | `npm pack zxing-wasm@x`,複製 `dist/iife/reader/index.js` 與 `dist/reader/zxing_reader.wasm` |
| tesseract.js | 5.1.1 | Apache-2.0 | `vendor/tesseract/tesseract.min.js`、`worker.min.js` | 複製 `dist/` 對應檔案 |
| tesseract.js-core | 5.1.1 | Apache-2.0 | `vendor/tesseract/tesseract-core{,-simd}-lstm.wasm.js` | 複製 LSTM 兩個版本 |
| 辨識資料 | 4.0.0_best_int | Apache-2.0 | `vendor/tesseract/{chi_tra,eng}.traineddata.gz` | `@tesseract.js-data/<lang>` |

更新後記得把 `src/version.js` 的 `VERSION` 加一,並重跑 `npm test` 與掃描相關的端對端驗證。
