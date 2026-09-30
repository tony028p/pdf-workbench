// tesseract.js 引擎(OcrEngine 介面,見 docs/ROADMAP.md §4.1)
// 離線做法:
//   - core(已內含 WASM 的 *.wasm.js)與 worker 腳本串成同一個 Blob:core 先定義 TesseractCore,
//     worker 的 getCore 看到已定義就不會再 importScripts(file:// 下 worker 無法載入頁面建立的另一個 Blob URL)
//   - 語言檔直接以 { code, data } 傳入,不經過 langPath 網址(不用攔截 fetch)
//   - cacheMethod: 'none',不碰 IndexedDB
const TesseractEngine = {
  name: 'tesseract.js',
  worker: null,

  async init(onProgress = () => {}) {
    onProgress('解碼引擎');
    const workerPath = URL.createObjectURL(new Blob(
      [await embedBytes('tess-core'), '\n', await embedBytes('tess-worker')], { type: 'text/javascript' }));
    onProgress('解碼語言檔');
    const langs = [];
    for (const code of TESS_LANGS) langs.push({ code, data: await embedBytes('tess-' + code) });
    onProgress('啟動 worker');
    this.worker = await Tesseract.createWorker(langs, Tesseract.OEM.LSTM_ONLY, {
      workerPath, workerBlobURL: false, cacheMethod: 'none', gzip: false,
      logger: m => onProgress(m.status + (m.progress != null ? ' ' + Math.round(m.progress * 100) + '%' : '')),
    });
    await this.worker.setParameters({ preserve_interword_spaces: '1' });
  },

  async recognize(canvas, { psm = '3' } = {}) {
    await this.worker.setParameters({ tessedit_pageseg_mode: psm });
    const { data } = await this.worker.recognize(canvas, {}, { blocks: true, text: true });
    const words = [];
    for (const b of data.blocks || []) for (const p of b.paragraphs) for (const l of p.lines) for (const w of l.words) {
      const str = w.text.trim();
      if (!str) continue;
      words.push({ str, bbox: [w.bbox.x0, w.bbox.y0, w.bbox.x1, w.bbox.y1], conf: w.confidence });
    }
    return { words, text: data.text };
  },

  async terminate() {
    if (this.worker) await this.worker.terminate();
    this.worker = null;
  },
};
