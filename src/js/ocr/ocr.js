/* =====================================================================
   OCR(文字辨識):PaddleOCR PP-OCRv5 mobile,在背景 Worker 執行(src/ocr/worker.js)
   - 只有 build.py --ocr 的完整版內嵌引擎與模型(<script type="application/octet-stream" id="ocr-…">,
     gzip + base64),第一次使用時才解碼;精簡版可以載入同一版建置出的 OCR 套件檔
     (pdf-workbench-ocr-pack.bin,內容相同),載入前 ocrAvailable() 為 false
   - 以 300 dpi、含使用者旋轉渲染頁面(不含標註),辨識結果換回基準座標,
     變成和 pdf.js 文字層相同格式的片段,放進 ocrCache(不放進 S.pages,undo 快照才不會變大)
   - rawPageText 優先使用 OCR 結果,所以擷取文字、選取文字、Word/Markdown/HTML 都直接可用,
     塗黑排除也沿用同一套規則
   ===================================================================== */
const OCR_DPI = 300;
const ocrCache = new Map();   // "srcId:idx" -> rawPageText 格式的結果(另有 ocr: true、conf)

let ocrPack = null;   // 載入的 OCR 套件:{ 部分名稱: gzip 資料 }
const OCR_PARTS = ['worker', 'wasm', 'mjs', 'det', 'rec', 'dict'];
const ocrAvailable = () => !!document.getElementById('ocr-worker') || !!ocrPack;

/* 讀取 OCR 套件檔(build.py 的 ocr_pack):檢查格式與版本,成功後 ocrAvailable() 變成 true */
async function loadOcrPack(file) {
  const buf = new Uint8Array(await file.arrayBuffer()), magic = 'PDFWB-OCR\n';
  if (buf.length < 14 || new TextDecoder().decode(buf.subarray(0, 10)) !== magic) throw new Error('這不是 OCR 套件檔(應該是 pdf-workbench-ocr-pack.bin)');
  const hl = new DataView(buf.buffer, buf.byteOffset + 10, 4).getUint32(0);
  let head;
  try { head = JSON.parse(new TextDecoder().decode(buf.subarray(14, 14 + hl))); } catch (_) { throw new Error('OCR 套件檔已損壞'); }
  if (head.id !== OCR_PACK_ID) throw new Error('OCR 套件的版本和這個工具不同,請使用同一個版本一起發佈的 pdf-workbench-ocr-pack.bin');
  const base = 14 + hl, parts = {};
  for (const k of OCR_PARTS) {
    const r = head.parts && head.parts[k];
    if (!r || base + r[0] + r[1] > buf.length) throw new Error('OCR 套件檔不完整');
    parts[k] = buf.subarray(base + r[0], base + r[0] + r[1]);
  }
  ocrPack = parts;
}

async function ocrEmbedBytes(id) {
  const el = document.getElementById('ocr-' + id);
  if (!el && !ocrPack) throw new Error('這個版本沒有內建 OCR');
  const bytes = el ? b64ToU8(el.textContent.trim()) : ocrPack[id];
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* 引擎:ROADMAP §4.1 的 OcrEngine 介面(init / recognize / terminate) */
const ocrEngine = {
  worker: null, ready: null, initReject: null, seq: 0, jobs: new Map(),
  init(onProgress = () => {}) {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      onProgress('載入文字辨識引擎…');
      const [src, wasm, mjs, det, rec, dict] = await Promise.all(OCR_PARTS.map(ocrEmbedBytes));
      const w = this.worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      await new Promise((resolve, reject) => {
        this.initReject = reject;   // 載入中取消(terminate)時結束等待
        w.onmessage = ({ data }) => {
          if (data.type === 'ready') { w.onmessage = ev => this.onMessage(ev.data); resolve(); }
          else if (data.type === 'error') reject(new Error(data.message));
        };
        w.onerror = ev => reject(new Error(ev.message || '文字辨識引擎無法啟動'));
        w.postMessage({ type: 'init', wasm, mjs, det, rec, dict }, [wasm.buffer, mjs.buffer, det.buffer, rec.buffer, dict.buffer]);
      });
      this.initReject = null;
      w.onerror = ev => { for (const j of this.jobs.values()) j.reject(new Error(ev.message || '文字辨識失敗')); this.jobs.clear(); };
    })();
    this.ready.catch(() => this.terminate());
    return this.ready;
  },
  onMessage(data) {
    const job = this.jobs.get(data.id);
    if (!job) return;
    if (data.type === 'progress') job.onProgress(data.done, data.total);
    else {
      this.jobs.delete(data.id);
      data.type === 'result' ? job.resolve(data.lines) : job.reject(new Error(data.message));
    }
  },
  /* bitmap:ImageBitmap(會轉移給 worker)→ lines(像素座標,格式見 src/ocr/worker.js) */
  async recognize(bitmap, opts = {}, onProgress = () => {}) {
    await this.init();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ type: 'recognize', id, bitmap, opts }, [bitmap]);
    });
  },
  /* 取消:直接結束 worker(辨識中的那一頁作廢),下次使用時重新啟動 */
  terminate() {
    if (this.worker) this.worker.terminate();
    if (this.initReject) this.initReject(new Error('已取消'));
    this.initReject = null;
    for (const j of this.jobs.values()) j.reject(new Error('已取消'));
    this.jobs.clear();
    this.worker = null; this.ready = null;
  },
};

/* 辨識結果 → 基準座標的文字片段(與 rawPageText 的 items 相同格式)
   字詞框(文字方向的左上、右上、右下、左下)÷ 渲染倍率 = 顯示座標,再用 dispToBase 換回基準座標 */
function ocrItems(lines, e, scale) {
  const items = [];
  const toBase = ([x, y]) => dispToBase(x / scale, y / scale, e);
  for (const ln of lines) for (const w of ln.words) {
    const [tl, tr, br, bl] = w.quad.map(toBase);
    const width = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]), hgt = Math.hypot(bl[0] - tl[0], bl[1] - tl[1]);
    if (!width || !hgt) continue;
    const ux = (tr[0] - tl[0]) / width, uy = (tr[1] - tl[1]) / width, vx = (bl[0] - tl[0]) / hgt, vy = (bl[1] - tl[1]) / hgt;
    // 偵測框比字高(外擴過);字級取框高的 0.8,垂直置中,基線在字級的 0.8 處
    const size = hgt * 0.8, top = (hgt - size) / 2, down = top + 0.8 * size;
    // 外框只包住字形範圍(與 pdf.js 文字片段相同),不用整個偵測框,塗黑才不會誤刪上下行
    const at = (s, t) => [tl[0] + ux * s + vx * t, tl[1] + uy * s + vy * t];
    const corners = [at(0, top), at(width, top), at(width, top + size), at(0, top + size)];
    const xs = corners.map(p => p[0]), ys = corners.map(p => p[1]);
    items.push({
      str: w.str, font: 'ocr', ox: tl[0] + vx * down, oy: tl[1] + vy * down, ux, uy, size, width, asc: 0.8, desc: -0.2,
      angle: Math.atan2(uy, ux) * 180 / Math.PI, vertical: false, conf: w.conf,
      box: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
    });
  }
  return items;
}

/* 辨識一頁,結果存進 ocrCache;onProgress(0–1);s2t:簡體字轉成繁體 */
async function ocrPage(e, onProgress = () => {}, { s2t: toTrad = true } = {}) {
  const r = await renderDisplay(e, OCR_DPI, 0);   // 不含標註:文字標註另外輸出,塗黑在輸出時排除
  const bitmap = await createImageBitmap(r.canvas);
  r.canvas.width = r.canvas.height = 1;
  const lines = await ocrEngine.recognize(bitmap, {}, (done, total) => onProgress(done / total));
  if (toTrad) s2tOcrLines(lines);
  const items = ocrItems(lines, e, r.scale);
  const all = items.map(i => i.str).join('');
  const confs = items.map(i => i.conf);
  ocrCache.set(e.src + ':' + e.idx, {
    items, chars: all.length, bad: 0, hasImage: true, ocr: true,
    conf: confs.length ? confs.reduce((s, v) => s + v, 0) / confs.length : 0
  });
  return items.length;
}

/* 哪些頁面需要 OCR:沒有文字層的掃描頁、文字層是亂碼的頁面(已辨識過的不算) */
async function pagesNeedingOcr(list) {
  const out = [];
  for (const e of list) {
    if (ocrCache.has(e.src + ':' + e.idx)) continue;
    const flags = (await pageText(e)).flags;
    if (flags.includes('scan') || flags.includes('garbled')) out.push(e);
  }
  return out;
}
