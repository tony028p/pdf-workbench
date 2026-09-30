# CLAUDE.md

給在這個 repo 工作的 Claude 的專案規則。功能與架構細節見 `README.md`,路線圖見 `docs/ROADMAP.md`。

## 溝通

- **一律用繁體中文回覆使用者**(commit 訊息、程式碼註解維持 repo 既有風格:commit 用英文,註解用中文)。
- 使用者不一定熟悉 Git/GitHub 術語,第一次提到時用白話解釋。

## 專案核心承諾(任何改動都不能打破)

1. **單一 HTML 檔、雙擊即用**:所有函式庫、worker、CMap 都由 `build.py` 內嵌。
2. **完全離線、不上傳資料**:不可加入任何網路請求(測試會檢查,出現就失敗)。
3. **繁體中文優先**。

## 開發流程

- 每個功能或修正開一個 PR,一個 PR 只做一件事;PR 描述用中文,照既有 PR 的格式(摘要/變更內容/驗證/已知限制)。
- 在指定的開發分支上工作;PR 合併後,從最新的 `main` 重新開始同名分支。
- 推送前必須:`python3 build.py` 成功、`python3 -m pytest` 全部通過。CI 綠燈才算完成。
- `dist/` 不進版控;成品由 Release 流程產生(`.github/workflows/release.yml`)。發布版本前要經使用者同意。

## 常用指令

```bash
npm ci                              # 安裝 pdf-lib、fontkit、pdfjs-dist、onnxruntime-web、OCR 模型、思源黑體、OpenCC 字典(版本已鎖定)
python3 build.py                    # 建置精簡版 dist/pdf-workbench.html(不含 OCR;合併內嵌字型需要 requirements-dev.txt 的 fonttools、brotli)
python3 build.py --ocr              # 建置完整版 dist/pdf-workbench-ocr.html 與 OCR 套件檔 pdf-workbench-ocr-pack.bin(需要 requirements-dev.txt 的 onnxruntime)
pip install -r requirements-dev.txt
python3 -m pytest                   # 全部測試(約 1 分鐘)
python3 -m pytest tests/test_text.py -k columns   # 跑部分測試
```

`tests/test_docx.py`、`tests/test_xlsx.py` 各有測試會用 LibreOffice 開啟匯出的 Word/Excel 檔;本機沒有 LibreOffice(含 `libreoffice-writer-nogui`、`libreoffice-calc-nogui`)時會略過,CI 上則必須執行(`REQUIRE_SOFFICE=1`)。

`tests/test_encrypted.py` 的物件串流測試用 qpdf 產生加密檔;本機沒有 qpdf 時略過,CI 上必須執行。

Chromium 版本需與 `requirements-dev.txt` 的 Playwright 版本相符;不符時用環境變數 `CHROMIUM_PATH` 指定執行檔。

## 程式架構規則

- `src/js/` 下的模組**串接成同一個 `<script>`**,共用全域範圍,沒有 import/export。新增檔案要加進 `build.py` 的 `MODULES`,順序就是相依順序(不一致時建置會失敗)。
- OCR 的背景 Worker 在 `src/ocr/worker.js`,**不在** `src/js/`、不進 `MODULES`;`build.py --ocr` 把它和 onnxruntime 串成 Blob Worker。精簡版沒有 OCR 資源,相關程式要用 `ocrAvailable()` 判斷(精簡版載入 OCR 套件檔 `pdf-workbench-ocr-pack.bin` 後也會變成 true;套件由 `build.py --ocr` 同時產生,版本 `OCR_PACK_ID` 是 `src/ocr/worker.js` 的雜湊,改了 worker 舊套件就不能用)。OCR 結果放在 `ocrCache`(與 `textCache` 相同原則,不放進 `S.pages`),`rawPageText` 會優先使用。
- 替換來源檔(例如移除浮水印)時**不可以對舊的 pdf.js 文件呼叫 `destroy()`**:pdf.js worker 由所有文件共用,destroy 會把它關掉,其他檔案與新開的文件都會失效;用 `cleanup()` 釋放快取即可。替換後要清掉該來源的 `textCache`、`richCache`、`ocrCache` 並重畫頁面。
- 有密碼的 PDF 在 `addPdfSource` 裡先用 `decryptPdf`(`core/decrypt.js`)解開成一般 PDF 再往下走,之後的流程不需要知道檔案原本有加密。物件串流要在 pdf-lib 解析前解密,所以 `decrypt.js` 修補了 `PDFParser`/`PDFObjectStreamParser`(只在 `pdfDecryptHook` 有設定時作用)。
- 替換來源檔一律用 `replaceSourceBytes`(`core/loader.js`)。填寫表單只改欄位外觀、不改頁面內容,所以用 `keepText: true` 保留文字與辨識結果快取;其他會改變頁面內容的替換不可以保留。表單填的值存在來源檔的 `form.values`(不放進 `S.pages`),從原始檔重新產生時(例如移除浮水印)要用 `fillForm` 再填一次。
- **不要升級 `pdfjs-dist`**(4.x 以上沒有 UMD 版,無法內嵌)。`getDocument` 必須保留 `isEvalSupported: false`(CVE-2024-4367)。
- **座標**:標註一律存「基準座標」(pt、左上原點、y 向下、已含 PDF 內建 `/Rotate`);使用者旋轉 `r` 只是顯示。轉換用 `dispToBase` / `baseToDisp`,不要自己重算。
- 內嵌字型(`core/fonts.js`)由 `build.py` 從 `@fontsource/noto-sans-tc` 合併並核對 SHA-256;要寫真文字時先用 `sansCovers(text)` 確認每個字都有,沒有就退回圖片。文字標註的真文字排法必須和 `renderTextAsset` 一致(`test_realtext.py` 比對位置)。
- 改字框(標註 `erase`)範圍內的原文字:匯出 PDF 時由 `eraseOriginalText`(`edit/retext.js`)從內容串流刪除(要在畫任何標註之前呼叫);擷取、選取文字、隱形文字層用 `eraseItems`(`text/extract.js`)排除。新的文字輸出路徑也要經過 `eraseItems`。
- `S.pages` 會整個 `JSON.stringify` 當 undo 快照,**不要把大資料放進去**(例如文字擷取結果放在 `textCache`)。
- 使用者看得到的文字一律繁體中文。

## 安全規則:塗黑

塗黑是安全功能,**任何新的輸出路徑(匯出、擷取文字、之後的 Word/OCR)都必須遵守**:

- 塗黑框範圍內的內容不可出現在輸出中,也不可以獨立物件留在檔案裡(蓋一個黑框不算移除)。
- 判斷有疑慮時寧可多刪。
- 標註與塗黑框的前後順序要和編輯畫面一致:先加、被之後的塗黑框蓋住的標註,也不可外露。
- 從來源複製頁面一律用 `copyPagesSafely`(`export/pdf.js`),**不可直接用 pdf-lib 的 `copyPages`**:它會順著連結目的地、表單欄位等參照把其他頁面(含已塗黑或沒有匯出的頁面)整頁複製成孤立物件。`buildPdf` 存檔前另外用 `dropUnreachable` 刪掉走不到的物件。
- 每條新輸出路徑都要有對應的塗黑測試(參考 `tests/test_redaction.py`、`tests/test_text.py`、`tests/test_ocr.py`)。OCR 結果走 `rawPageText`,所以沿用同一套塗黑排除;可搜尋 PDF 的隱形文字層(`export/ocr-layer.js`)也用同樣的 `redactBox` / `boxHit` 過濾,新的 OCR 輸出同樣必須經過它。

## 測試寫法

- 測試用 Playwright 從 `file://` 開啟建置好的 HTML,操作輔助函式在 `tests/conftest.py` 的 `App`(`load`、`tool`、`drag_on_page`、`add_text`、`add_image`、`extract`、`export`、`ocr`…),測試檔由 `tests/fixtures.py` 產生。OCR 測試用 `ocr_app` 夾具(開啟 `--ocr` 完整版)。
- 每個測試自動檢查:沒有 JS 錯誤、沒有對外網路請求。
- 已知陷阱:
  - 文字對話框開啟後有 30ms 的焦點計時器,輸入前要先等它(`add_text` 已處理)。
  - 頁面比視窗高時,拖曳到視窗外不會觸發事件;要拖整頁時先 `setZoom(33)`。
  - 細小文字的像素判斷,請放大渲染(`render(data, scale=2)`)。
- 修 bug 時先寫出能重現問題的測試,確認它在修改前失敗。
- 不可為了讓 CI 變綠而跳過或刪除測試;偶發失敗要找出根本原因。
