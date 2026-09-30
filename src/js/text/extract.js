/* =====================================================================
   文字擷取:pdf.js 文字層 → 基準座標的文字片段 → 版面分析 → 段落
   - 原始片段依「來源檔:頁索引」快取(不放進 S.pages,undo 快照才不會變大)
   - 塗黑範圍內的片段整段排除(寧可多刪,不可外洩)
   - 使用者加入的文字標註也算頁面內容,一併輸出
   ===================================================================== */
const textCache = new Map();   // "srcId:idx" -> { items, chars, bad, hasImage }

const PUA_RE = /[-�]/g;
const IMAGE_OPS = () => [pdfjsLib.OPS.paintImageXObject, pdfjsLib.OPS.paintInlineImageXObject, pdfjsLib.OPS.paintImageMaskXObject, pdfjsLib.OPS.paintImageXObjectRepeat];

/* 符號字型(Wingdings、Symbol…)沒有 Unicode 對應時,pdf.js 給的是私用區字元 U+F020–F0FF(低位元組 = 字型內的字碼)。
   常見符號換成真正的 Unicode(報告表格的漲跌箭頭、清單符號);沒列出的維持原樣 */
const SYMBOL_FONTS = [
  [/^wingdings3/, { p: '▲', q: '▼' }],
  [/^wingdings2/, {}],
  [/^wingdings/, { l: '●', n: '■', q: '❑', v: '❖', '\xa7': '▪', '\xd8': '➢', '\xfc': '✔' }],
  [/^webdings/, { n: '●', ' ': ' ' }],
  [/^symbol/, { '\xb7': '•', '\xae': '→', '\xac': '←', '\xad': '↑', '\xaf': '↓', '\xb0': '°', '\xb1': '±', '\xb4': '×', '\xb8': '÷',
    '\xa3': '≤', '\xb3': '≥', '\xb9': '≠', '\xbb': '≈', '\xa5': '∞', '\xd6': '√', '\xe5': '∑', a: 'α', b: 'β', p: 'π', m: 'μ', D: 'Δ', W: 'Ω', S: 'Σ', ' ': ' ' }],
];
function symbolMapper(fontName) {
  const key = (fontName || '').replace(/^[A-Z]{6}\+/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const hit = SYMBOL_FONTS.find(([re]) => re.test(key));
  if (!hit) return null;
  return s => s.replace(/[\uF020-\uF0FF]/g, ch => hit[1][String.fromCharCode(ch.charCodeAt(0) - 0xF000)] || ch);
}

/* 外觀相同的部首字元:Chrome 等用 Noto CJK 字型輸出 PDF 時,字型的 cmap 把「文、一、民、長」等同一個字形
   也對到康熙部首(U+2F00–2FD5)或部首補充(U+2E80–2EF3),ToUnicode 常選到部首,擷取出來看起來一樣卻搜尋不到。
   康熙部首用 NFKC 換回一般的字;部首補充沒有標準的正規化,依 Noto Sans CJK TC 裡共用同一個字形的字對照 */
const RADICAL_SUP = new Map(Array.from('⺂⺃⺅⺉⺏⺐⺒⺓⺔⺖⺘⺙⺞⺟⺠⺡⺣⺤⺦⺨⺭⺯⺰⺱⺹⺺⺿⻂⻅⻈⻉⻋⻎⻐⻑⻒⻓⻔⻖⻙⻚⻛⻜⻠⻢⻥⻦⻧⻨⻩⻪⻫⻬⻮⻰⻲')
  .map((c, i) => [c, '乛乚亻刂尣尢巳幺彑忄扌攵歺母民氵灬爫丬犭礻糹纟罓耂肀艹衤见讠贝车辶钅長镸长门阝韦页风飞饣马鱼鸟卤麦黄黾斉齐齿龙亀'[i]]));
const fixRadicals = s => s.replace(/[\u2E80-\u2FDF]/g, c => c >= '\u2F00' ? c.normalize('NFKC') : RADICAL_SUP.get(c) || c);

/* 頁面文字:辨識過的頁面以 OCR 結果為準(ocr/ocr.js),否則是 PDF 本身的文字層 */
async function rawPageText(e) {
  return ocrCache.get(e.src + ':' + e.idx) || pdfRawPageText(e);
}

/* PDF 本身的文字層(不看 OCR 結果) */
async function pdfRawPageText(e) {
  const key = e.src + ':' + e.idx;
  if (textCache.has(key)) return textCache.get(key);
  const page = await sources.get(e.src).doc.getPage(e.idx + 1);
  const vp = page.getViewport({ scale: 1 });   // 基準座標(已含內建 /Rotate)
  const tc = await page.getTextContent();
  // 有私用區字元時才載入字型(跑過 getOperatorList 字型才會出現在 commonObjs),依字型名稱換成符號
  if (tc.items.some(it => /[\uF020-\uF0FF]/.test(it.str))) {
    await page.getOperatorList();
    const maps = new Map();
    for (const it of tc.items) {
      if (!/[\uF020-\uF0FF]/.test(it.str)) continue;
      if (!maps.has(it.fontName)) {
        let f = null;
        try { f = page.commonObjs.get(it.fontName); } catch (_) { /* 字型沒載入就維持原樣 */ }
        maps.set(it.fontName, symbolMapper(f && f.name));
      }
      const m = maps.get(it.fontName);
      if (m) it.str = m(it.str);
    }
  }
  const items = [];
  for (const it of tc.items) {
    if (!it.str) continue;
    it.str = fixRadicals(it.str);
    const t = pdfjsLib.Util.transform(vp.transform, it.transform);
    const size = Math.hypot(t[2], t[3]), len = Math.hypot(t[0], t[1]);
    if (!size || !len) continue;
    const st = tc.styles[it.fontName] || {};
    const asc = st.ascent > 0 ? st.ascent : 0.8, desc = st.descent < 0 ? st.descent : -0.2;
    const ux = t[0] / len, uy = t[1] / len, upx = t[2] / size, upy = t[3] / size;
    // 四個角(基線起點往上 ascent、往下 descent,沿文字方向延伸 width),取外框
    const pts = [];
    for (const k of [asc, desc]) for (const w of [0, it.width]) pts.push([t[4] + upx * k * size + ux * w, t[5] + upy * k * size + uy * w]);
    items.push({
      str: it.str, font: it.fontName, ox: t[4], oy: t[5], ux, uy, size, width: it.width, asc, desc,
      angle: Math.atan2(uy, ux) * 180 / Math.PI, vertical: !!st.vertical,
      box: { x0: Math.min(...pts.map(p => p[0])), y0: Math.min(...pts.map(p => p[1])), x1: Math.max(...pts.map(p => p[0])), y1: Math.max(...pts.map(p => p[1])) }
    });
  }
  const all = items.map(i => i.str).join('').replace(/\s+/g, '');
  const bad = (all.match(PUA_RE) || []).length;
  let hasImage = false;
  if (all.length < 20) {   // 幾乎沒有文字時才檢查有沒有圖片(判斷是否為掃描頁)
    const ops = await page.getOperatorList(), want = new Set(IMAGE_OPS());
    hasImage = ops.fnArray.some(f => want.has(f));
  }
  const res = { items, chars: all.length, bad, hasImage };
  textCache.set(key, res);
  return res;
}

const boxHit = (b, r) => b.x0 < r.x1 && b.x1 > r.x0 && b.y0 < r.y1 && b.y1 > r.y0;

/* 匯出 Word 需要的額外資訊(只有匯出 Word 時才計算):
   - 每個字型的粗體/斜體/字型族(要先跑過 getOperatorList,字型才會載入 commonObjs)
   - 頁面上每張圖片的外框(追蹤繪圖指令的座標轉換,圖片是畫在單位正方形上)
   - 水平/垂直線段(表格框線;細長的填色矩形也算線) */
const richCache = new Map();   // "srcId:idx" -> { fonts: {fontName: style}, images: [box], lines: [{x0,y0,x1,y1}], shapes: [{x0,y0,x1,y1,curves,diag,segs}], fills: [{x0,y0,x1,y1,color}] }
async function richPageInfo(e) {
  const key = e.src + ':' + e.idx;
  if (richCache.has(key)) return richCache.get(key);
  const page = await sources.get(e.src).doc.getPage(e.idx + 1);
  const vp = page.getViewport({ scale: 1 });
  const ops = await page.getOperatorList(), O = pdfjsLib.OPS;
  const paints = new Set(IMAGE_OPS());
  const images = [], lines = [], shapes = [], fills = [], stack = [];
  let ctm = [1, 0, 0, 1, 0, 0], path = null, color = '#000000';   // color:目前的填色(圖樣填色時為 null)
  const toBase = (m, x, y) => vp.convertToViewportPoint(m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]);
  const STROKE = new Set([O.stroke, O.closeStroke, O.fillStroke, O.eoFillStroke, O.closeFillStroke, O.closeEOFillStroke]);
  const FILL = new Set([O.fill, O.eoFill]);
  for (let i = 0; i < ops.fnArray.length; i++) {
    const f = ops.fnArray[i], a = ops.argsArray[i];
    if (f === O.save) stack.push([ctm, color]);
    else if (f === O.restore) [ctm, color] = stack.pop() || [[1, 0, 0, 1, 0, 0], '#000000'];
    else if (f === O.transform) ctm = pdfjsLib.Util.transform(ctm, a);
    else if (f === O.setFillRGBColor) color = pdfjsLib.Util.makeHexColor(a[0], a[1], a[2]);
    else if (f === O.setFillColorN) color = null;
    else if (f === O.paintFormXObjectBegin) { stack.push([ctm, color]); if (Array.isArray(a[0]) && a[0].length === 6) ctm = pdfjsLib.Util.transform(ctm, a[0]); }
    else if (f === O.paintFormXObjectEnd) [ctm, color] = stack.pop() || [[1, 0, 0, 1, 0, 0], '#000000'];
    else if (f === O.constructPath) path = { ops: a[0], args: a[1], m: ctm };
    else if (path && (STROKE.has(f) || FILL.has(f) || f === O.endPath)) {
      // 線段只收前 4000 條(表格用);圖形統計(向量圖偵測)不設限
      if (f !== O.endPath) pathLines(path, STROKE.has(f), toBase, lines.length < 4000 ? lines : [], shapes, e.w * e.h, fills, FILL.has(f) || f === O.fillStroke || f === O.eoFillStroke || f === O.closeFillStroke || f === O.closeEOFillStroke ? color : null);
      path = null;
    }
    else if (paints.has(f)) {
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => vp.convertToViewportPoint(ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]));
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      const box = { x0: Math.max(0, Math.min(...xs)), y0: Math.max(0, Math.min(...ys)), x1: Math.min(e.w, Math.max(...xs)), y1: Math.min(e.h, Math.max(...ys)) };
      if (box.x1 - box.x0 >= 1 && box.y1 - box.y0 >= 1) images.push(box);
    }
  }
  const fonts = {};
  for (const it of (await rawPageText(e)).items) {
    if (fonts[it.font] !== undefined) continue;
    let f = null;
    try { f = page.commonObjs.get(it.font); } catch (_) { /* 字型尚未載入時就用預設值 */ }
    const name = (f && f.name || '').replace(/^[A-Z]{6}\+/, '');
    fonts[it.font] = {
      name, bold: !!(f && (f.bold || f.black)) || /bold|black|heavy|semibold|W[6-9]\b/i.test(name), italic: !!(f && f.italic) || /italic|oblique/i.test(name),
      serif: /times|serif|ming|sung|song|明|宋|mincho|georgia|garamond/i.test(name) && !/sans/i.test(name), kai: /kai|楷/i.test(name)
    };
  }
  const res = { fonts, images, lines, shapes, fills };
  richCache.set(key, res);
  return res;
}

/* 路徑 → 線段(基準座標)。描邊:直線段與矩形四邊;填色:細長矩形當成一條線(常用來畫表格框線),
   其他填色矩形(例如每格各自上底色的表格)取四邊。
   同時統計這個圖形的曲線數、斜線數與外框,放進 shapes,給「向量圖」偵測使用;
   填色矩形(不含整頁背景)連同顏色放進 fills,給表格儲存格底色使用 */
function pathLines(path, stroked, toBase, out, shapes, pageArea, fills, fillColor) {
  const O = pdfjsLib.OPS, { ops, args, m } = path;
  let k = 0, cx = 0, cy = 0, sx = 0, sy = 0, curves = 0, diag = 0, segs = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, sub = [], subCurve = false;
  const subs = [];
  const pt = (x, y) => { const p = toBase(m, x, y); if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; return p; };
  const seg = (x0, y0, x1, y1) => { const p = toBase(m, x0, y0), q = toBase(m, x1, y1); out.push({ x0: p[0], y0: p[1], x1: q[0], y1: q[1] }); };
  const rectOut = (p, q) => {   // p、q:基準座標的對角
    const bw = Math.abs(q[0] - p[0]), bh = Math.abs(q[1] - p[1]);
    const X0 = Math.min(p[0], q[0]), X1 = Math.max(p[0], q[0]), Y0 = Math.min(p[1], q[1]), Y1 = Math.max(p[1], q[1]);
    if (stroked) out.push({ x0: X0, y0: Y0, x1: X1, y1: Y0 }, { x0: X1, y0: Y0, x1: X1, y1: Y1 }, { x0: X0, y0: Y1, x1: X1, y1: Y1 }, { x0: X0, y0: Y0, x1: X0, y1: Y1 });
    if (fillColor && fills && bw >= 3 && bh >= 3 && bw * bh < 0.5 * pageArea && fills.length < 2000) fills.push({ x0: X0, y0: Y0, x1: X1, y1: Y1, color: fillColor });
    if (stroked) return;
    if (bh <= 3 && bw >= 8) out.push({ x0: X0, y0: (Y0 + Y1) / 2, x1: X1, y1: (Y0 + Y1) / 2 });
    else if (bw <= 3 && bh >= 8) out.push({ x0: (X0 + X1) / 2, y0: Y0, x1: (X0 + X1) / 2, y1: Y1 });
    else if (bw >= 8 && bh >= 8 && bw * bh < 0.5 * pageArea) out.push({ x0: X0, y0: Y0, x1: X1, y1: Y0 }, { x0: X1, y0: Y0, x1: X1, y1: Y1 }, { x0: X0, y0: Y1, x1: X1, y1: Y1 }, { x0: X0, y0: Y0, x1: X0, y1: Y1 });
  };
  const closeSub = () => { if (sub.length && !subCurve) subs.push(sub); sub = []; subCurve = false; };   // 含曲線的子路徑不會是矩形
  for (const op of ops) {
    if (op === O.moveTo) { closeSub(); cx = sx = args[k++]; cy = sy = args[k++]; sub.push(pt(cx, cy)); }
    else if (op === O.lineTo) {
      const x = args[k++], y = args[k++], p = toBase(m, cx, cy), q = pt(x, y);
      segs++;
      if (Math.abs(q[0] - p[0]) > 0.5 && Math.abs(q[1] - p[1]) > 0.5) diag++;
      if (stroked) seg(cx, cy, x, y);
      sub.push(q); cx = x; cy = y;
    }
    else if (op === O.rectangle) {
      closeSub();
      const x = args[k++], y = args[k++], w = args[k++], h = args[k++];
      rectOut(pt(x, y), pt(x + w, y + h)); pt(x + w, y); pt(x, y + h);
      segs += 4; cx = sx = x; cy = sy = y;
    }
    else if (op === O.curveTo) { pt(args[k], args[k + 1]); pt(args[k + 2], args[k + 3]); k += 4; cx = args[k++]; cy = args[k++]; pt(cx, cy); curves++; segs++; subCurve = true; }
    else if (op === O.curveTo2 || op === O.curveTo3) { pt(args[k], args[k + 1]); k += 2; cx = args[k++]; cy = args[k++]; pt(cx, cy); curves++; segs++; subCurve = true; }
    else if (op === O.closePath) { if (stroked && (cx !== sx || cy !== sy)) seg(cx, cy, sx, sy); sub.push(toBase(m, sx, sy)); cx = sx; cy = sy; }
  }
  closeSub();
  // 填色的封閉多邊形剛好是水平/垂直的矩形(有些 PDF 用 m/l/l/l/h 畫格子底色,而不是 re)
  if (!stroked || fillColor) for (const q of subs) {
    const pts = q.filter((p, i) => !i || Math.abs(p[0] - q[i - 1][0]) > 0.1 || Math.abs(p[1] - q[i - 1][1]) > 0.1);
    if (pts.length > 1 && Math.abs(pts[0][0] - pts[pts.length - 1][0]) < 0.1 && Math.abs(pts[0][1] - pts[pts.length - 1][1]) < 0.1) pts.pop();
    if (pts.length !== 4) continue;
    const axis = pts.every((p, i) => { const r = pts[(i + 1) % 4]; return Math.abs(p[0] - r[0]) < 0.1 || Math.abs(p[1] - r[1]) < 0.1; });
    if (axis) rectOut(pts[0], pts[2]);
  }
  if (shapes && x1 >= x0 && shapes.length < 5000) shapes.push({ x0, y0, x1, y1, curves, diag, segs });
}

/* 使用者的文字標註 → 片段(水平、基準座標) */
function annTextItems(e) {
  const out = [];
  e.anns.forEach((a, i) => {
    if (a.type !== 'text') return;
    const box = { x0: a.x, y0: a.y, x1: a.x + a.w, y1: a.y + a.h };
    // 在它之後才畫的塗黑框會蓋住它(與編輯畫面一致),就不輸出;之後的改字框蓋住它的中心也一樣
    if (e.anns.slice(i + 1).some(r => r.type === 'redact' && boxHit(box, redactBox(r)))) return;
    const cx = a.x + a.w / 2, cy = a.y + a.h / 2;
    if (e.anns.slice(i + 1).some(r => r.type === 'erase' && cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h)) return;
    const rows = a.text.split('\n'), lh = a.h / rows.length;
    rows.forEach((s, k) => {
      if (!s.trim()) return;
      const w = a.w, size = Math.min(a.size, lh);
      out.push({ str: s, ox: a.x, oy: a.y + lh * (k + 0.8), ux: 1, uy: 0, size, width: w, asc: 0.8, desc: -0.2, angle: 0, vertical: false,
        box: { x0: a.x, y0: a.y + lh * k, x1: a.x + w, y1: a.y + lh * (k + 1) } });
    });
  });
  return out;
}
const redactBox = r => ({ x0: r.x - 0.5, y0: r.y - 0.5, x1: r.x + r.w + 0.5, y1: r.y + r.h + 0.5 });

/* 片段裡每個字的位置(沿文字方向,0–1 的比例):pdf.js 只給整段寬度,依一般字型的字寬比例分配 */
const charMeasure = document.createElement('canvas').getContext('2d');
function itemChars(it) {
  const chars = Array.from(it.str);
  charMeasure.font = '100px sans-serif';
  const ws = chars.map(ch => Math.max(1, charMeasure.measureText(ch).width)), sum = ws.reduce((s, w) => s + w, 0);
  let acc = 0;
  return chars.map((ch, i) => { const t0 = acc / sum; acc += ws[i]; return { ch, t0, t1: acc / sum }; });
}
/* 片段的一部分(字元 i0–i1,chars 為 itemChars 的結果)→ 新的片段 */
function subItem(it, chars, i0, i1) {
  const a = chars[i0].t0 * it.width, w = (chars[i1 - 1].t1 - chars[i0].t0) * it.width;
  const ox = it.ox + it.ux * a, oy = it.oy + it.uy * a, upx = it.uy, upy = -it.ux, pts = [];
  for (const k of [it.asc, it.desc]) for (const d of [0, w]) pts.push([ox + upx * k * it.size + it.ux * d, oy + upy * k * it.size + it.uy * d]);
  return { ...it, str: chars.slice(i0, i1).map(c => c.ch).join(''), ox, oy, width: w,
    box: { x0: Math.min(...pts.map(p => p[0])), y0: Math.min(...pts.map(p => p[1])), x1: Math.max(...pts.map(p => p[0])), y1: Math.max(...pts.map(p => p[1])) } };
}
/* 字元中心(基準座標) */
function charCenter(it, c) {
  const d = (c.t0 + c.t1) / 2 * it.width, k = (it.asc + it.desc) / 2 * it.size;
  return [it.ox + it.ux * d + it.uy * k, it.oy + it.uy * d - it.ux * k];
}
/* 改字框:原本的文字在框內的字元不再輸出(匯出 PDF 時從檔案刪除,見 edit/retext.js),
   擷取文字、選取文字、隱形文字層都用這裡排除;片段只有一部分在框內時切開,其餘留下 */
const eraseBoxes = e => e.anns.filter(a => a.type === 'erase').map(a => ({ x0: a.x, y0: a.y, x1: a.x + a.w, y1: a.y + a.h }));
function eraseItems(items, e) {
  const boxes = eraseBoxes(e);
  if (!boxes.length) return items;
  const inBox = p => boxes.some(b => p[0] >= b.x0 && p[0] <= b.x1 && p[1] >= b.y0 && p[1] <= b.y1);
  const out = [];
  for (const it of items) {
    if (!boxes.some(b => boxHit(it.box, b))) { out.push(it); continue; }
    const chars = itemChars(it), keep = chars.map(c => !inBox(charCenter(it, c)));
    if (keep.every(Boolean)) { out.push(it); continue; }
    for (let i = 0; i < chars.length;) {
      if (!keep[i]) { i++; continue; }
      let j = i; while (j < chars.length && keep[j]) j++;
      const part = subItem(it, chars, i, j);
      if (part.str.trim()) out.push(part);
      i = j;
    }
  }
  return out;
}

/* 片段 → 以主要文字方向為 +x 的座標系,交給 layoutText */
function layoutPageItems(items, e, segs = [], fills = []) {
  if (!items.length) return [];
  // 主要方向:依字數加權,取最常見的角度(接近 90° 倍數時對齊)
  const votes = new Map();
  for (const it of items) {
    let a = Math.round(it.angle);
    const snap = Math.round(a / 90) * 90; if (Math.abs(a - snap) <= 3) a = snap;
    votes.set(a, (votes.get(a) || 0) + it.str.length);
  }
  const main = [...votes].sort((p, q) => q[1] - p[1])[0][0];
  const rad = main * Math.PI / 180, c = Math.cos(rad), s = Math.sin(rad);
  const rot = (x, y) => [x * c + y * s, -x * s + y * c];
  const frame = [], other = [];
  for (const it of items) {
    let d = Math.abs(it.angle - main) % 360; if (d > 180) d = 360 - d;
    const [x, y] = rot(it.ox, it.oy);
    const f = { str: it.str, x, y, w: it.width, size: it.size, top: y - it.asc * it.size, bottom: y - it.desc * it.size, ref: it };
    (d <= 10 && !it.vertical ? frame : other).push(f);
  }
  const corners = [[0, 0], [e.w, 0], [0, e.h], [e.w, e.h]].map(p => rot(p[0], p[1])[0]);
  const minX = Math.min(...corners), maxX = Math.max(...corners);
  // 表格先拿出來,剩下的文字照常分段;表格再依位置插回段落之間
  const fsegs = segs.map(g => { const [x0, y0] = rot(g.x0, g.y0), [x1, y1] = rot(g.x1, g.y1); return { x0, y0, x1, y1 }; });
  const ffills = fills.map(g => { const [ax, ay] = rot(g.x0, g.y0), [bx, by] = rot(g.x1, g.y1); return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by), color: g.color }; });
  const { tables, rest: textRest } = detectTables(frame, fsegs, minX, maxX);
  const rest = textRest.concat(frame.filter(f => !f.str.trim()));   // 空白片段交回版面分析(會被略過)
  const paras = layoutText(rest, minX, maxX);
  for (const t of tables.sort((a, b) => a.top - b.top)) {
    for (const row of t.rows) for (const cell of row) {
      if (!cell || cell.hidden) continue;
      // 有框線才知道格子真正的右界(右框線往內縮與左側相同的內距);無框線的欄寬只是文字範圍,不判斷
      const k = t.cols[row.indexOf(cell) + (cell.colspan || 1) - 1], lx = cell.items.length ? Math.min(...cell.items.map(i => i.x)) : 0;
      const cellRight = t.ruled ? k.b - Math.max(1, lx - t.cols[row.indexOf(cell)].a) : null;
      cell.paras = cell.items.length ? layoutText(cell.items, 0, 0, { cell: true, cellRight }) : [];
      cell.text = cell.paras.map(p => p.text).join(' ');
      // 底色:最後畫、蓋住整格的填色矩形(白色 = 沒有底色)
      if (t.ruled && t.ys) {
        const ci = row.indexOf(cell), ri = t.rows.indexOf(row);
        const bx0 = t.cols[ci].a, bx1 = t.cols[ci + (cell.colspan || 1) - 1].b, by0 = t.ys[ri], by1 = t.ys[ri + (cell.rowspan || 1)], tol = 2;
        const f = ffills.filter(g => g.x0 <= bx0 + tol && g.x1 >= bx1 - tol && g.y0 <= by0 + tol && g.y1 >= by1 - tol).pop();
        if (f && f.color.toLowerCase() !== '#ffffff') cell.fill = f.color.slice(1).toUpperCase();
      }
      // 置中:每一行的中心都在格子中間,且不是貼齊左邊
      if (t.ruled && cell.paras.length) {
        const c0 = t.cols[row.indexOf(cell)], c1 = t.cols[row.indexOf(cell) + (cell.colspan || 1) - 1];
        const mid = (c0.a + c1.b) / 2, lns = cell.paras.flatMap(p => p.lines);
        const centered = lns.every(l => Math.abs((l.x + l.right) / 2 - mid) < Math.max(3, 0.06 * (c1.b - c0.a)));
        if (centered && lns.some(l => l.x - c0.a > 8)) cell.align = 'center';
      }
    }
    const text = t.rows.map(r => r.map(c => c && !c.hidden ? c.text : '').join('\t')).join('\n');
    const paraTop = p => p.lines.length ? Math.min(...p.lines[0].items.map(i => i.top)) : Infinity;
    const overlaps = p => p.lines.length && p.lines.some(l => l.items.some(i => i.x < t.right && i.x + i.w > t.left));
    let at = 0;
    paras.forEach((p, k) => { if (!p.table && paraTop(p) <= t.top && overlaps(p)) at = k + 1; else if (p.table && p.table.top <= t.top) at = k + 1; });
    paras.splice(at, 0, { table: t, text, lines: [] });
  }
  // 其他方向的文字(例如側邊直排的標註)各自成段,接在後面
  for (const f of other) if (f.str.trim()) paras.push({ lines: [{ items: [f], text: f.str.trim() }], text: f.str.trim() });
  return paras;
}

/* 片段依閱讀順序分行:[[片段…], …](選取文字的透明文字層、可搜尋 PDF 的隱形文字層共用)
   PDF 內部的繪製順序常與閱讀順序不同,依版面分析(含多欄、表格)重排;沒排進任何一行的片段各自一行放在最後 */
function readingOrderLines(items, e, segs) {
  const lines = [], seen = new Set();
  const take = ln => {
    const row = [];
    ln.items.forEach(f => { if (f.ref && !seen.has(f.ref)) { seen.add(f.ref); row.push(f.ref); } });
    if (row.length) lines.push(row);
  };
  for (const p of layoutPageItems(items, e, segs)) {
    if (p.table) p.table.rows.forEach(row => row.forEach(c => c && c.paras && c.paras.forEach(q => q.lines.forEach(take))));
    else p.lines.forEach(take);
  }
  for (const it of items) if (!seen.has(it)) lines.push([it]);
  return lines;
}

/* 單頁結果:{ text, chars, flags: ['scan' | 'blank' | 'garbled' | 'redacted' | 'ocr'] }(exclude 見下方) */
async function pageText(e, { includeAnns = true, exclude = [] } = {}) {
  const raw = await rawPageText(e);
  const reds = e.anns.filter(a => a.type === 'redact').map(redactBox);
  const kept = raw.items.filter(it => !reds.some(r => boxHit(it.box, r)));
  const shown = eraseItems(kept, e);
  // exclude:這些範圍(例如匯出成圖片的向量圖)裡的文字不列入段落
  const inside = it => { const x = (it.box.x0 + it.box.x1) / 2, y = (it.box.y0 + it.box.y1) / 2; return exclude.some(b => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1); };
  const items = (includeAnns ? shown.concat(annTextItems(e)) : shown).filter(it => !exclude.length || !inside(it));
  const rich = await richPageInfo(e);
  const paras = layoutPageItems(items, e, rich.lines, rich.fills);
  const flags = [];
  if (raw.chars < 20 && raw.hasImage) flags.push('scan');
  else if (!raw.chars && !paras.length) flags.push('blank');
  if (raw.chars >= 10 && raw.bad / raw.chars > 0.3) flags.push('garbled');
  if (kept.length < raw.items.length) flags.push('redacted');
  if (raw.ocr) flags.push('ocr');
  return { text: paras.map(p => p.text).join('\n\n'), paras, chars: raw.chars, flags };
}

/* 多頁:回傳整份文字與提醒 */
async function extractText(list, { separators = true, includeAnns = true, onProgress } = {}) {
  const parts = [], notes = { scan: [], garbled: [], redacted: false };
  for (let i = 0; i < list.length; i++) {
    const e = list[i], n = S.pages.indexOf(e) + 1;
    if (onProgress) onProgress(i + 1, list.length);
    const r = await pageText(e, { includeAnns });
    if (r.flags.includes('scan')) notes.scan.push(n);
    if (r.flags.includes('garbled')) notes.garbled.push(n);
    if (r.flags.includes('redacted')) notes.redacted = true;
    if (separators) parts.push(`=== 第 ${n} 頁 ===\n` + r.text);
    else if (r.text) parts.push(r.text);
  }
  return { text: parts.join('\n\n').trim(), notes };
}
