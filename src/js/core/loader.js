/* =====================================================================
   載入檔案
   ===================================================================== */
const isPdfBytes = b => { const head = new TextDecoder('latin1').decode(b.subarray(0, Math.min(b.length, 1024))); return head.includes('%PDF-'); };

async function addFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  busy('讀取檔案中…');
  let added = 0;
  const wasEmpty = S.pages.length === 0;
  try {
    for (const f of files) {
      busyMsg(`讀取「${f.name}」…`);
      try {
        let bytes = new Uint8Array(await f.arrayBuffer());
        let name = f.name;
        if (f.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name)) {
          bytes = await imageFileToPdfBytes(f);
          name = f.name.replace(/\.[^.]+$/, '') + '.pdf';
        } else if (!isPdfBytes(bytes)) {
          throw new Error('這不是 PDF 或圖片檔');
        }
        added += await addPdfSource(name, bytes);
      } catch (err) {
        console.error(err);
        toast(`「${f.name}」無法開啟:${err.message || err}`, 6000);
      }
    }
  } finally { unbusy(); }
  if (!added) return;
  if (wasEmpty) {
    S.zoom = Math.min(fitZoom(), 200);
    S.cur = S.pages[0].uid;
  }
  syncAll();
  if (wasEmpty) setCurrent(S.pages[0].uid);
  toast(`已加入 ${added} 頁`);
}

/* 開啟密碼對話框;回傳輸入的密碼,取消時回傳 null */
function askPdfPassword(name, retry) {
  return new Promise(resolve => {
    const dlg = $('#dlgPassword'), input = $('#pwIn');
    $('#pwName').textContent = name;
    $('#pwErr').textContent = retry ? '密碼不正確,請再試一次。' : '';
    input.value = '';
    const done = v => { dlg.close(); $('#pwOk').onclick = $('#pwCancel').onclick = dlg.oncancel = input.onkeydown = null; resolve(v); };
    $('#pwOk').onclick = () => done(input.value);
    $('#pwCancel').onclick = () => done(null);
    dlg.oncancel = ev => { ev.preventDefault(); done(null); };
    input.onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); done(input.value); } };
    dlg.showModal();
    setTimeout(() => input.focus(), 30);
  });
}

/* 用新的檔案替換來源檔(移除浮水印、填寫表單),重畫這個來源的所有頁面。
   不能對舊文件 destroy():pdf.js 的 worker 由所有文件共用,destroy 會連帶關掉它(其他檔案與新開的文件都會失效)。
   keepText:頁面內容沒變(填表單只改欄位外觀)時保留文字與辨識結果的快取 */
async function replaceSourceBytes(srcId, bytes, { keepText = false } = {}) {
  const s = sources.get(srcId);
  const lib = await PDFDocument.load(bytes, { updateMetadata: false });
  const doc = await openWithPdfJs(bytes.slice());
  // 舊文件還在畫頁面時 cleanup 會回傳被拒絕的 Promise(不是丟出例外);釋放快取失敗不影響
  try { Promise.resolve(s.doc.cleanup()).catch(() => {}); } catch (_) { /* 同上 */ }
  Object.assign(s, { bytes, doc, lib });
  if (!keepText) for (const m of [textCache, richCache, ocrCache]) for (const k of [...m.keys()]) if (k.startsWith(srcId + ':')) m.delete(k);
  for (const e of S.pages) {
    if (e.src !== srcId) continue;
    const v = pvMap.get(e.uid);
    if (v) { v.rz = 0; if (!keepText) removeTextLayer(v); if (v.visible) ensureRendered(v); renderOverlay(e); }
    const t = thMap.get(e.uid);
    if (t) withSlot(() => paint(e, t.canvas, 216 / Math.max(e.w, e.h)).catch(err => console.warn(err)));
  }
  syncTextLayers();
}

async function addPdfSource(name, bytes) {
  let lib;
  try { lib = await PDFDocument.load(bytes, { updateMetadata: false }); }
  catch (e) {
    if (!/encrypt/i.test(e.message || '')) throw e;
    // 加密的 PDF:先試空白密碼(只限制列印/複製的檔案),需要時請使用者輸入密碼,解開後當成一般檔案處理
    busyMsg(`解開「${name}」的加密…`);
    const r = await decryptPdf(bytes, retry => askPdfPassword(name, retry));
    if (!r) throw new Error('沒有輸入密碼');
    bytes = r.bytes;
    lib = await PDFDocument.load(bytes, { updateMetadata: false });
    if (r.restricted.length && !r.usedPassword)
      setTimeout(() => toast(`「${name}」設有使用限制(禁止${r.restricted.join('、')})。已解除加密以便編輯,請確認你有權處理這份文件。`, 9000), 600);
  }
  const doc = await openWithPdfJs(bytes.slice());
  const id = 's' + (S.nextId++);
  sources.set(id, { name, bytes, doc, lib });
  const infos = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const vp = p.getViewport({ scale: 1 });
    infos.push({ w: vp.width, h: vp.height, R0: p.rotate || 0 });
  }
  checkpoint();
  infos.forEach((inf, i) => S.pages.push({ uid: uid(), src: id, idx: i, r: 0, w: inf.w, h: inf.h, R0: inf.R0, anns: [] }));
  if (S.pages.length === infos.length) S.baseName = name.replace(/\.pdf$/i, '') || 'document';
  return infos.length;
}

