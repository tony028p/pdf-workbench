/* =====================================================================
   匯出
   ===================================================================== */
const hexRgb = hex => { const n = parseInt(hex.slice(1), 16); return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255); };

/* 真塗黑:整頁轉成影像。最後一個塗黑框以前的標註(含塗黑框本身)依原本的前後順序畫進影像,
   被塗黑框蓋住的標註才不會在匯出時重新出現,也不會以獨立物件留在 PDF 裡;
   回傳 burned = 已畫進影像的標註數,其餘(塗黑之後才加的)由 buildPdf 照常畫在上面。 */
async function flattenPage(e, dpi = 200) {
  let burned = 0;
  e.anns.forEach((a, i) => { if (a.type === 'redact') burned = i + 1; });
  const { canvas, dw, dh } = await renderDisplay(e, dpi, burned);
  return { jpg: dataUrlToU8(canvas.toDataURL('image/jpeg', 0.92)), dw, dh, burned };
}
/* 以顯示方向渲染頁面,並依序燒入前 count 個標註(不含浮水印/頁碼)。
   回傳 canvas 與 scale(每 pt 幾像素);匯出 Word 時從這裡裁切圖片,塗黑因此一定會套用。 */
async function renderDisplay(e, dpi, count) {
  const src = sources.get(e.src), page = await src.doc.getPage(e.idx + 1);
  const [dw, dh] = dispSize(e);
  const scale = Math.min(dpi / 72, 6500 / Math.max(dw, dh));
  const vp = page.getViewport({ scale, rotation: (e.R0 + e.r) % 360 });
  const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: g, viewport: vp }).promise;
  // 基準座標 → 影像像素(含使用者旋轉)
  const [ox, oy] = baseToDisp(0, 0, e), [ax, ay] = baseToDisp(1, 0, e), [bx, by] = baseToDisp(0, 1, e);
  g.setTransform((ax - ox) * scale, (ay - oy) * scale, (bx - ox) * scale, (by - oy) * scale, ox * scale, oy * scale);
  for (const a of e.anns.slice(0, count)) await burnAnn(g, a);
  g.setTransform(1, 0, 0, 1, 0, 0);
  return { canvas: c, scale, dw, dh };
}
async function burnAnn(g, a) {
  if (a.type === 'crop') return;       // 裁切不是畫上去的東西
  g.save();
  if (a.type === 'pen' || a.type === 'line') {
    const pts = a.type === 'pen' ? a.pts : [a.x1, a.y1, a.x2, a.y2];
    g.strokeStyle = a.color; g.lineWidth = a.width; g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(pts[0], pts[1]);
    for (let k = 2; k + 1 < pts.length; k += 2) g.lineTo(pts[k], pts[k + 1]);
    g.stroke();
  } else if (a.type === 'hl' || a.type === 'redact' || a.type === 'erase') {
    if (a.type === 'hl') { g.globalAlpha = 0.55; g.globalCompositeOperation = 'multiply'; }
    g.fillStyle = a.color; g.fillRect(a.x, a.y, a.w, a.h);
  } else {
    const as = assets.get(a.asset);
    const bmp = await createImageBitmap(new Blob([as.bytes], { type: as.mime }));
    g.drawImage(bmp, a.x, a.y, a.w, a.h);
    bmp.close();
  }
  g.restore();
}

/* stats:傳入物件時填入 eraseMissed(改字框內有原文字無法從檔案刪除、只蓋住底色的頁碼) */
async function buildPdf(list, { flatten = true, ocrLayer = false, formFlat = false, label = '', stats = {} } = {}) {
  stats.eraseMissed = [];
  const out = await PDFDocument.create();
  out.setProducer('PDF 工作台'); out.setCreator('PDF 工作台');
  const total = S.pages.length;
  const needFlat = e => flatten && e.anns.some(a => a.type === 'redact');
  const bySrc = new Map();
  list.forEach((e, i) => { if (needFlat(e)) return; if (!bySrc.has(e.src)) bySrc.set(e.src, []); bySrc.get(e.src).push(i); });
  const copied = new Array(list.length), nullRef = out.context.register(PDFLib.PDFNull), formDefaults = [];
  for (const [sid, idxs] of bySrc) {
    const r = copyPagesSafely(out, sources.get(sid).lib, idxs.map(i => list[i].idx), nullRef);
    r.pages.forEach((pg, k) => { copied[idxs[k]] = pg; });
    if (r.form) formDefaults.push(r.form);
  }
  const emb = new Map();
  const embed = async id => {
    if (emb.has(id)) return emb.get(id);
    const as = assets.get(id);
    const im = as.mime === 'image/jpeg' ? await out.embedJpg(as.bytes) : await out.embedPng(as.bytes);
    emb.set(id, im); return im;
  };
  const drawImg = async (page, mapPt, id, cx, cy, w, h, angle, opacity) => {
    const im = await embed(id), rad = angle * Math.PI / 180, c = Math.cos(rad), s = Math.sin(rad);
    const rot = (x, y) => [cx + x * c - y * s, cy + x * s + y * c];
    const bl = rot(-w / 2, h / 2), br = rot(w / 2, h / 2);
    const P0 = mapPt(bl[0], bl[1]), P1 = mapPt(br[0], br[1]);
    page.drawImage(im, { x: P0[0], y: P0[1], width: w, height: h, rotate: degrees(Math.atan2(P1[1] - P0[1], P1[0] - P0[0]) * 180 / Math.PI), opacity });
  };

  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    busyMsg(`${label}處理第 ${i + 1} / ${list.length} 頁…`);
    if (i % 4 === 3) await raf();
    let page, mapPt, flat = needFlat(e), burned = 0;
    if (flat) {
      const f = await flattenPage(e);
      burned = f.burned;
      page = out.addPage([f.dw, f.dh]);
      page.drawImage(await out.embedJpg(f.jpg), { x: 0, y: 0, width: f.dw, height: f.dh });
      mapPt = (bx, by) => { const [x, y] = baseToDisp(bx, by, e); return [x, f.dh - y]; };
    } else {
      page = copied[i]; out.addPage(page);
      page.setRotation(degrees((e.R0 + e.r) % 360));
      const jsPage = await sources.get(e.src).doc.getPage(e.idx + 1), vp = jsPage.getViewport({ scale: 1 });
      mapPt = (bx, by) => vp.convertToPdfPoint(bx, by);
      // 改字框內的原文字從內容串流刪掉(要在畫任何東西之前,只處理頁面原本的內容)
      if (await eraseOriginalText(out, page, e, mapPt)) stats.eraseMissed.push(S.pages.indexOf(e) + 1);
      if (formFlat) flattenPageWidgets(page);
    }
    // 辨識過的掃描頁:疊上隱形文字層(在標註之下;塗黑範圍內的字詞不寫入)
    if (ocrLayer && await needsOcrLayer(e, flat)) await addOcrTextLayer(out, page, e, mapPt);
    for (const a of e.anns.slice(burned)) {
      if (a.type === 'crop') continue;
      if (a.type === 'pen') {
        for (let k = 0; k + 3 < a.pts.length; k += 2) {
          const A = mapPt(a.pts[k], a.pts[k + 1]), B = mapPt(a.pts[k + 2], a.pts[k + 3]);
          page.drawLine({ start: { x: A[0], y: A[1] }, end: { x: B[0], y: B[1] }, thickness: a.width, color: hexRgb(a.color), lineCap: LineCapStyle.Round });
        }
      } else if (a.type === 'line') {
        const A = mapPt(a.x1, a.y1), B = mapPt(a.x2, a.y2);
        page.drawLine({ start: { x: A[0], y: A[1] }, end: { x: B[0], y: B[1] }, thickness: a.width, color: hexRgb(a.color), lineCap: LineCapStyle.Round });
      } else if (a.type === 'hl' || a.type === 'redact' || a.type === 'erase') {
        const A = mapPt(a.x, a.y + a.h / 2), B = mapPt(a.x + a.w, a.y + a.h / 2);
        const o = { start: { x: A[0], y: A[1] }, end: { x: B[0], y: B[1] }, thickness: a.h, color: hexRgb(a.color) };
        if (a.type === 'hl') { o.opacity = 0.55; o.blendMode = BlendMode.Multiply; }
        page.drawLine(o);
      } else if (!(a.type === 'text' && await drawRealText(out, page, mapPt, a))) {
        await drawImg(page, mapPt, a.asset, a.x + a.w / 2, a.y + a.h / 2, a.w, a.h, 0, 1);
      }
    }
    const gi = S.pages.indexOf(e);
    for (const it of markItems(e, gi, total)) await drawImg(page, mapPt, it.asset, it.cx, it.cy, it.w, it.h, it.angle, it.opacity);
    applyCrop(page, mapPt, e);
  }
  pruneForeignRefs(out, nullRef);
  if (!formFlat) buildAcroForm(out, formDefaults);
  await out.flush();
  dropUnreachable(out.context);
  return await out.save();
}

/* 裁切:把裁切框(基準座標)換成 PDF 座標,設成頁面的 CropBox(閱讀程式只顯示這個範圍;範圍外的內容仍在檔案裡) */
function applyCrop(page, mapPt, e) {
  const c = e.anns.filter(a => a.type === 'crop').pop();
  if (!c) return;
  const pts = [[c.x, c.y], [c.x + c.w, c.y], [c.x, c.y + c.h], [c.x + c.w, c.y + c.h]].map(([x, y]) => mapPt(x, y));
  const m = page.getMediaBox();
  const x0 = Math.max(m.x, Math.min(...pts.map(p => p[0]))), x1 = Math.min(m.x + m.width, Math.max(...pts.map(p => p[0])));
  const y0 = Math.max(m.y, Math.min(...pts.map(p => p[1]))), y1 = Math.min(m.y + m.height, Math.max(...pts.map(p => p[1])));
  if (x1 - x0 < 1 || y1 - y0 < 1) return;
  page.setCropBox(x0, y0, x1 - x0, y1 - y0);
}

/* 文字標註寫成真正的文字(黑體、內嵌字型涵蓋每個字時);位置與畫面上的文字圖相同:
   左邊留 0.12 字級、每行高 1.35 字級、以行的中線對齊(renderTextAsset 的排法)。回傳 false 表示改用圖片 */
async function drawRealText(out, page, mapPt, a) {
  if (a.font !== 'sans' || !sansCovers(a.text)) return false;
  const { pushGraphicsState, popGraphicsState, beginText, endText, setFontAndSize, setTextMatrix, showText,
    setFillingRgbColor, setStrokingRgbColor, setLineWidth, setTextRenderingMode, TextRenderingMode } = PDFLib;
  const font = await embedSans(out), key = page.node.newFontDictionary(font.name, font.ref), c = hexRgb(a.color);
  const pad = a.size * 0.12, lh = a.size * 1.35, mid = sansMiddleToBaseline() * a.size;
  const ops = [pushGraphicsState(), setFillingRgbColor(c.red, c.green, c.blue)];
  // 粗體:和畫面上的假粗體一樣用描邊加粗(字型只有一種粗細)
  if (a.bold) ops.push(setTextRenderingMode(TextRenderingMode.FillAndOutline), setStrokingRgbColor(c.red, c.green, c.blue), setLineWidth(a.size * 0.035));
  a.text.split('\n').forEach((line, i) => {
    if (!line) return;
    const bx = a.x + pad, by = a.y + pad + (i + 0.5) * lh + mid;
    const P = mapPt(bx, by), X = mapPt(bx + 1, by), Y = mapPt(bx, by - 1);   // 基準座標 y 向下,文字的上方是 y - 1
    ops.push(beginText(), setFontAndSize(key, a.size),
      setTextMatrix(X[0] - P[0], X[1] - P[1], Y[0] - P[0], Y[1] - P[1], P[0], P[1]), showText(font.encodeText(line)), endText());
  });
  ops.push(popGraphicsState());
  page.pushOperators(...ops);
  return true;
}

/* 表單:輸出頁面上的 widget 往上找到最上層的欄位,放進新的 /AcroForm(預設外觀與字型資源沿用第一個來源檔的) */
function buildAcroForm(out, defaults) {
  const { PDFName, PDFArray, PDFDict, PDFRef } = PDFLib, ctx = out.context, N = k => PDFName.of(k);
  const roots = [], seen = new Set();
  for (const page of out.getPages()) {
    const annots = page.node.lookup(N('Annots'));
    if (!(annots instanceof PDFArray)) continue;
    for (const r of annots.asArray()) {
      const a = ctx.lookup(r);
      if (!(r instanceof PDFRef) || !(a instanceof PDFDict) || a.get(N('Subtype')) !== N('Widget')) continue;
      let top = r;
      for (let guard = 0; guard < 50; guard++) {
        const p = ctx.lookup(top).get(N('Parent'));
        if (!(p instanceof PDFRef) || !(ctx.lookup(p) instanceof PDFDict)) break;
        top = p;
      }
      if (!seen.has(top)) { seen.add(top); roots.push(top); }
    }
  }
  if (!roots.length) return;
  const d = defaults.find(x => x.DA || x.DR) || {}, acro = ctx.obj({ Fields: roots });
  if (d.DA) acro.set(N('DA'), d.DA);
  if (d.DR) acro.set(N('DR'), d.DR);
  out.catalog.set(N('AcroForm'), ctx.register(acro));
}

/* 表單轉成一般內容:把每個 widget 目前的外觀畫進頁面,再移除 widget(欄位因此走不到,存檔前會被刪除) */
function flattenPageWidgets(page) {
  const { PDFName, PDFArray, PDFDict, PDFRef, PDFNumber, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } = PDFLib;
  const ctx = page.doc.context, N = k => PDFName.of(k);
  const annots = page.node.lookup(N('Annots'));
  if (!(annots instanceof PDFArray)) return;
  const nums = arr => arr instanceof PDFArray ? arr.asArray().map(v => ctx.lookup(v)).map(v => v instanceof PDFNumber ? v.asNumber() : 0) : null;
  const keep = [];
  for (const r of annots.asArray()) {
    const a = ctx.lookup(r);
    if (!(a instanceof PDFDict) || a.get(N('Subtype')) !== N('Widget')) { keep.push(r); continue; }
    const flags = a.lookup(N('F')), hidden = flags instanceof PDFNumber && (flags.asNumber() & 2);
    const apDict = a.lookup(N('AP')), n = apDict instanceof PDFDict ? apDict.get(N('N')) : null;
    let apRef = n instanceof PDFRef && ctx.lookup(n) instanceof PDFLib.PDFStream ? n : null;
    if (!apRef && n) {                                            // 勾選框/單選:依目前狀態(/AS)取外觀
      const states = ctx.lookup(n), as = a.get(N('AS'));
      const st = states instanceof PDFDict && as instanceof PDFName ? states.get(as) : null;
      if (st instanceof PDFRef) apRef = st;
    }
    const rect = nums(a.lookup(N('Rect')));
    if (hidden || !apRef || !rect) continue;
    // 外觀的 BBox 經過 /Matrix 後,縮放、平移到註解的 Rect(PDF 規範 12.5.5)
    const ap = ctx.lookup(apRef), bb = nums(ap.dict.lookup(N('BBox'))) || [0, 0, 1, 1], m = nums(ap.dict.lookup(N('Matrix'))) || [1, 0, 0, 1, 0, 0];
    const pts = [[bb[0], bb[1]], [bb[2], bb[1]], [bb[0], bb[3]], [bb[2], bb[3]]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
    const tx = Math.min(...pts.map(p => p[0])), ty = Math.min(...pts.map(p => p[1]));
    const tw = Math.max(...pts.map(p => p[0])) - tx, th = Math.max(...pts.map(p => p[1])) - ty;
    const rx = Math.min(rect[0], rect[2]), ry = Math.min(rect[1], rect[3]), rw = Math.abs(rect[2] - rect[0]), rh = Math.abs(rect[3] - rect[1]);
    if (!(tw > 0 && th > 0)) continue;
    const sx = rw / tw, sy = rh / th, key = page.node.newXObject('FlatWidget', apRef);
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(sx, 0, 0, sy, rx - tx * sx, ry - ty * sy), drawObject(key), popGraphicsState());
  }
  page.node.set(N('Annots'), ctx.obj(keep));
}

/* 從來源複製頁面。pdf-lib 的 copyPages 會順著參照把東西一起複製:連結的目的地(/Dest)、表單欄位的 /Kids、
   註解的 /P 都指向別的頁面物件,那一頁(含原始內容串流)就會整頁複製成孤立物件,
   被真塗黑轉成影像或沒有匯出的頁面因此外洩。這裡先把來源的每個頁面(與目錄、頁面樹)對應好:
   這次有輸出的頁面對到輸出檔的頁面,其餘一律對到 nullRef,複製時就不會再往下走。 */
function copyPagesSafely(out, lib, indices, nullRef) {
  const { PDFObjectCopier, PDFPage, PDFName, PDFDict, PDFArray } = PDFLib;
  const copier = PDFObjectCopier.for(lib.context, out.context), map = copier.traversedObjects;
  const srcPages = lib.getPages();
  const seedTree = ref => {                                        // 目錄與頁面樹節點也不能被複製
    const node = lib.context.lookup(ref);
    map.set(ref, nullRef);
    const kids = node instanceof PDFDict && node.lookup(PDFName.of('Kids'));
    if (kids instanceof PDFArray) kids.asArray().forEach(k => { if (k instanceof PDFLib.PDFRef && !map.has(k)) seedTree(k); });
  };
  const root = lib.context.trailerInfo.Root;
  if (root) {
    map.set(root, nullRef);
    const pages = lib.catalog.get(PDFName.of('Pages'));
    if (pages instanceof PDFLib.PDFRef) seedTree(pages);
  }
  srcPages.forEach(p => map.set(p.ref, nullRef));
  const target = new Map();                                        // 來源頁索引 → 輸出頁 ref(同一頁複製多次時用第一個)
  for (const idx of indices) if (!target.has(idx)) { target.set(idx, out.context.nextRef()); map.set(srcPages[idx].ref, target.get(idx)); }
  const used = new Set();
  const pages = indices.map(idx => {
    const node = copier.copy(srcPages[idx].node);
    let ref;
    if (!used.has(idx)) { ref = target.get(idx); out.context.assign(ref, node); used.add(idx); }
    else ref = out.context.register(node);
    return PDFPage.of(node, ref, out);
  });
  // 表單的預設外觀與字型資源(之後建立輸出檔的 /AcroForm 用;用同一個 copier,字型不會重複複製)
  const acro = lib.catalog.lookup(PDFName.of('AcroForm'));
  let form = null;
  if (acro instanceof PDFDict) {
    const da = acro.get(PDFName.of('DA')), dr = acro.get(PDFName.of('DR'));
    form = { DA: da ? copier.copy(da) : null, DR: dr ? copier.copy(dr) : null };
  }
  return { pages, form };
}

/* 指向沒有輸出的頁面(nullRef)的註解:連結直接刪除;/P 改成所在的頁面;
   表單欄位的 /Kids 只留下實際在輸出頁面上的 widget(其他頁的 widget 與外觀不留在檔案裡) */
function pruneForeignRefs(out, nullRef) {
  const { PDFName, PDFArray, PDFDict, PDFRef } = PDFLib, ctx = out.context, N = k => PDFName.of(k);
  const pointsAway = arr => arr instanceof PDFArray && arr.get(0) === nullRef;
  const onPages = new Set();
  const pages = out.getPages();
  for (const page of pages) {
    const annots = page.node.lookup(N('Annots'));
    if (!(annots instanceof PDFArray)) continue;
    const keep = [];
    for (const r of annots.asArray()) {
      const a = ctx.lookup(r);
      if (!(a instanceof PDFDict)) continue;
      const act = a.lookup(N('A'));
      if (pointsAway(a.lookup(N('Dest'))) || (act instanceof PDFDict && pointsAway(act.lookup(N('D'))))) continue;
      if (a.get(N('P'))) a.set(N('P'), page.ref);
      keep.push(r); onPages.add(r);
    }
    page.node.set(N('Annots'), ctx.obj(keep));
  }
  // 欄位樹:由下往上,沒有任何後代 widget 在輸出頁面上的節點從 /Kids 移除
  const visited = new Map();
  const prune = r => {
    if (onPages.has(r)) return true;
    if (visited.has(r)) return visited.get(r);
    visited.set(r, false);
    const f = r instanceof PDFRef ? ctx.lookup(r) : null, kids = f instanceof PDFDict && f.lookup(N('Kids'));
    if (!(kids instanceof PDFArray)) return false;
    const left = kids.asArray().filter(prune);
    f.set(N('Kids'), ctx.obj(left));
    visited.set(r, left.length > 0);
    return left.length > 0;
  };
  for (const r of onPages) {
    let p = ctx.lookup(r).get(N('Parent'));
    const seen = new Set();
    while (p instanceof PDFRef && !seen.has(p)) {
      seen.add(p);
      const f = ctx.lookup(p);
      if (!(f instanceof PDFDict)) break;
      const kids = f.lookup(N('Kids'));
      if (kids instanceof PDFArray) f.set(N('Kids'), ctx.obj(kids.asArray().filter(prune)));
      p = f.get(N('Parent'));
    }
  }
}

/* 刪除從 trailer(目錄、文件資訊)走不到的物件:pdf-lib 存檔時會寫出 context 裡所有的物件,包括孤立的 */
function dropUnreachable(ctx) {
  const { PDFRef, PDFDict, PDFArray, PDFStream } = PDFLib, seen = new Set(), stack = [];
  const t = ctx.trailerInfo;
  [t.Root, t.Info, t.Encrypt].forEach(r => { if (r instanceof PDFRef) stack.push(r); });
  const visit = o => {
    if (o instanceof PDFRef) { if (!seen.has(o)) stack.push(o); }
    else if (o instanceof PDFDict) for (const [, v] of o.entries()) visit(v);
    else if (o instanceof PDFArray) for (const v of o.asArray()) visit(v);
    else if (o instanceof PDFStream) visit(o.dict);
  };
  while (stack.length) {
    const r = stack.pop();
    if (seen.has(r)) continue;
    seen.add(r);
    visit(ctx.lookup(r));
  }
  for (const [r] of ctx.enumerateIndirectObjects()) if (!seen.has(r)) ctx.delete(r);
}

