# PDF 工作台 — 開發路線圖(新增「匯出 Word」與「OCR」)

> 對應主文件:[`README.md`](../README.md)(功能、架構、完整原始碼)。
> 本文件取代 README 第 7 節的優先序,並展開兩個新功能的設計。

---

## 0. 產品定位(決定取捨的原則)

維持目前的三個核心承諾,新功能都不能打破:

1. **單一 HTML 檔,雙擊即用**
2. **完全離線,不上傳任何資料**(所以不採用雲端 OCR / 雲端轉檔 API)
3. **繁體中文優先**(中文排版、字型、OCR 語言都以 zh-TW 為預設)

新增的取捨:體積允許因 OCR 變大,但要提供「精簡版」與「完整版」兩種建置(見 §4.4)。

---

## 1. 對現有規劃的調整建議

### 1.1 先做的工程基礎(P0,新功能開工前)

| 項目 | 原因 |
|---|---|
| ✅ **把原始碼從 README 還原成實際檔案**:`build.py`、`src/app.html`、`src/app.js`、`package.json`(鎖定 `pdfjs-dist@3.11.174` 與 `pdf-lib` 版本)、`package-lock.json`、`.gitignore`(`node_modules/`、`dist/`) | 原始碼放在 Markdown 裡無法 diff、無法跑測試、無法做 code review。README 只保留說明。 |
| ✅ **修正 pdf.js 安全設定**:`getDocument({... , isEvalSupported: false })` | pdf.js ≤ 4.1.392 有 CVE-2024-4367(惡意 PDF 的字型可執行任意 JS)。專案鎖在 3.11.174 無法升級,必須用這個選項緩解。使用者會開啟來路不明的 PDF,這是實際風險。 |
| ✅ **拆分 `app.js`** 為多個模組(`src/js/core/`、`ui/`、`export/`;之後新增 `text/`、`ocr/`),由 `build.py` 依序串接 | 目前約 1,300 行單檔;加入 Word 與 OCR 後會超過 2,500 行。串接即可,不必引入打包工具。 |
| ✅ **把 README 第 6 節的手動 Playwright 測試寫成 `tests/`(pytest)並接 GitHub Actions** | 之後每個功能都要能自動回歸測試,特別是座標與塗黑相關。 |

建議的目錄架構:

```
pdf-workbench/
├── README.md               # 專案說明(目前這份)
├── docs/
│   └── ROADMAP.md          # 本文件
├── build.py                # 內嵌所有資源成單一 HTML;新增 --ocr 參數
├── package.json
├── src/
│   ├── app.html
│   └── js/
│       ├── core/           # 狀態、座標轉換、pdf.js 設定、素材、載入、復原
│       ├── ui/             # 縮圖列、編輯區、工具、對話框
│       ├── export/         # 浮水印/頁碼、pdf、zip、匯出流程;之後加 docx.js
│       ├── text/           # (待建)文字擷取與版面分析(Word 與 OCR 共用)
│       ├── ocr/            # (待建)OCR 引擎封裝
│       └── main.js
├── tests/                  # pytest + Playwright
└── dist/                   # 建置產物(不進版控)
```

### 1.2 新的優先序

原本第 7 節把「文字擷取」排第 4、「OCR」排第 5,且沒有 Word。三者其實是同一條管線,應該一起規劃:

```
 PDF 有文字層 ──► 文字擷取 ──┐
                            ├──► 版面分析 ──► 匯出 Word / 複製文字 / 匯出 TXT
 掃描檔、圖片 ──► OCR ──────┘                └──► 可搜尋 PDF(隱形文字層)
```

| 順序 | 里程碑 | 內容 | 粗估 |
|---|---|---|---|
| M0 | 工程基礎 | §1.1 全部 | 2–3 天 |
| ✅ M1 | 文字擷取 | `getTextContent` → 行/段落結構;複製整份文字、匯出 TXT | 2–3 天 |
| ✅ M2 | **匯出 Word(文字型 PDF)** | §3 | 4–6 天 |
| ✅ M2.5 | 匯出 Markdown / HTML | 與 Word 共用文件模型 | 半天 |
| ✅ M2.6 | 表格偵測(有框線/無框線) | Word、Markdown、HTML、擷取文字共用;之後 Excel 匯出沿用 | 1 天 |
| ✅ M3 | OCR 引擎比較(spike) | PaddleOCR 與 tesseract.js 各做一個離線單檔原型,用同一組繁中測試集比較準確度、速度、體積後定案(§4.1、§4.3)。**結果:採用 PaddleOCR**,見 [`OCR_SPIKE.md`](OCR_SPIKE.md) | 3–4 天 |
| ✅ M4 | **OCR** | §4;結果接入 M1 的結構,所以 Word/TXT 直接可用。實作狀態與延後項目見 §4.10 | 5–7 天 |
| ✅ M5 | 可搜尋 PDF | OCR 結果寫成隱形文字層(§4.6)。已完成:GlyphLessFont、`Tm`/`Tz` 對齊、塗黑排除、真塗黑頁也加上文字層、原本有文字的頁面不重複 | 2–3 天 |
| 之後 | 原清單其餘項目 | ~~內嵌 CJK 字型~~(已完成)、~~表單填寫~~(已完成)、~~點擊替換文字~~(已完成)、~~密碼~~(已完成:開啟與匯出)、~~裁切~~/~~壓縮~~(已完成)、~~觸控~~(已完成) | — |

「內嵌 CJK 字型」原本排第 2;改用 §4.6 的無字形字型(GlyphLessFont)後,可搜尋 PDF 不再依賴它,所以可以往後排。

---

## 2. 共用基礎:文字擷取與版面分析(`src/js/text/`)

### 2.1 資料結構

OCR 與 PDF 文字層都輸出同一種結構,座標一律是**基準座標**(與標註相同:pt、左上原點、y 向下):

```js
// PageText
{
  source: 'pdf' | 'ocr',
  words:  [{ str, x, y, w, h, font, size, bold, italic, conf? }],   // conf 只有 OCR 有
  lines:  [{ words: [...], x, y, w, h }],
  blocks: [{ lines: [...], x, y, w, h, kind: 'para' | 'heading' | 'list' | 'table?' }]
}
```

- 快取在獨立的 `textCache: Map<"srcId:idx", PageText>`,**不要放進 `S.pages`**。因為 undo 快照是 `JSON.stringify(S.pages)`,放進去會讓每一步 undo 都複製整頁文字。
- 以 `src:idx` 為鍵,所以「複製頁面」「重排」「旋轉」都不用重算(旋轉只是顯示層)。

### 2.2 從 PDF 取文字

- `page.getTextContent()` 的每個 item 有 `transform`、`width`、`height`、`fontName`;用 `viewport.convertToViewportPoint`(scale 1、rotation 0 的 viewport,與 `w/h` 基準一致)轉成基準座標。
- 字型名稱推論粗細與字型族:`Bold`、`Black`、`W7+` → 粗體;`Ming`、`Sung`、`細明` → 明體;`Kai`、`楷` → 楷體;`Hei`、`Gothic`、`JhengHei` → 黑體。
- 內建 `/Rotate` 已包含在 viewport 裡,不需要另外處理。

### 2.3 判斷是否需要 OCR(自動偵測)

每頁計算:

- 文字字元數 < 20,且頁面有圖片(`getOperatorList` 中有 `paintImageXObject`)→ **掃描頁**
- 或私用區字元(U+E000–F8FF)/ 替換字元(U+FFFD)比例 > 30% → **文字層是亂碼**(常見於沒有 ToUnicode 的舊中文 PDF)
- 使用者加入的圖片檔(png/jpg…)建立的頁面 → 一律視為掃描頁

縮圖上標示「無文字」,匯出 Word 時若有這類頁面,提示「是否先執行 OCR?」。

### 2.4 版面分析(行 → 段落)

1. **分行**:依基線 y 分群(容差 = 字高 × 0.5),行內依 x 排序。
2. **分欄**:對整頁的行做 x 投影,找出寬度超過頁寬 3% 的垂直空白帶 → 多欄;閱讀順序為欄內由上而下、欄由左而右。
3. **分段**:行距大於該頁中位數行距 × 1.5,或首行縮排,或字級改變 → 新段落。
4. **標題**:字級 ≥ 內文中位數 × 1.3,或粗體且整行很短 → heading(對應 Word 的「標題 1/2/3」樣式)。
5. **清單**:行首符合 `•`、`●`、`-`、`1.`、`(一)`、`一、` 等 → list。
6. **合併換行**:
   - 中日文字元相接 → **直接相接,不加空格**
   - 英文單字相接 → 加空格;行尾 `-` 且下一行小寫開頭 → 去掉連字號相接
7. **頁首/頁尾**:在多數頁面相同位置、相同內容(或只有數字不同)的行 → 判定為頁首/頁尾/頁碼,Word 匯出時移到頁首/頁尾區,不混在內文。
8. 表格偵測:v1 **不做**(列為已知限制);v2 可用「由向量線段圍成的格子」+「對齊的文字欄」偵測。

---

## 3. 功能 A:匯出 Word(`src/js/export/docx.js`)

### 3.1 兩種模式(在匯出對話框新增格式「Word (.docx)」)

| 模式 | 內容 | 適合 |
|---|---|---|
| **可編輯(預設)** | 依 §2.4 重排成段落、標題、清單;原頁面中的圖片裁切後以內嵌圖片放入;每個 PDF 頁面對應 Word 的一節或分頁 | 要改內容的合約、報告 |
| **保留外觀** | 每頁整頁轉圖片放入 Word(沿用現有 `flattenPage`) | 只是要「Word 格式」交差、外觀必須一模一樣 |

v2 可加「混合模式」:整頁背景圖 + 文字方塊放在原位(外觀接近、文字可改,但編輯起來很難用,優先度低)。

### 3.2 DOCX 產生方式:自己寫最小 OOXML,不引入函式庫

DOCX 就是 ZIP + XML,專案已經有 `makeZip`(僅儲存不壓縮,Word 可以開啟)。最小檔案組成:

```
[Content_Types].xml
_rels/.rels
word/document.xml
word/styles.xml              # 內文、標題 1–3、清單的樣式與中文字型
word/numbering.xml           # 清單編號(有清單時)
word/header1.xml / footer1.xml   # 頁首頁尾、頁碼 PAGE 欄位
word/_rels/document.xml.rels
word/media/image1.png ...
docProps/core.xml
```

- 優點:體積只增加幾 KB,完全掌控中文字型設定。
- 替代方案:npm `docx` 套件(功能完整,但會增加數百 KB,且要處理 UMD 打包)。如果之後要做表格等複雜結構再考慮換。

### 3.3 細節規格

- **頁面尺寸**:`w:pgSz` 單位是 twip(1 pt = 20 twip);依使用者旋轉 `r` 後的顯示方向決定寬高與 `w:orient="landscape"`。邊界由該頁文字範圍的外框估算。
- **中文字型**:每個 run 設 `w:rFonts w:eastAsia="…"` 與 `w:lang w:eastAsia="zh-TW"`。對應表:明體 → 新細明體、黑體 → 微軟正黑體、楷體 → 標楷體、其他 → 新細明體;英數字用 `w:ascii`(Times New Roman / Arial)。
- **字級**:`w:sz` 單位是半點(12 pt → 24)。
- **使用者標註怎麼處理**:
  - 文字標註 → 依位置插入到閱讀順序中的段落
  - 圖片、簽名 → 浮動圖片(`wp:anchor`,相對頁面定位到原座標)
  - 畫筆、直線、螢光筆 → v1 略過並提示;v2 可轉成圖片
  - 頁碼設定 → Word 頁尾的 `PAGE` / `NUMPAGES` 欄位(Word 會自動更新)
  - 浮水印 → v1 略過;v2 放在頁首的浮動文字
- ⚠️ **塗黑(安全性要求,必做)**:
  - 與塗黑矩形相交的文字**必須從輸出中移除**,不能只是蓋黑框
  - 被塗黑區域覆蓋的圖片,裁切前先把該區塗黑
  - 要有自動測試:塗黑後匯出 Word,用 python-docx 讀出全文,確認被塗黑的字串不存在

### 3.4 已知限制(寫進 README)

表格、數學式、文繞圖、直書排版、複雜多欄混排,在「可編輯」模式下都只能近似;需要精準還原的請用「保留外觀」模式。

### 3.5 測試

- python-docx 開啟 → 驗證段落數、標題樣式、中文內容、無空格插入錯誤
- LibreOffice headless 把 docx 轉回 PDF → 用 pypdfium2 比對頁數與文字
- 測試檔:單欄中文、雙欄論文、有 `/Rotate=90` 的頁面、含頁首頁尾的多頁文件、含塗黑的頁面

---

## 4. 功能 B:OCR(`src/js/ocr/`)

### 4.1 引擎選擇

| 方案 | 中文準確度 | 體積 | 離線 | 結論 |
|---|---|---|---|---|
| **PaddleOCR**(PP-OCRv5 mobile 模型 + onnxruntime-web) | 中文明顯較好;單一模型涵蓋繁中、簡中、英文、日文 | 模型約 15–20 MB + onnxruntime WASM 約 10 MB | ✅ | **優先候選**:準確度是「繁中優先」工具的核心價值 |
| tesseract.js v5(WASM) | 印刷清楚的文件尚可;低品質掃描、小字、表格差 | 核心 WASM 約 3–4 MB + 每種語言約數 MB(fast 模型) | ✅ | **備案**:整合成熟、體積小、直接提供字詞座標與信心值 |
| 雲端 OCR API(Google / Azure) | 最好 | 0 | ❌ | 違反「不上傳資料」,不採用 |

兩者的取捨:

- PaddleOCR 在瀏覽器端沒有像 tesseract.js 這樣成熟的套件,前後處理要自己寫:偵測模型輸出的二值圖 → 找文字區域輪廓並外擴 → 裁切、校正方向 → 辨識模型 → CTC 解碼(對照字典)。
- PaddleOCR 只給「行」的框,沒有逐字座標;可搜尋 PDF 需要的逐字位置,要從 CTC 解碼的時間步推算。
- onnxruntime-web 的多執行緒需要 SharedArrayBuffer,`file://` 下無法啟用,只能單執行緒(或用 WebGPU),速度要實測。
- 體積約是 tesseract 的 2–3 倍,但只影響「完整版」(§4.4)。

結論:M3 兩個都做原型,用同一組測試集量字元錯誤率(CER)後定案;預期 PaddleOCR 勝出,tesseract.js 作為備案或「輕量 OCR」版本。

> **M3 結果(2026-09-29,詳見 [`OCR_SPIKE.md`](OCR_SPIKE.md))**:採用 PaddleOCR PP-OCRv5 mobile。24 頁繁中測試集的 CER 為 3.3–3.9%,tesseract.js 最好的設定為 13.5%(有框線的表格約 75%);PaddleOCR 由 CTC 時間步推算的逐字座標整齊,tesseract.js 的中文字詞框不可靠。每頁約 3.5–4.5 秒(單執行緒 WASM),兩者相近。辨識模型只量化 MatMul 權重(int8)後單檔 22 MB,準確度不變。不另做 tesseract.js「輕量 OCR」版本;引擎介面保留。
程式要做一層引擎介面,兩個引擎可以互換,不影響 UI 與輸出:

```js
interface OcrEngine {
  init(langs, onProgress): Promise<void>
  recognize(canvas, { psm }): Promise<{ words: [{ str, bbox:[x0,y0,x1,y1], conf }] }>
  terminate(): Promise<void>
}
```

### 4.2 語言

> 以下為 tesseract.js 的語言檔名稱;PaddleOCR PP-OCRv5 單一模型已涵蓋繁中、簡中、英文、日文,直書需另外處理方向。

- 預設:`chi_tra + eng`(繁中 + 英文數字混排)
- 可選:`chi_tra_vert`(直書)、`chi_sim`、`jpn`
- 預設使用 `tessdata_fast` 模型(體積小、速度快);「高精度」選項改用 `tessdata_best`(體積大很多,只在完整版或手動載入時提供)

### 4.3 離線單檔整合(技術風險最高,先做 spike)

tesseract.js 預設會用網址下載 worker、core WASM 與語言檔,在單一 HTML、`file://` 下都要改成內嵌:

- worker 腳本、core JS/WASM → base64 內嵌,執行時轉 Blob URL(與目前 pdf.js worker 的做法相同),透過 `workerPath` / `corePath` 指定
- 語言檔:tesseract.js 用「`langPath` + 檔名」組網址,Blob URL 無法這樣組合 → 需要驗證的做法:
  1. 攔截 worker 內的 fetch,回傳內嵌資料;或
  2. 改用 `tesseract.js-core`(Emscripten 模組)直接寫入虛擬檔案系統後呼叫 API(控制力最高,備案)
- 關閉快取(`cacheMethod: 'none'`),避免在 `file://` 使用 IndexedDB 出錯
- 在 Claude.ai 預覽沙盒中 Blob Worker 會被擋,要確認能退回(或清楚提示「請下載後在本機開啟」)

**spike 的完成標準**:在 `file://` 下離線(關閉網路)辨識一張繁中掃描頁,並取得字詞座標。

### 4.4 打包策略(體積)

目前 2.9 MB;加上 base64 約增加 33% 後,預估完整版:tesseract.js(繁中 + 英文)約 **10–15 MB**,PaddleOCR 約 **35–40 MB**(實際數字 M3 時量測)。

> M3 實測:內嵌前先 gzip、執行時用 `DecompressionStream` 解壓,PaddleOCR(int8 辨識模型)單獨約 **22 MB**,完整版預估約 **25 MB**;tesseract.js(best_int)約 8 MB。

`build.py` 產出兩個版本:

| 檔案 | 內容 |
|---|---|
| `pdf-workbench.html` | 精簡版,無 OCR(維持約 3 MB) |
| `pdf-workbench-ocr.html` | 完整版,內嵌 OCR 引擎與模型(繁中 + 英文) |

另外在精簡版提供「載入 OCR 套件」按鈕:使用者從本機選 OCR 套件檔(一個 `.zip`,內含 core 與語言檔),仍然不需要網路。

### 4.5 處理流程

1. **挑頁面**:對話框選「自動(只處理無文字頁)/ 全部 / 選取頁」
2. **渲染**:用 pdf.js 以 300 dpi、`rotation = (R0 + r) % 360` 渲染(使用者把橫躺的掃描頁轉正後,OCR 看到的就是正的);A4 在 300 dpi 約 870 萬像素,在現有 1,600 萬像素上限內
3. **前處理**(可開關):灰階 → Otsu 二值化 → 小角度歪斜校正(±5°)
4. **辨識**:在 worker 中逐頁執行;進度顯示「第 3 / 20 頁」,可取消
5. **座標轉回基準座標**:像素座標 ÷ scale 得到顯示座標,再用現有的 `dispToBase()` 轉成基準座標 → 存入 `textCache`(`source: 'ocr'`)
6. **重建結構**:words 進入 §2.4 版面分析,之後 Word、TXT、複製文字全部共用

### 4.6 輸出

| 輸出 | 做法 |
|---|---|
| 複製文字 / 匯出 TXT | 直接使用 `PageText.blocks` |
| 匯出 Word | 同 §3,掃描頁在「可編輯」模式會變成真正的文字段落 |
| **可搜尋 PDF** | 保留原掃描影像,疊加**隱形文字層**(text render mode 3)。採用 Tesseract 本身的 **GlyphLessFont** 做法:用 pdf-lib 底層物件建一個 Type0 / Identity-H 字型,只含一個空白字形,加上 ToUnicode 對應表 → **不需要內嵌任何中文字型**,體積極小,仍然可以選取、搜尋、複製。每個字詞用水平縮放(`Tz`)對齊原本的寬度。 |
| 檢視辨識結果 | 編輯區新增「顯示文字層」開關,以半透明框顯示辨識出的文字;低信心(conf < 60)的字詞標成橘色 |

v2:在文字層上直接點選修正辨識錯誤的字。

### 4.7 與現有功能的互動

- **塗黑**:塗黑區域內的 OCR 文字不能寫入隱形文字層,也不能出現在 TXT / Word(與 §3.3 相同規則,共用一個過濾函式)
- **真塗黑**的頁面會整頁轉成影像 → 原本的文字層消失;若使用者要可搜尋,需在塗黑之後對該頁重新 OCR(自動偵測會判斷為掃描頁)
- **undo**:OCR 結果不在 undo 範圍內(存在 `textCache`),頁面刪除後復原不需要重跑

### 4.8 測試

- 用 reportlab 產生已知文字的中文 PDF → 轉 300 dpi 影像 → 加雜訊/微旋轉 → 包成純影像 PDF → 執行 OCR → 計算字元正確率(CER),設定門檻避免退步
- 可搜尋 PDF:用 pypdfium2 `get_text_range()` 取出文字,驗證可搜尋、座標大致落在原字位置
- 效能:20 頁掃描檔的總時間與記憶體峰值

### 4.9 期望管理(寫進 README)

- (M3 前的寫法,以 tesseract.js 為準)Tesseract 對繁體中文的準確度明顯低於商業引擎;清楚的印刷文件可用,手寫、低解析度傳真、印章、複雜表格效果差
- 改用 PaddleOCR 後(M3):清楚的印刷文件錯字率約 1%,掃描與傳真約 3–4%;低解析度模糊的掃描會漏掉筆畫少的字;手寫、印章、直書未測試
- 速度約每頁 3–5 秒(視電腦而定)

---

### 4.10 M4 實作狀態

已完成:
- `build.py --ocr` 產出完整版 `pdf-workbench-ocr.html`(約 25 MB);精簡版不變(約 3 MB),不顯示「文字辨識」按鈕,掃描頁的提示會說明改用完整版
- PaddleOCR PP-OCRv5 mobile 在背景 Worker 執行(§4.5 的 2、4、5、6);引擎介面依 §4.1
- 對話框:自動 / 全部 / 選取頁,進度與取消(§4.5 的 1)
- 數字正規化:數字之間的全形逗號、句點 → 千分位與小數點
- 結果接入擷取文字、選取文字、Word/Markdown/HTML;塗黑沿用同一套排除規則(§4.7)
- CI 同時建置、測試兩個版本,發布時兩個檔案都附上

延後(之後視需要再做):
- ~~精簡版「載入 OCR 套件」按鈕(§4.4)~~(已完成:套件是自訂格式的 `pdf-workbench-ocr-pack.bin`,內容與完整版內嵌的相同,依 worker 版本核對)
- 前處理開關:灰階、二值化、歪斜校正(§4.5 的 3)。PaddleOCR 的旋轉外框已能處理小角度歪斜
- ~~低信心字詞標示~~(已完成:信心低於 85% 標成橘色框;實測 60 太低,認錯的字常在 60–85 之間);~~「顯示文字層」開關~~(已完成:藍框 PDF 文字、綠框辨識結果、紅框疑似亂碼);縮圖上的「無文字」標示(§2.3)尚未做
- ~~簡體字輸出轉繁體~~(已完成,見 [`OCR_SPIKE.md`](OCR_SPIKE.md))
- 用真實掃描檔測試、在 Firefox 與 Safari 確認

## 5. 風險與待決事項

| 風險 | 對策 |
|---|---|
| OCR 引擎無法在單檔 `file://` 離線載入模型 | M3 spike 先驗證;onnxruntime-web 用 `wasmBinary` 直接傳入;tesseract 備案改用 `tesseract.js-core` 直接操作 |
| 檔案體積過大、瀏覽器開啟變慢 | 精簡版 / 完整版雙建置;OCR 引擎延後到第一次使用時才解碼 base64 |
| 繁中 OCR 準確度不夠 | M3 以測試集量化比較;引擎介面抽象化,可隨時替換 |
| Word 版面還原品質被拿來和 Adobe 比較 | 提供「保留外觀」模式,並在 README 寫明限制 |
| 塗黑內容透過新匯出路徑外洩 | 共用塗黑過濾函式 + 專門的自動測試(§3.3、§4.7) |
