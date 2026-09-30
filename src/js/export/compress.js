/* =====================================================================
   壓縮 PDF:把解析度超過需要的圖片縮小,重新存成 JPEG
   - 走一遍每頁(含表單 XObject)的內容串流,依 CTM 算出每張圖片在頁面上最大的顯示尺寸,
     顯示解析度超過目標 dpi 的 1.2 倍才縮小;本來就是 JPEG 的圖片,重新壓縮後小 30% 以上也替換
   - 只處理 8 位元 RGB / 灰階的 JPEG(DCTDecode)與 Flate 圖片;CMYK、索引色、色彩鍵遮罩(Mask)、
     JPEG 2000、黑白傳真格式等不動。有透明遮罩(SMask)的圖片只縮小顏色部分,遮罩保留
   - 註解外觀、無法解碼的內容串流裡用到的圖片不動(不知道實際顯示大小)
   - 新的比原本小才替換;文字、向量圖、字型都不變
   ===================================================================== */
const COMPRESS_LEVELS = { high: { dpi: 220, q: 0.85 }, std: { dpi: 150, q: 0.75 }, small: { dpi: 96, q: 0.6 } };

/* 收集內容串流裡 Do 畫出的圖片:uses(ref → 最大顯示寬高,pt);無法解析的部分放進 unsafe */
function imageUsage(lib, bytes, res, ctm, uses, unsafe, depth = 0) {
  const xobjs = dictGet(lib, res, 'XObject');
  if (!xobjs) return;
  if (!bytes) { collectImageRefs(lib, res, unsafe); return; }
  let cur = ctm.slice();
  const stack = [];
  for (const op of lexContent(bytes)) {
    if (op.op === 'q') stack.push(cur.slice());
    else if (op.op === 'Q') cur = stack.pop() || cur;
    else if (op.op === 'cm') cur = mat(nums(op.args), cur);
    else if (op.op === 'Do') {
      const ref = xobjs.get(PDFLib.PDFName.of(op.args[0] && op.args[0].v || '')), x = wmLookup(lib, ref);
      if (!x || !x.dict || !(ref instanceof PDFLib.PDFRef)) continue;
      const sub = nameStr(x.dict.get(PDFLib.PDFName.of('Subtype')));
      if (sub === 'Image') {
        const u = uses.get(ref) || { w: 0, h: 0 };
        uses.set(ref, { w: Math.max(u.w, Math.hypot(cur[0], cur[1])), h: Math.max(u.h, Math.hypot(cur[2], cur[3])) });
      } else if (sub === 'Form') {
        const fres = dictGet(lib, x.dict, 'Resources') || res;
        if (depth >= 8) { collectImageRefs(lib, fres, unsafe); continue; }
        const fm = x.dict.get(PDFLib.PDFName.of('Matrix'));
        const fmat = fm instanceof PDFLib.PDFArray ? fm.asArray().map(v => v.asNumber ? v.asNumber() : 0) : [1, 0, 0, 1, 0, 0];
        imageUsage(lib, wmStreamBytes(x), fres, mat(fmat, cur), uses, unsafe, depth + 1);
      }
    }
  }
}
/* 資源(含其中的表單)用到的所有圖片 */
function collectImageRefs(lib, res, set, depth = 0) {
  const xobjs = dictGet(lib, res, 'XObject');
  if (!xobjs || depth > 8) return;
  for (const [, ref] of xobjs.entries()) {
    const x = wmLookup(lib, ref);
    if (!x || !x.dict) continue;
    const sub = nameStr(x.dict.get(PDFLib.PDFName.of('Subtype')));
    if (sub === 'Image' && ref instanceof PDFLib.PDFRef) set.add(ref);
    else if (sub === 'Form') collectImageRefs(lib, dictGet(lib, x.dict, 'Resources'), set, depth + 1);
  }
}

/* 圖片的壓縮格式清單(依解碼順序);ASCII85、Flate 等一般編碼 pdf-lib 可以解開 */
const GENERIC_FILTERS = new Set(['FlateDecode', 'ASCII85Decode', 'ASCIIHexDecode', 'LZWDecode', 'RunLengthDecode']);
function imageFilters(x) {
  const fl = x.dict.get(PDFLib.PDFName.of('Filter'));
  return !fl ? [] : fl instanceof PDFLib.PDFArray ? fl.asArray().map(nameStr) : [nameStr(fl)];
}

/* 圖片解碼後畫到 tw×th 的 canvas;不支援的格式回傳 null */
async function imageCanvas(lib, x, tw, th) {
  const get = k => wmLookup(lib, x.dict.get(PDFLib.PDFName.of(k)));
  if (get('ImageMask') || get('Mask') || get('Decode') || get('DecodeParms') || numOf(get('BitsPerComponent'), 8) !== 8) return null;
  const cs = get('ColorSpace');
  let n = 0;
  if (cs instanceof PDFLib.PDFName) n = { DeviceRGB: 3, DeviceGray: 1 }[nameStr(cs)] || 0;
  else if (cs instanceof PDFLib.PDFArray && nameStr(cs.get(0)) === 'ICCBased') {
    const icc = wmLookup(lib, cs.get(1));
    n = icc && icc.dict ? numOf(icc.dict.get(PDFLib.PDFName.of('N')), 0) : 0;
  }
  if (n !== 1 && n !== 3) return null;
  const filters = imageFilters(x);
  const W = numOf(get('Width'), 0), H = numOf(get('Height'), 0);
  let src;
  try {
    const pre = filters.slice(0, -1);
    if (filters[filters.length - 1] === 'DCTDecode' && pre.every(f => GENERIC_FILTERS.has(f))) {
      // 前面的 ASCII85 等編碼先解開,只留 JPEG 本身
      let jpg = x.contents;
      if (pre.length) {
        const d = x.dict.clone(lib.context);
        d.set(PDFLib.PDFName.of('Filter'), lib.context.obj(pre));
        jpg = PDFLib.decodePDFRawStream(PDFLib.PDFRawStream.of(d, x.contents)).decode();
      }
      // PDF 閱讀程式不管 JPEG 內的色彩描述檔與 EXIF 方向:原始數值照用,尺寸不符(有轉向)就不處理
      src = await createImageBitmap(new Blob([jpg], { type: 'image/jpeg' }), { colorSpaceConversion: 'none', imageOrientation: 'none' });
    } else if (filters.every(f => GENERIC_FILTERS.has(f))) {
      const raw = filters.length ? PDFLib.decodePDFRawStream(x).decode() : x.contents;
      if (raw.length < W * H * n) return null;
      const id = new ImageData(W, H), d = id.data;
      for (let i = 0, j = 0; i < W * H; i++, j += n) {
        d[i * 4] = raw[j]; d[i * 4 + 1] = raw[j + (n === 3 ? 1 : 0)]; d[i * 4 + 2] = raw[j + (n === 3 ? 2 : 0)]; d[i * 4 + 3] = 255;
      }
      src = await createImageBitmap(id);
    } else return null;
  } catch (_) { return null; }
  if (src.width !== W || src.height !== H) { src.close(); return null; }
  const c = document.createElement('canvas'); c.width = tw; c.height = th;
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, tw, th);
  src.close();
  return { canvas: c, n, cs };
}

/* 無損:拿掉串流最外層的 ASCII85 / ASCIIHex 編碼(只是把二進位轉成文字,多占 25%–100% 空間) */
function stripAsciiFilters(lib) {
  const { PDFRawStream, PDFName, PDFArray } = PDFLib, F = PDFName.of('Filter'), DP = PDFName.of('DecodeParms');
  for (const [ref, x] of lib.context.enumerateIndirectObjects()) {
    if (!(x instanceof PDFRawStream)) continue;
    const filters = imageFilters(x);
    if (filters[0] !== 'ASCII85Decode' && filters[0] !== 'ASCIIHexDecode') continue;
    try {
      const d = x.dict.clone(lib.context), outer = d.clone(lib.context);
      outer.set(F, PDFName.of(filters[0])); outer.delete(DP);
      const body = PDFLib.decodePDFRawStream(PDFRawStream.of(outer, x.contents)).decode();
      const fl = d.get(F), dp = lib.context.lookup(d.get(DP));
      if (filters.length === 1) { d.delete(F); d.delete(DP); }
      else {
        const rest = fl.asArray().slice(1);
        d.set(F, rest.length === 1 ? rest[0] : lib.context.obj(rest));
        if (dp instanceof PDFArray) { const r = dp.asArray().slice(1); if (r.length === 1) d.set(DP, r[0]); else d.set(DP, lib.context.obj(r)); }
      }
      d.delete(PDFName.of('Length'));
      lib.context.assign(ref, PDFRawStream.of(d, body));
    } catch (_) { /* 解不開就保持原樣 */ }
  }
}

/* 回傳 { bytes, count(替換的圖片數) };level 為 COMPRESS_LEVELS 的鍵 */
async function compressPdf(bytes, level, { label = '' } = {}) {
  const { dpi, q } = COMPRESS_LEVELS[level];
  const { PDFDocument, PDFRawStream, PDFName, PDFNumber, PDFArray } = PDFLib;
  const lib = await PDFDocument.load(bytes, { updateMetadata: false });
  const uses = new Map(), unsafe = new Set();
  for (const page of lib.getPages()) {
    const node = page.node, res = wmLookup(lib, node.getInheritableAttribute(PDFName.of('Resources')));
    imageUsage(lib, pageContentBytes(lib, node), res, [1, 0, 0, 1, 0, 0], uses, unsafe);
    // 註解外觀裡的圖片:實際大小要看註解框,保守起見不動
    const annots = wmLookup(lib, node.get(PDFName.of('Annots')));
    for (const a of annots instanceof PDFArray ? annots.asArray() : []) {
      const ap = dictGet(lib, wmLookup(lib, a), 'AP');
      if (!ap) continue;
      for (const [, v] of ap.entries()) {
        const s = wmLookup(lib, v), forms = s && s.dict ? [s] : s && s.entries ? [...s.entries()].map(([, r]) => wmLookup(lib, r)) : [];
        for (const f of forms) if (f && f.dict) collectImageRefs(lib, dictGet(lib, f.dict, 'Resources'), unsafe);
      }
    }
  }
  // 同一個物件可能以不同的 PDFRef 實例出現:用編號比對
  const key = r => r.objectNumber + ' ' + r.generationNumber, bad = new Set([...unsafe].map(key));
  const list = [...uses].filter(([r]) => !bad.has(key(r)));
  let count = 0;
  for (let i = 0; i < list.length; i++) {
    const [ref, u] = list[i];
    busyMsg(`${label}壓縮圖片 ${i + 1} / ${list.length}…`);
    const x = lib.context.lookup(ref);
    if (!(x instanceof PDFRawStream)) continue;
    const W = numOf(x.dict.get(PDFName.of('Width')), 0), H = numOf(x.dict.get(PDFName.of('Height')), 0);
    if (!W || !H || !u.w || !u.h) continue;
    // 縮放比例:兩個方向都達到目標 dpi(維持長寬比);只超過一點點就不縮
    let s = Math.max(u.w / 72 * dpi / W, u.h / 72 * dpi / H);
    const isJpeg = imageFilters(x).pop() === 'DCTDecode';
    if (s > 1 / 1.2) { if (!isJpeg) continue; s = 1; }
    const tw = Math.max(1, Math.round(W * s)), th = Math.max(1, Math.round(H * s));
    const img = await imageCanvas(lib, x, tw, th);
    if (!img) continue;
    const blob = await new Promise(r => img.canvas.toBlob(r, 'image/jpeg', q));
    img.canvas.width = img.canvas.height = 1;
    const jpg = new Uint8Array(await blob.arrayBuffer());
    if (jpg.length >= x.contents.length * (s === 1 ? 0.7 : 0.9)) continue;
    const d = x.dict.clone(lib.context);
    ['DecodeParms', 'Length'].forEach(k => d.delete(PDFName.of(k)));
    d.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
    d.set(PDFName.of('Width'), PDFNumber.of(tw));
    d.set(PDFName.of('Height'), PDFNumber.of(th));
    d.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
    if (img.n === 1) d.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));     // canvas 輸出的 JPEG 一律是彩色
    lib.context.assign(ref, PDFRawStream.of(d, jpg));
    count++;
    if (i % 4 === 3) await raf();
  }
  stripAsciiFilters(lib);
  return { bytes: await lib.save({ updateFieldAppearances: false }), count };
}
