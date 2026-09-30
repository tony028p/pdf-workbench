/* =====================================================================
   文件模型:把頁面分析成中性的「區塊」清單,給 Word / Markdown / HTML 匯出共用
   - 段落:沿用文字擷取的版面分析,加上字型樣式、標題層級、清單、置中
   - 圖片:從「依序燒入所有標註(含塗黑框)」的頁面圖裁切(塗黑一定套用)
   - 重複的頁首頁尾與頁碼移出內文
   ===================================================================== */
/* 頁碼:先去掉標點與空白(| 3、— 3 —、第 3 頁,共 10 頁、Page 3 of 10…)再比對 */
const isPageNumber = k => /^(第)?(page)?#((of|頁共|共)#)?(頁)?$/i.test(k.replace(/[^\p{L}\p{N}#]/gu, ''));

const halfPt = size => Math.max(2, Math.round(size * 2));
/* 深色底(例如表頭)上的字原本幾乎都是白色;文字顏色沒有擷取,依底色亮度決定用白字 */
const darkFill = hex => !!hex && (0.299 * parseInt(hex.slice(0, 2), 16) + 0.587 * parseInt(hex.slice(2, 4), 16) + 0.114 * parseInt(hex.slice(4, 6), 16)) / 255 < 0.55;

/* 段落 → 帶樣式的文字片段(換行與行內空格的規則與 layout.js 相同) */
function paraSegments(para, fonts) {
  const segs = [];
  const styleOf = f => ({ ...(fonts[f.ref && f.ref.font] || {}), size: f.size });
  para.lines.forEach((ln, li) => {
    ln.items.forEach((f, i) => {
      let s = (i ? joinInline(ln.items[i - 1], f) : '') + f.str;
      if (i === 0) s = s.replace(/^\s+/, '');
      if (i === 0 && li > 0 && segs.length) {
        const last = segs[segs.length - 1], prev = last.text;
        if (/[A-Za-z]-$/.test(prev) && /^[a-z]/.test(s)) last.text = prev.slice(0, -1);
        else if (!(isCJK(prev[prev.length - 1]) || isCJK(s[0]))) s = ' ' + s;
      }
      segs.push({ text: s, st: styleOf(f) });
    });
  });
  if (segs.length) segs[segs.length - 1].text = segs[segs.length - 1].text.replace(/\s+$/, '');
  return segs.filter(s => s.text);
}
const paraBox = para => {
  const bs = para.lines.flatMap(l => l.items).map(f => f.ref && f.ref.box).filter(Boolean);
  if (!bs.length) return null;
  return { x0: Math.min(...bs.map(b => b.x0)), y0: Math.min(...bs.map(b => b.y0)), x1: Math.max(...bs.map(b => b.x1)), y1: Math.max(...bs.map(b => b.y1)) };
};
const paraSize = segs => {
  const w = new Map();
  for (const s of segs) { const k = halfPt(s.st.size); w.set(k, (w.get(k) || 0) + s.text.length); }
  return [...w].sort((a, b) => b[1] - a[1])[0][0];
};

/* 基準座標的外框 → 顯示方向(含使用者旋轉)的外框,單位 pt */
function dispBox(e, b) {
  const pts = [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]].map(([x, y]) => baseToDisp(x, y, e));
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/* 頁面上的圖片區域(PDF 內的圖片 + 使用者放的圖片/簽名 + 向量圖),重疊的合併;整頁大小的只在掃描頁保留 */
function pageImageBoxes(e, rich, scan, figs = []) {
  const area = b => (b.x1 - b.x0) * (b.y1 - b.y0), full = e.w * e.h;
  let boxes = rich.images.concat(e.anns.filter(a => a.type === 'img').map(a => ({ x0: a.x, y0: a.y, x1: a.x + a.w, y1: a.y + a.h })), figs)
    .filter(b => b.x1 - b.x0 >= 16 && b.y1 - b.y0 >= 16);
  if (scan) return [{ x0: 0, y0: 0, x1: e.w, y1: e.h }];
  boxes = boxes.filter(b => area(b) < 0.85 * full);   // 滿版背景圖略過
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      if (boxHit(boxes[i], boxes[j])) {
        const a = boxes[i], b = boxes[j];
        boxes[i] = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
        boxes.splice(j, 1); merged = true; break outer;
      }
    }
  }
  return boxes.sort((a, b) => a.y0 - b.y0);
}

/* 向量圖(折線圖、散佈圖、圖示…):PDF 用繪圖指令畫的圖不是圖片物件,不處理的話圖會消失、圖上的標籤散成段落。
   相鄰的圖形聚成一群;含曲線、斜線或很長的折線,且夠大的群 → 圖。
   表格、底色方塊、框線只有水平/垂直的直線,不會被當成圖。
   圖上的文字(標籤、座標軸)併入圖的範圍,匯出時從內文移除,只出現在裁切的圖片裡 */
function pageFigures(e, rich, items) {
  const area = b => (b.x1 - b.x0) * (b.y1 - b.y0), full = e.w * e.h, GAP = 4;
  const shapes = rich.shapes.filter(s => area(s) < 0.85 * full && s.x1 - s.x0 < 0.98 * e.w);
  const n = shapes.length, par = [...Array(n).keys()], find = i => par[i] === i ? i : (par[i] = find(par[i]));
  const near = (a, b) => a.x0 - GAP < b.x1 && b.x0 - GAP < a.x1 && a.y0 - GAP < b.y1 && b.y0 - GAP < a.y1;
  const order = [...Array(n).keys()].sort((i, j) => shapes[i].x0 - shapes[j].x0);
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
    const i = order[a], j = order[b];
    if (shapes[j].x0 - GAP >= shapes[i].x1) break;   // 依 x0 排序,之後的都更右邊
    if (near(shapes[i], shapes[j])) par[find(i)] = find(j);
  }
  const groups = new Map();
  shapes.forEach((s, i) => {
    const r = find(i), g = groups.get(r) || { x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1, curves: 0, diag: 0, maxSegs: 0 };
    g.x0 = Math.min(g.x0, s.x0); g.y0 = Math.min(g.y0, s.y0); g.x1 = Math.max(g.x1, s.x1); g.y1 = Math.max(g.y1, s.y1);
    g.curves += s.curves; g.diag += s.diag; g.maxSegs = Math.max(g.maxSegs, s.segs);
    groups.set(r, g);
  });
  const figs = [];
  for (const g of groups.values()) {
    if (g.x1 - g.x0 < 60 || g.y1 - g.y0 < 40) continue;
    if (!(g.curves >= 12 || g.diag >= 4 || g.maxSegs >= 40)) continue;
    // 裡面大多是長句子 → 是有圓角外框的文字方塊,不是圖
    const inside = items.filter(it => boxHit(it.box, g) && it.str.trim());
    const chars = inside.reduce((s, it) => s + it.str.trim().length, 0), prose = inside.filter(it => it.str.trim().length >= 50).reduce((s, it) => s + it.str.trim().length, 0);
    if (chars && prose > 0.5 * chars) continue;
    // 大半在圖內的文字(標籤、座標軸刻度)算圖的一部分,範圍擴大到包住它們
    const b = { x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1 };
    for (const it of inside) {
      const ib = it.box, ov = (Math.min(ib.x1, g.x1) - Math.max(ib.x0, g.x0)) * (Math.min(ib.y1, g.y1) - Math.max(ib.y0, g.y0));
      if (ov >= 0.5 * area(ib)) { b.x0 = Math.min(b.x0, ib.x0); b.y0 = Math.min(b.y0, ib.y0); b.x1 = Math.max(b.x1, ib.x1); b.y1 = Math.max(b.y1, ib.y1); }
    }
    const f = { x0: Math.max(0, b.x0 - 2), y0: Math.max(0, b.y0 - 2), x1: Math.min(e.w, b.x1 + 2), y1: Math.min(e.h, b.y1 + 2) };
    // 圖外的文字(中心不在圖內,匯出時留在內文)只擦到邊 → 圖的範圍往內收,圖片才不會切到半行字
    for (const it of items) {
      const ib = it.box, cx = (ib.x0 + ib.x1) / 2, cy = (ib.y0 + ib.y1) / 2;
      if (!it.str.trim() || !boxHit(ib, f) || (cx >= f.x0 && cx <= f.x1 && cy >= f.y0 && cy <= f.y1)) continue;
      if (cy > f.y1 && ib.y0 > f.y1 - 8) f.y1 = ib.y0;
      else if (cy < f.y0 && ib.y1 < f.y0 + 8) f.y0 = ib.y1;
      else if (cx > f.x1 && ib.x0 > f.x1 - 8) f.x1 = ib.x0;
      else if (cx < f.x0 && ib.x1 < f.x0 + 8) f.x0 = ib.x1;
    }
    figs.push(f);
  }
  return figs;
}

function cropJpeg(r, e, b) {
  const d = dispBox(e, b), s = r.scale;
  const x = Math.max(0, Math.floor(d.x0 * s)), y = Math.max(0, Math.floor(d.y0 * s));
  const w = Math.min(r.canvas.width - x, Math.ceil((d.x1 - d.x0) * s)), h = Math.min(r.canvas.height - y, Math.ceil((d.y1 - d.y0) * s));
  const c = document.createElement('canvas'); c.width = Math.max(1, w); c.height = Math.max(1, h);
  c.getContext('2d').drawImage(r.canvas, x, y, w, h, 0, 0, w, h);
  return { bytes: dataUrlToU8(c.toDataURL('image/jpeg', 0.9)), w: d.x1 - d.x0, h: d.y1 - d.y0 };
}

/* 表格 → 文件模型:每格的段落轉成帶樣式的片段;欄寬(pt)、對齊、縮排、合併儲存格
   cells[r][c]:{ paras:[segs], colspan, rowspan, indent, fill(底色 RRGGBB,可省略) } | { hidden, ownerR, ownerC } | { empty } */
function tableEntry(p, fonts) {
  const t = p.table, refs = [];
  const cells = t.rows.map(row => row.map((cell, c) => {
    if (!cell) return { empty: true };
    if (cell.hidden) return { hidden: true, ownerR: cell.owner.r, ownerC: cell.owner.c };
    cell.items.forEach(i => i.ref && refs.push(i.ref.box));
    const col = t.cols[c], indent = !t.ruled && col.align === 'left' && cell.left - col.a > 2 ? cell.left - col.a : 0;
    return { paras: (cell.paras || []).map(q => paraSegments(q, fonts)).filter(s => s.length), colspan: cell.colspan || 1, rowspan: cell.rowspan || 1, indent, align: cell.align || col.align, fill: cell.fill };
  }));
  const box = refs.length ? { x0: Math.min(...refs.map(b => b.x0)), y0: Math.min(...refs.map(b => b.y0)), x1: Math.max(...refs.map(b => b.x1)), y1: Math.max(...refs.map(b => b.y1)) } : null;
  // 欄寬:有框線 = 框線間距;無框線 = 欄與欄之間的空白平分給兩邊(靠右的頁碼欄才不會太窄而斷行),最後一欄多留內距
  const edges = t.cols.map((k, i) => t.ruled ? k.a : i === 0 ? k.a : (t.cols[i - 1].b + k.a) / 2);
  edges.push(t.ruled ? t.cols[t.cols.length - 1].b : t.cols[t.cols.length - 1].b + 12);
  const cols = t.cols.map((k, i) => ({ w: Math.max(edges[i + 1] - edges[i], 18), align: k.align }));
  return { table: { ruled: t.ruled, cols, cells }, text: p.text, box };
}

/* 圖片放在哪裡:同一欄(水平重疊)上方最近的段落之後;上方沒有就放在同一欄下方 100pt 內最近的段落之前
   (例如照片在人名上方);都沒有就放在垂直距離最近的段落旁 */
function imageSlot(blocks, b) {
  const cands = blocks.map((s, j) => ({ s, j })).filter(({ s }) => s.type !== 'img' && s.box);
  const overlapX = s => s.box.x0 < b.x1 && s.box.x1 > b.x0;
  const above = cands.filter(({ s }) => overlapX(s) && s.box.y0 <= b.y0).sort((p, q) => q.s.box.y1 - p.s.box.y1)[0];
  if (above) return above.j + 1;
  const below = cands.filter(({ s }) => overlapX(s) && s.box.y0 > b.y0 && s.box.y0 - b.y1 < 100).sort((p, q) => p.s.box.y0 - q.s.box.y0)[0];
  if (below) return below.j;
  const dist = s => Math.max(0, s.box.y0 - b.y1, b.y0 - s.box.y1);
  const near = cands.sort((p, q) => dist(p.s) - dist(q.s))[0];
  return near ? (near.s.box.y0 <= b.y0 ? near.j + 1 : near.j) : 0;
}

/* 分析整份文件。回傳:
   { pages: [{ e, dw, dh, margins:[上,右,下,左], contentW, contentH, blocks }], bodySz, levelSz, pageNumbers }
   blocks 依閱讀順序:{ type:'p', segs, text, level(0–3), list, center, sz }
                   或 { type:'img', bytes(JPEG), w, h(顯示大小 pt), center, indent(pt) }
                   或 { type:'table', ruled, cols:[{w, align}], cells(見 tableEntry) } */
async function analyzeDocument(list, { onProgress } = {}) {
  // 1) 每頁:段落、字型、圖片區域
  const pages = [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (onProgress) onProgress(`分析版面 ${i + 1} / ${list.length}…`);
    const rich = await richPageInfo(e), figs = pageFigures(e, rich, (await rawPageText(e)).items);
    const pt = await pageText(e, { exclude: figs });   // 圖上的文字只留在圖片裡
    const paras = pt.paras.map(p => {
      if (p.table) return tableEntry(p, rich.fonts);
      const segs = paraSegments(p, rich.fonts);
      return segs.length ? { segs, text: segs.map(s => s.text).join(''), box: paraBox(p), lines: p.lines.length } : null;
    }).filter(Boolean);
    pages.push({ e, paras, rich, figs, scan: pt.flags.includes('scan') });
  }
  // 2) 重複的頁首頁尾、頁碼 → 移出內文
  const band = (e, b) => !b ? null : b.y1 < 0.09 * e.h ? 'top' : b.y0 > 0.91 * e.h ? 'bottom' : null;
  const keyOf = t => t.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  const counts = new Map();
  for (const pg of pages) {
    const seen = new Set();
    for (const p of pg.paras) { if (p.table) continue; const bd = band(pg.e, p.box); if (bd) seen.add(bd + '|' + keyOf(p.text)); }
    for (const k of seen) counts.set(k, (counts.get(k) || 0) + 1);
  }
  let pageNumbers = false;
  for (const pg of pages) {
    pg.paras = pg.paras.filter(p => {
      if (p.table) return true;
      const bd = band(pg.e, p.box); if (!bd) return true;
      const k = keyOf(p.text);
      if (isPageNumber(k)) { pageNumbers = true; return false; }
      return !(pages.length >= 2 && counts.get(bd + '|' + k) >= Math.max(2, Math.ceil(pages.length / 2)));
    });
  }
  // 3) 內文字級(依字數最多的字級;每個來源檔各自計算,合併不同文件時才不會互相影響)與標題層級
  const mode = pairs => { const w = new Map(); for (const [k, n] of pairs) w.set(k, (w.get(k) || 0) + n); return w.size ? [...w].sort((a, b) => b[1] - a[1])[0][0] : 24; };
  for (const pg of pages) for (const p of pg.paras) if (!p.table) p.sz = paraSize(p.segs);
  const all = pages.flatMap(pg => pg.paras.filter(p => !p.table).map(p => ({ p, src: pg.e.src })));
  const bodySz = mode(all.map(({ p }) => [p.sz, p.text.length]));
  const bodyOf = new Map([...new Set(all.map(a => a.src))].map(src => [src, mode(all.filter(a => a.src === src).map(({ p }) => [p.sz, p.text.length]))]));
  // 標題:比該檔內文大 25% 以上、最多 3 行、不以句末標點結尾(標題很少用句號結尾)
  const headingLike = p => p.text.length <= 120 && p.lines <= 3 && !/[。！？.!?；;]$/.test(p.text);
  for (const a of all) a.big = a.p.sz >= bodyOf.get(a.src) * 1.25 && headingLike(a.p);
  const bigSizes = [...new Set(all.filter(a => a.big).map(a => a.p.sz))].sort((x, y) => y - x);
  for (const { p, src, big } of all) {
    const allBold = p.segs.every(g => g.st.bold);
    if (big) p.level = Math.min(3, bigSizes.indexOf(p.sz) + 1);
    else if (allBold && p.text.length <= 60 && p.lines === 1 && headingLike(p) && p.sz >= bodyOf.get(src)) p.level = Math.min(3, bigSizes.length + 1);
    else p.level = 0;
    p.list = !p.level && LIST_RE.test(p.text);
  }
  const levelSz = [1, 2, 3].map(l => { const p = all.map(a => a.p).find(q => q.level === l); return p ? p.sz : [32, 28, 26][l - 1]; });
  // 4) 版面:頁邊界、圖片裁切與位置
  const out = [];
  for (let i = 0; i < pages.length; i++) {
    const { e, paras, rich, figs, scan } = pages[i];
    if (onProgress) onProgress(`整理內容 ${i + 1} / ${pages.length}…`);
    const [dw, dh] = dispSize(e);
    const boxes = pageImageBoxes(e, rich, scan, figs);
    // 頁邊界:依內容範圍估計(36–90pt)
    const dboxes = paras.map(p => p.box).filter(Boolean).concat(boxes).map(b => dispBox(e, b));
    const margins = dboxes.length && !scan
      ? [clamp(Math.min(...dboxes.map(b => b.y0)), 36, 90), clamp(dw - Math.max(...dboxes.map(b => b.x1)), 36, 90), clamp(dh - Math.max(...dboxes.map(b => b.y1)), 36, 90), clamp(Math.min(...dboxes.map(b => b.x0)), 36, 90)]
      : scan ? [18, 18, 18, 18] : [72, 72, 72, 72];
    const contentW = dw - margins[1] - margins[3], contentH = dh - margins[0] - margins[2];
    const blocks = paras.map(p => {
      if (p.table) return { type: 'table', ...p.table, box: p.box };
      const b = p.box;
      const center = !!b && !p.list && Math.abs((b.x0 + b.x1) / 2 - e.w / 2) < 0.03 * e.w && b.x1 - b.x0 < 0.6 * e.w && p.text.length < 120;
      return { type: 'p', segs: p.segs, text: p.text, level: p.level, list: p.list, center, sz: p.sz, box: b };
    });
    // 圖片插在同一欄、位置在它上方的最後一個段落之後
    if (boxes.length) {
      const r = await renderDisplay(e, 150, e.anns.length);
      for (const b of boxes) {
        const img = cropJpeg(r, e, b);
        const k = Math.min(1, contentW / img.w, contentH / img.h);
        // 原本置中的圖片置中,否則靠左並保留與左邊界的距離
        const d = dispBox(e, b), center = Math.abs((d.x0 + d.x1) / 2 - dw / 2) < 0.05 * dw;
        const indent = center ? 0 : clamp(d.x0 - margins[3], 0, Math.max(0, contentW - img.w * k));
        blocks.splice(imageSlot(blocks, b), 0, { type: 'img', bytes: img.bytes, w: img.w * k, h: img.h * k, center, indent });
      }
      r.canvas.width = r.canvas.height = 1;
    }
    out.push({ e, dw, dh, margins, contentW, contentH, blocks });
  }
  return { pages: out, bodySz, levelSz, pageNumbers };
}
