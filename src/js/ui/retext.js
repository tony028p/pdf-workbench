/* =====================================================================
   改字工具:點一下原有的文字(或拖曳框選其中幾個字)→ 輸入新的內容
   - 產生兩個標註(同一步復原):改字框 'erase'(底色取自畫面)與新的文字標註(基線對齊原文字)
   - 改字框範圍內的原文字:匯出 PDF 時從檔案刪除(edit/retext.js),擷取、選取文字也不再包含(eraseItems)
   - 沒有文字的地方(例如掃描頁)可以拖曳框選,一樣蓋掉後重寫
   ===================================================================== */

/* 可以修改的文字片段:水平、不在塗黑範圍內、還沒改過;頁面文字還沒讀取時回傳 null */
function retextItemsSync(e) {
  const key = e.src + ':' + e.idx, raw = ocrCache.get(key) || textCache.get(key);
  if (!raw) return null;
  const reds = e.anns.filter(a => a.type === 'redact').map(redactBox);
  return eraseItems(raw.items.filter(it => it.str.trim() && !it.vertical && Math.abs(it.angle) < 1 && !reds.some(r => boxHit(it.box, r))), e);
}
async function retextItems(e) { await rawPageText(e); return retextItemsSync(e) || []; }

function retextSel(parts, text, ref) {
  return {
    text, size: ref.size, font: ref.font || null, ox: ref.ox, oy: ref.oy,
    box: { x0: Math.min(...parts.map(p => p.box.x0)), y0: Math.min(...parts.map(p => p.box.y0)), x1: Math.max(...parts.map(p => p.box.x1)), y1: Math.max(...parts.map(p => p.box.y1)) }
  };
}
/* 片段接成一行文字:中間有明顯空隙(而且原本沒有空格)才補空格 */
function retextJoin(line) {
  let s = '';
  line.forEach((it, k) => { if (k && it.box.x0 - line[k - 1].box.x1 > it.size * 0.15 && !/\s$/.test(s) && !/^\s/.test(it.str)) s += ' '; s += it.str; });
  return s.trim();
}
/* 點一下:指到的片段,連同同一行緊鄰的片段(pdf.js 常把一句話切成好幾段) */
function retextRun(items, p) {
  const tol = 1.5;
  const hit = items.find(it => p[0] >= it.box.x0 - tol && p[0] <= it.box.x1 + tol && p[1] >= it.box.y0 - tol && p[1] <= it.box.y1 + tol);
  if (!hit) return null;
  const line = items.filter(it => Math.abs(it.oy - hit.oy) < hit.size * 0.25 && it.size > hit.size * 0.75 && it.size < hit.size * 1.33)
    .sort((a, b) => a.box.x0 - b.box.x0);
  const gap = (a, b) => b.box.x0 - a.box.x1;
  let i0 = line.indexOf(hit), i1 = i0;
  while (i0 > 0 && gap(line[i0 - 1], line[i0]) < hit.size * 0.6) i0--;
  while (i1 < line.length - 1 && gap(line[i1], line[i1 + 1]) < hit.size * 0.6) i1++;
  const run = line.slice(i0, i1 + 1);
  return retextSel(run, retextJoin(run), run[0]);
}
/* 拖曳框選:字元中心在框內的字(可以跨行) */
function retextRect(items, r) {
  const parts = [];
  for (const it of items) {
    if (!boxHit(it.box, r)) continue;
    const chars = itemChars(it), idx = [];
    chars.forEach((c, i) => { const q = charCenter(it, c); if (q[0] >= r.x0 && q[0] <= r.x1 && q[1] >= r.y0 && q[1] <= r.y1) idx.push(i); });
    if (idx.length) parts.push(subItem(it, chars, idx[0], idx[idx.length - 1] + 1));
  }
  if (!parts.length) return null;
  const lines = [];
  for (const it of parts.sort((a, b) => a.oy - b.oy)) {
    const ln = lines.find(l => Math.abs(l[0].oy - it.oy) < l[0].size * 0.4);
    if (ln) ln.push(it); else lines.push([it]);
  }
  lines.forEach(l => l.sort((a, b) => a.ox - b.ox));
  return retextSel(parts, lines.map(retextJoin).join('\n'), lines[0][0]);
}

/* 字型樣式(粗體、明體/楷書):pdf.js 載入的字型名稱 */
async function retextStyle(e, fontName) {
  try {
    const page = await sources.get(e.src).doc.getPage(e.idx + 1);
    await page.getOperatorList();
    const f = page.commonObjs.get(fontName), name = ((f && f.name) || '').replace(/^[A-Z]{6}\+/, '');
    const font = /kai/i.test(name) ? 'kai' : (/serif|ming|song|sung|mincho|times|georgia|garamond/i.test(name) && !/sans/i.test(name)) ? 'serif' : 'sans';
    return { font, bold: !!(f && f.bold) || /bold|black|heavy|semibold|demi|W[6-9]\b/i.test(name) };
  } catch (_) { return {}; }
}

/* 從畫面上的頁面圖取色:底色 = 框外一圈最常見的顏色,字色 = 框內和底色差最多的像素 */
function retextColors(e, box) {
  const def = { bg: '#ffffff', fg: '#111111' }, v = pvMap.get(e.uid), c = v && v.canvas;
  if (!c || c.width < 2) return def;
  const k = c.width / e.w, pad = 2.5;
  const X0 = Math.max(0, Math.floor((box.x0 - pad) * k)), Y0 = Math.max(0, Math.floor((box.y0 - pad) * k));
  const X1 = Math.min(c.width, Math.ceil((box.x1 + pad) * k)), Y1 = Math.min(c.height, Math.ceil((box.y1 + pad) * k));
  if (X1 - X0 < 3 || Y1 - Y0 < 3) return def;
  let d;
  try { d = c.getContext('2d').getImageData(X0, Y0, X1 - X0, Y1 - Y0).data; } catch (_) { return def; }
  const W = X1 - X0, ring = new Map(), inner = [];
  for (let y = 0; y < Y1 - Y0; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4, px = [d[o], d[o + 1], d[o + 2]];
    const bx = (X0 + x + 0.5) / k, by = (Y0 + y + 0.5) / k;
    if (bx >= box.x0 && bx <= box.x1 && by >= box.y0 && by <= box.y1) { inner.push(px); continue; }
    const key = (px[0] >> 4) << 8 | (px[1] >> 4) << 4 | px[2] >> 4, s = ring.get(key) || [0, 0, 0, 0];
    s[0] += px[0]; s[1] += px[1]; s[2] += px[2]; s[3]++; ring.set(key, s);
  }
  const top = [...ring.values()].sort((a, b) => b[3] - a[3])[0];
  if (!top || !inner.length) return def;
  const bg = [top[0] / top[3], top[1] / top[3], top[2] / top[3]];
  const dist = p => Math.hypot(p[0] - bg[0], p[1] - bg[1], p[2] - bg[2]);
  inner.sort((a, b) => dist(b) - dist(a));
  const n = Math.max(1, Math.round(inner.length * 0.08)), fg = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let j = 0; j < 3; j++) fg[j] += inner[i][j] / n;
  const hex = p => '#' + p.map(x => Math.round(clamp(x, 0, 255)).toString(16).padStart(2, '0')).join('');
  return { bg: hex(bg), fg: dist(fg) < 60 ? def.fg : hex(fg) };
}

/* 問新的內容,加上改字框與文字標註(一次復原) */
async function retextApply(e, sel) {
  const colors = retextColors(e, sel.box), style = sel.font ? await retextStyle(e, sel.font) : {};
  const res = await askText({ title: '替換文字', text: sel.text, font: style.font || 'sans', size: Math.round(clamp(sel.size, 4, 300) * 10) / 10,
    bold: style.bold, color: colors.fg, allowEmpty: true });
  if (!res) return;
  await fontsReady;
  checkpoint();
  const b = sel.box, pad = 1;
  e.anns.push({ id: newAnnId(), type: 'erase', x: b.x0 - pad, y: b.y0 - pad, w: b.x1 - b.x0 + pad * 2, h: b.y1 - b.y0 + pad * 2, color: colors.bg });
  if (res.text.trim()) {
    const t = renderTextAsset(res.text, res);
    // 第一行的基線對齊原文字(renderTextAsset 的排法:左邊留 0.12 字級、行高 1.35、以行的中線對齊)
    e.anns.push({ id: newAnnId(), type: 'text', text: res.text, font: res.font, size: res.size, bold: res.bold, color: res.color, asset: t.id,
      x: sel.ox - res.size * 0.12, y: sel.oy - res.size * (0.12 + 0.675) - sansMiddleToBaseline() * res.size, w: t.w, h: t.h });
  }
  renderOverlay(e); refreshThumbClasses(); updateButtons();
}

/* ---- 指標:滑過時框出會被選到的文字;按下拖曳 = 框選,沒有拖曳 = 點選 ---- */
let rtHoverRaf = 0, rtHoverEv = null, rtHoverUid = null;
function retextHover(ev) {
  rtHoverEv = ev;
  if (!rtHoverRaf) rtHoverRaf = requestAnimationFrame(() => { rtHoverRaf = 0; retextHoverDraw(rtHoverEv); });
}
function retextHoverClear() {
  if (!rtHoverUid) return;
  const v = pvMap.get(rtHoverUid);
  if (v) v.gs.replaceChildren();
  rtHoverUid = null;
}
function retextHoverDraw(ev) {
  retextHoverClear();
  if (!ev || S.tool !== 'retext' || drag) return;
  const pvEl = ev.target && ev.target.closest && ev.target.closest('.pv'); if (!pvEl) return;
  const e = pageByUid(pvEl.dataset.uid); if (!e) return;
  const items = retextItemsSync(e);
  if (!items) { rawPageText(e).then(() => retextHover(rtHoverEv)).catch(() => {}); return; }   // 讀完文字再畫
  const run = retextRun(items, evBase(ev, pvEl, e));
  if (!run) return;
  const v = pvMap.get(e.uid), zz = zoomPx(), b = run.box;
  v.gs.replaceChildren(svgEl('rect', { x: b.x0 - 1, y: b.y0 - 1, width: b.x1 - b.x0 + 2, height: b.y1 - b.y0 + 2, fill: 'rgba(43,71,217,.08)',
    stroke: '#2b47d9', 'stroke-width': 1.2 / zz, 'stroke-dasharray': `${4 / zz} ${3 / zz}`, 'pointer-events': 'none' }));
  rtHoverUid = e.uid;
}
pagesEl.addEventListener('pointerleave', () => retextHover(null));

function retextDragMove(d, p) {
  const v = pvMap.get(d.e.uid), zz = zoomPx();
  d.p1 = p;
  if (Math.hypot(p[0] - d.p0[0], p[1] - d.p0[1]) * zz < 4 && !d.el) return;
  if (!d.el) { retextHoverClear(); d.el = svgEl('rect', { fill: 'rgba(43,71,217,.1)', stroke: '#2b47d9', 'pointer-events': 'none' }); v.gs.replaceChildren(d.el); rtHoverUid = d.e.uid; }
  const x = Math.min(d.p0[0], p[0]), y = Math.min(d.p0[1], p[1]);
  d.el.setAttribute('x', x); d.el.setAttribute('y', y); d.el.setAttribute('width', Math.abs(p[0] - d.p0[0])); d.el.setAttribute('height', Math.abs(p[1] - d.p0[1]));
  d.el.setAttribute('stroke-width', 1.2 / zz);
}
async function retextDragEnd(d) {
  const { e } = d, p1 = d.p1 || d.p0;
  retextHoverClear();
  const r = { x0: Math.min(d.p0[0], p1[0]), y0: Math.min(d.p0[1], p1[1]), x1: Math.max(d.p0[0], p1[0]), y1: Math.max(d.p0[1], p1[1]) };
  const items = await retextItems(e);
  if (!d.el) {                                     // 點選
    const sel = retextRun(items, d.p0);
    if (sel) return retextApply(e, sel);
    const raw = await rawPageText(e);
    return toast(raw.chars ? '這裡沒有文字:請點在文字上,或拖曳框選要蓋掉的範圍' : '這一頁沒有文字層:請拖曳框選要蓋掉的範圍,或先用「文字辨識」', 4000);
  }
  if (r.x1 - r.x0 < 2 || r.y1 - r.y0 < 2) return;
  const h = r.y1 - r.y0;
  const sel = retextRect(items, r) || { box: r, text: '', size: clamp(h * 0.7, 6, 72), font: null, ox: r.x0 + 1, oy: r.y1 - h * 0.25 };
  return retextApply(e, sel);
}
