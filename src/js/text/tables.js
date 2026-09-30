/* =====================================================================
   表格偵測(純函式,座標為 layout.js 的「文字座標系」:文字方向朝 +x、y 向下)
   1) 有框線:水平/垂直線段交錯成格線 → 儲存格(缺少的內框線 = 合併儲存格)
   2) 無框線:連續多列都分成幾段隔得很開的文字,而且上下對齊(例如目錄的標題與頁碼)
      為了不把報紙式分欄誤判成表格:至少要有一欄是短內容(頁碼、數字、代號…)
   回傳 { tables, rest }:rest 是不屬於任何表格的片段,照常做版面分析
   表格:{ ruled, top, bottom, left, right, cols:[{a,b,align}], rows:[[cell | null]] }
         cell:{ items, colspan, rowspan, hidden(被合併), left }
   ===================================================================== */
const TBL_TOL = 2;

function clusterValues(vals, tol) {
  const s = vals.slice().sort((a, b) => a - b), out = [];
  for (const v of s) {
    const last = out[out.length - 1];
    if (last && v - last.max <= tol) { last.sum += v; last.n++; last.max = v; }
    else out.push({ sum: v, n: 1, max: v });
  }
  return out.map(c => c.sum / c.n);
}
const itemCenter = it => [it.x + it.w / 2, (it.top + it.bottom) / 2];

/* ---------- 1) 有框線 ---------- */
function ruledTables(items, segs) {
  const H = [], V = [];
  for (const s of segs) {
    const dx = Math.abs(s.x1 - s.x0), dy = Math.abs(s.y1 - s.y0);
    if (dy <= 1.5 && dx >= 8) H.push({ p: (s.y0 + s.y1) / 2, a: Math.min(s.x0, s.x1), b: Math.max(s.x0, s.x1) });
    else if (dx <= 1.5 && dy >= 8) V.push({ p: (s.x0 + s.x1) / 2, a: Math.min(s.y0, s.y1), b: Math.max(s.y0, s.y1) });
  }
  const merge = L => {
    L.sort((u, v) => u.p - v.p || u.a - v.a);
    const out = [];
    for (const l of L) {
      const last = out[out.length - 1];
      if (last && Math.abs(l.p - last.p) <= 1 && l.a <= last.b + TBL_TOL) last.b = Math.max(last.b, l.b);
      else out.push({ ...l });
    }
    return out;
  };
  const hs = merge(H), vs = merge(V);
  if (hs.length < 3 || vs.length < 3) return [];
  // 互相交錯的線段歸成同一組(union-find)
  const all = hs.map(h => ({ ...h, h: true })).concat(vs.map(v => ({ ...v, h: false })));
  const par = all.map((_, i) => i), find = i => par[i] === i ? i : (par[i] = find(par[i]));
  for (let i = 0; i < hs.length; i++) for (let j = hs.length; j < all.length; j++) {
    const h = all[i], v = all[j];
    if (v.p >= h.a - TBL_TOL && v.p <= h.b + TBL_TOL && h.p >= v.a - TBL_TOL && h.p <= v.b + TBL_TOL) par[find(i)] = find(j);
  }
  const groups = new Map();
  all.forEach((l, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(l); });
  const tables = [];
  for (const g of groups.values()) {
    const gh = g.filter(l => l.h), gv = g.filter(l => !l.h);
    if (gh.length < 2 || gv.length < 2) continue;
    const ys = clusterValues(gh.map(l => l.p), TBL_TOL), xs = clusterValues(gv.map(l => l.p), TBL_TOL);
    const R = ys.length - 1, C = xs.length - 1;
    if (R < 2 || C < 2 || R * C > 2000) continue;
    const hasV = (xi, r) => { const m = (ys[r] + ys[r + 1]) / 2; return gv.some(l => Math.abs(l.p - xs[xi]) <= TBL_TOL && l.a <= m && l.b >= m); };
    const hasH = (yi, c) => { const m = (xs[c] + xs[c + 1]) / 2; return gh.some(l => Math.abs(l.p - ys[yi]) <= TBL_TOL && l.a <= m && l.b >= m); };
    // 相鄰格之間沒有框線 → 合併
    const slot = (r, c) => r * C + c, sp = [...Array(R * C).keys()], sf = i => sp[i] === i ? i : (sp[i] = sf(sp[i]));
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
      if (c + 1 < C && !hasV(c + 1, r)) sp[sf(slot(r, c))] = sf(slot(r, c + 1));
      if (r + 1 < R && !hasH(r + 1, c)) sp[sf(slot(r, c))] = sf(slot(r + 1, c));
    }
    const spans = new Map();
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
      const k = sf(slot(r, c)), s = spans.get(k) || { r0: r, r1: r, c0: c, c1: c, n: 0 };
      s.r0 = Math.min(s.r0, r); s.r1 = Math.max(s.r1, r); s.c0 = Math.min(s.c0, c); s.c1 = Math.max(s.c1, c); s.n++;
      spans.set(k, s);
    }
    const rect = [...spans.values()].every(s => (s.r1 - s.r0 + 1) * (s.c1 - s.c0 + 1) === s.n);
    const rows = [...Array(R)].map(() => Array(C).fill(null));
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
      const s = rect ? spans.get(sf(slot(r, c))) : { r0: r, r1: r, c0: c, c1: c };
      rows[r][c] = r === s.r0 && c === s.c0
        ? { items: [], colspan: s.c1 - s.c0 + 1, rowspan: s.r1 - s.r0 + 1, left: xs[c], r, c }
        : { hidden: true, owner: rows[s.r0][s.c0] };   // 列優先走訪,起始格一定先建立
    }
    const t = { ruled: true, top: ys[0], bottom: ys[R], left: xs[0], right: xs[C], rows, ys,
      cols: xs.slice(0, -1).map((x, c) => ({ a: x, b: xs[c + 1], align: 'left' })), items: [] };
    for (const it of items) {
      const [cx, cy] = itemCenter(it);
      if (cx < t.left || cx > t.right || cy < t.top || cy > t.bottom) continue;
      let r = ys.findIndex((y, i) => i < R && cy >= y && cy <= ys[i + 1]), c = xs.findIndex((x, i) => i < C && cx >= x && cx <= xs[i + 1]);
      if (r < 0 || c < 0) continue;
      const cell = rows[r][c].hidden ? rows[r][c].owner : rows[r][c];
      cell.items.push(it); t.items.push(it);
    }
    // 圖表的格線(大部分格子是空的)不算表格
    const cells = rows.flat().filter(x => !x.hidden), filled = cells.filter(x => x.items.length).length;
    if (filled >= 3 && filled / cells.length >= 0.4) tables.push(t);
  }
  return tables;
}

/* ---------- 2) 無框線(對齊) ---------- */
function alignedTables(items, minX, maxX) {
  const W = maxX - minX, lines = buildLines(items);
  for (const ln of lines) {
    const cells = [];
    for (const it of ln.items) {
      const cur = cells[cells.length - 1];
      if (cur && it.x - cur.right <= Math.max(12, 2 * Math.min(it.size, cur.size))) { cur.items.push(it); cur.right = Math.max(cur.right, it.x + it.w); }
      else cells.push({ items: [it], left: it.x, right: it.x + it.w, size: it.size });
    }
    for (const c of cells) c.text = c.items.map(i => i.str).join('').trim();
    ln.cells = cells.filter(c => c.text);
    ln.top = Math.min(...ln.items.map(i => i.top)); ln.bottom = Math.max(...ln.items.map(i => i.bottom));
  }
  const tables = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].cells.length < 2) { i++; continue; }
    // 一段連續的列:多欄的列,中間可夾單欄的列(例如換行的標題),但不能跨過大段空白
    let j = i + 1;
    while (j < lines.length) {
      const gap = lines[j].top - lines[j - 1].bottom, em = lines[j - 1].size;
      if (gap > 1.8 * em) break;
      if (lines[j].cells.length >= 2) { j++; continue; }
      if (j + 1 < lines.length && lines[j + 1].cells.length >= 2 && lines[j + 1].top - lines[j].bottom <= 1.8 * em) { j++; continue; }
      break;
    }
    const t = buildAlignedTable(lines.slice(i, j), W);
    if (t) { tables.push(t); i = j; } else i++;
  }
  return tables;
}
function buildAlignedTable(lns, W, retry = true) {
  const multi = lns.filter(l => l.cells.length >= 2);
  if (multi.length < 3) return null;
  // 欄與欄之間的「垂直空白帶」:所有多欄列的儲存格都沒佔用的 x 範圍
  const left = Math.min(...multi.flatMap(l => l.cells.map(c => c.left))), right = Math.max(...multi.flatMap(l => l.cells.map(c => c.right)));
  const n = Math.ceil(right - left) + 1, occ = new Uint8Array(n);
  for (const l of multi) for (const c of l.cells) for (let x = Math.floor(c.left - left); x <= Math.ceil(c.right - left) && x < n; x++) occ[Math.max(0, x)] = 1;
  const bands = [];
  for (let x = 0; x < n;) {
    if (!occ[x]) { x++; continue; }
    let y = x; while (y + 1 < n && occ[y + 1]) y++;
    const last = bands[bands.length - 1];
    if (last && x - last.b < 6) last.b = y; else bands.push({ a: x, b: y });   // 太窄的空白不算欄距
    x = y + 1;
  }
  if (bands.length < 2 || bands.length > 12) return null;
  const cols = bands.map(b => ({ a: b.a + left, b: b.b + left, cells: [] }));
  const colOf = c => cols.findIndex(k => c.left >= k.a - TBL_TOL && c.right <= k.b + TBL_TOL);
  // 單欄的列必須落在某一欄內,否則表格到此為止
  let end = lns.length;
  for (let k = 0; k < lns.length; k++) if (lns[k].cells.length === 1 && colOf(lns[k].cells[0]) < 0) { end = k; break; }
  const body = lns.slice(0, end);
  if (body.filter(l => l.cells.length >= 2).length < 3) return null;
  const rows = body.map(l => {
    const row = cols.map(() => null);
    for (const c of l.cells) {
      const k = colOf(c); if (k < 0) return null;
      if (row[k]) { row[k].items.push(...c.items); row[k].text += ' ' + c.text; }
      else row[k] = { items: c.items.slice(), colspan: 1, rowspan: 1, left: c.left, right: c.right, text: c.text };
      cols[k].cells.push(row[k]);
    }
    return row;
  });
  if (rows.some(r => !r)) return null;
  // 某一欄大部分是小寫開頭 → 那是接續的句子(正文剛好和旁邊的方框對齊),不是表格;
  // 拿掉這些欄再試一次(例如正文旁邊的「Contents」方框本身可能是表格)
  const prose = k => k.cells.length >= 3 && k.cells.slice(1).filter(c => /^[a-z]/.test(c.text)).length >= 0.3 * (k.cells.length - 1);
  if (cols.some(prose)) {
    const keep = cols.filter(k => !prose(k));
    if (!retry || keep.length < 2) return null;
    const inKeep = c => keep.some(k => c.left >= k.a - TBL_TOL && c.right <= k.b + TBL_TOL);
    const sub = lns.map(l => ({ ...l, cells: l.cells.filter(inKeep) })).filter(l => l.cells.length);
    return buildAlignedTable(sub, W, false);
  }
  // 報紙式分欄:每一欄都是長句子 → 不是表格(要有一欄是短內容,例如頁碼或數字)
  const med = arr => { const s = arr.slice().sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0; };
  const short = cols.some(k => k.cells.length >= 2 && med(k.cells.map(c => c.text.length)) <= 15);
  if (!short) return null;
  // 對齊方式:右緣比左緣整齊 → 靠右(例如頁碼、金額)
  const spread = v => v.length ? Math.max(...v) - Math.min(...v) : 0;
  for (const k of cols) k.align = k.cells.length >= 2 && spread(k.cells.map(c => c.right)) < 2 && spread(k.cells.map(c => c.left)) > 3 ? 'right' : 'left';
  return {
    ruled: false, top: Math.min(...body.map(l => l.top)), bottom: Math.max(...body.map(l => l.bottom)),
    left: cols[0].a, right: cols[cols.length - 1].b, rows,
    cols: cols.map(k => ({ a: k.a, b: k.b, align: k.align })), items: body.flatMap(l => l.cells.flatMap(c => c.items))
  };
}

function detectTables(items, segs, minX, maxX) {
  // pdf.js 會在隔得很遠的文字之間插入「只有空白」的片段(寬度等於間距),偵測表格時要忽略,
  // 否則標題與頁碼會被它連成一段;這些片段留在 rest,版面分析本來就會略過
  items = items.filter(it => it.str.trim());
  const ruled = segs.length ? ruledTables(items, segs) : [];
  const used = new Set(ruled.flatMap(t => t.items));
  const rest0 = items.filter(it => !used.has(it));
  const aligned = alignedTables(rest0, minX, maxX);
  for (const t of aligned) for (const it of t.items) used.add(it);
  return { tables: ruled.concat(aligned), rest: items.filter(it => !used.has(it)) };
}
