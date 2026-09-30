# M3:OCR 引擎比較原型

這個資料夾是 [`docs/ROADMAP.md`](../../docs/ROADMAP.md) M3 的比較原型,**不屬於正式建置**(`build.py`、測試、CI 都不會用到)。
結論與數據見 [`docs/OCR_SPIKE.md`](../../docs/OCR_SPIKE.md)。

## 內容

| 檔案 | 用途 |
|---|---|
| `src/engine-tesseract.js` | tesseract.js 引擎(ROADMAP §4.1 的 `OcrEngine` 介面) |
| `src/engine-paddle.js` | PaddleOCR PP-OCRv5 mobile 引擎:onnxruntime-web(WASM)+ 自己寫的 DB 偵測後處理與 CTC 解碼 |
| `src/embed.js` | 內嵌資源:gzip + base64,第一次使用時才用 `DecompressionStream` 解壓 |
| `src/harness.html` | 原型頁面:可手動選一張圖片辨識(藍框 = 字詞,橘框 = 信心值 < 60) |
| `build_spike.py` | 把各設定內嵌成單一 HTML(`out/*.html`),並記錄體積(`out/sizes.json`) |
| `testset.py` | 產生繁中測試集(6 種版面 × 4 種影像品質,附標準答案) |
| `bench.py` | 用 Playwright 從 `file://` 開啟各原型、封鎖網路,計算 CER、速度、記憶體 |

## 重現

需要 Node.js、Python(`requirements-dev.txt` 加上 `onnxruntime psutil`)與中文字型
(Ubuntu:`fonts-noto-cjk fonts-arphic-ukai fonts-arphic-uming`)。

```bash
cd spike/ocr
npm ci                     # tesseract.js、onnxruntime-web、模型(版本已鎖定)
pip install onnxruntime psutil
python3 build_spike.py     # 第一次會從 GitHub 下載 tessdata_fast/best(核對 SHA-256)
python3 testset.py
python3 bench.py           # 全部設定約 20 分鐘;也可指定設定名稱,例如 python3 bench.py paddle
```

## 離線整合的做法(M4 會沿用)

- **tesseract.js**:core(內含 WASM 的 `*.wasm.js`)與 worker 腳本串成同一個 Blob 當 `workerPath`
  (`file://` 下 worker 無法 `importScripts` 頁面建立的另一個 Blob URL);語言檔以 `{ code, data }` 直接傳入;
  `cacheMethod: 'none'`。tesseract.js 7.0.0 有個 bug:用 `{ code, data }` 時初始化誤把資料當語言名稱,
  `build_spike.py` 在建置時修補 worker 腳本。
- **onnxruntime-web**:`env.wasm.wasmBinary` 直接傳入 WASM,Emscripten 膠水模組(`.mjs`)用 Blob URL
  動態 import;`numThreads = 1`(`file://` 沒有 SharedArrayBuffer)。也已驗證可在 Blob Worker 內執行,
  Worker 內有 OffscreenCanvas。
- **模型字典**:npm 套件 `pdfmarkdown-ppocrv5-models` 的字典比 PaddleOCR 官方 `ppocrv5_dict.txt`
  多了第 2 行空白與結尾空白,建置時還原成官方順序(已逐行比對)。
