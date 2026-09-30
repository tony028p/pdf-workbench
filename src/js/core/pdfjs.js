/* ---------- pdf.js 設定(worker 與 CMap 都內嵌,不需要網路) ---------- */
const WORKER_URL = URL.createObjectURL(new Blob([b64ToU8(WORKER_B64)], { type: 'text/javascript' }));
pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_URL;
try { pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(WORKER_URL); }   // 直接建立 worker,file:// 也能用背景執行緒
catch (err) { console.warn('worker fallback', err); }
class InlineCMapFactory {
  constructor() {}
  async fetch({ name }) {
    const b = CMAPS_B64[name];
    if (!b) throw new Error('Missing CMap ' + name);
    return { cMapData: b64ToU8(b), compressionType: 1 };
  }
}
// isEvalSupported:false 緩解 CVE-2024-4367(pdf.js ≤ 4.1.392 惡意字型可執行任意 JS);本專案鎖在 3.11.x,不可移除
const openWithPdfJs = data => pdfjsLib.getDocument({ data, CMapReaderFactory: InlineCMapFactory, useSystemFonts: true, isEvalSupported: false }).promise;

