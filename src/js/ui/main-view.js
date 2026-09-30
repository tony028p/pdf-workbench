/* =====================================================================
   畫面:主編輯區
   ===================================================================== */
const stage = $('#stage'), pagesEl = $('#pages'), thumbsEl = $('#thumbs'), thGrid = $('#thumbsGrid');
const pvMap = new Map();   // uid -> view
const thMap = new Map();
const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) { const el = document.createElementNS(SVGNS, tag); for (const k in attrs) el.setAttribute(k, attrs[k]); return el; }

let active = 0; const waiters = [];
async function withSlot(fn) {
  if (active >= 3) await new Promise(r => waiters.push(r));
  active++;
  try { return await fn(); } finally { active--; const w = waiters.shift(); if (w) w(); }
}
async function paint(e, target, pxPerPt) {
  const src = sources.get(e.src);
  const page = await src.doc.getPage(e.idx + 1);
  let s = pxPerPt;
  const MAXPX = 16e6;
  if (e.w * s * e.h * s > MAXPX) s = Math.sqrt(MAXPX / (e.w * e.h));
  const vp = page.getViewport({ scale: s });
  const off = document.createElement('canvas');
  off.width = Math.max(1, Math.floor(vp.width)); off.height = Math.max(1, Math.floor(vp.height));
  const g = off.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, off.width, off.height);
  await page.render({ canvasContext: g, viewport: vp }).promise;
  target.width = off.width; target.height = off.height;
  target.getContext('2d').drawImage(off, 0, 0);
}

const pvObserver = new IntersectionObserver(list => {
  for (const en of list) {
    const v = en.target.__v; if (!v) continue;
    v.visible = en.isIntersecting;
    if (v.visible) { ensureRendered(v); if (S.tool === 'seltext') buildTextLayer(v); if (S.tool === 'form') buildFormLayer(v); const e = S.showText && pageByUid(v.uid); if (e) drawTextView(e, v); }
    else { v.tok++; v.canvas.width = v.canvas.height = 1; v.rz = 0; removeTextLayer(v); removeFormLayer(v); }   // 離開視野就釋放記憶體
  }
}, { root: stage, rootMargin: '1200px 0px' });

function ensureRendered(v) {
  const e = pageByUid(v.uid); if (!e) return;
  const zz = zoomPx() * Math.min(window.devicePixelRatio || 1, 2);
  if (v.rz === zz) return;
  v.rz = zz;
  const tok = ++v.tok;
  withSlot(async () => {
    if (tok !== v.tok) return;
    try { await paint(e, v.canvas, zz); } catch (err) { console.warn('render failed', err); }
  });
}

function makePv(e) {
  const el = document.createElement('div');
  el.className = 'pv'; el.dataset.uid = e.uid;
  el.innerHTML = '<div class="pvin"><canvas></canvas><svg preserveAspectRatio="none"><g class="gt"></g><g class="ga"></g><g class="gm"></g><g class="go"></g><g class="gs"></g></svg></div><div class="pvlabel"></div>';
  const v = { uid: e.uid, el, inner: el.firstChild, canvas: $('canvas', el), svg: $('svg', el), gt: $('.gt', el), ga: $('.ga', el), gm: $('.gm', el), go: $('.go', el), gs: $('.gs', el), label: $('.pvlabel', el), rz: 0, tok: 0, visible: false };
  el.__v = v;
  pvObserver.observe(el);
  return v;
}

function syncMain() {
  const alive = new Set(S.pages.map(p => p.uid));
  for (const [u, v] of pvMap) if (!alive.has(u)) { pvObserver.unobserve(v.el); v.el.remove(); pvMap.delete(u); }
  const zz = zoomPx();
  S.pages.forEach((e, i) => {
    let v = pvMap.get(e.uid);
    if (!v) { v = makePv(e); pvMap.set(e.uid, v); }
    const [dw, dh] = dispSize(e);
    v.el.style.width = dw * zz + 'px'; v.el.style.height = dh * zz + 'px';
    v.inner.style.width = e.w * zz + 'px'; v.inner.style.height = e.h * zz + 'px';
    v.inner.style.transform = `translate(-50%,-50%) rotate(${e.r}deg)`;
    v.label.textContent = i + 1;
    if (pagesEl.children[i] !== v.el) pagesEl.insertBefore(v.el, pagesEl.children[i] || null);
    if (v.zoomKey !== zz) { v.zoomKey = zz; v.rz = 0; if (v.visible) ensureRendered(v); }
    renderOverlay(e, i);
  });
  $('#empty').style.display = S.pages.length ? 'none' : 'flex';
}

/* ---- 標註繪製 ---- */
const ptsStr = p => { const o = []; for (let i = 0; i < p.length; i += 2) o.push(p[i].toFixed(1) + ',' + p[i + 1].toFixed(1)); return o.join(' '); };
function mkAnnEl(a) {
  let el;
  switch (a.type) {
    case 'pen': el = svgEl('polyline', { fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }); break;
    case 'line': el = svgEl('line', { 'stroke-linecap': 'round' }); break;
    case 'hl': case 'redact': case 'erase': el = svgEl('rect', {}); break;
    case 'crop': el = svgEl('path', { 'fill-rule': 'evenodd', fill: 'rgba(20,24,32,.45)', stroke: '#2b47d9', 'stroke-dasharray': '6 4', 'pointer-events': 'none' }); break;
    default: el = svgEl('image', { preserveAspectRatio: 'none' });
  }
  el.dataset.aid = a.id;
  updAnnEl(el, a);
  return el;
}
function updAnnEl(el, a) {
  switch (a.type) {
    case 'pen': el.setAttribute('points', ptsStr(a.pts)); el.setAttribute('stroke', a.color); el.setAttribute('stroke-width', a.width); break;
    case 'line':
      el.setAttribute('x1', a.x1); el.setAttribute('y1', a.y1); el.setAttribute('x2', a.x2); el.setAttribute('y2', a.y2);
      el.setAttribute('stroke', a.color); el.setAttribute('stroke-width', a.width); break;
    case 'hl': case 'redact': case 'erase':
      el.setAttribute('x', a.x); el.setAttribute('y', a.y); el.setAttribute('width', a.w); el.setAttribute('height', a.h); el.setAttribute('fill', a.color);
      if (a.type === 'hl') { el.style.mixBlendMode = 'multiply'; el.setAttribute('opacity', '.55'); }
      break;
    case 'crop':   // 裁切:範圍外蓋一層半透明(外框取很大,超出頁面的部分由 svg 裁掉)
      el.setAttribute('d', `M-1e5 -1e5H1e5V1e5H-1e5Z M${a.x} ${a.y}h${a.w}v${a.h}h${-a.w}Z`);
      el.setAttribute('stroke-width', 1.2 / zoomPx()); break;
    default:
      el.setAttribute('href', assets.get(a.asset).url);
      el.setAttribute('x', a.x); el.setAttribute('y', a.y); el.setAttribute('width', a.w); el.setAttribute('height', a.h);
  }
}
function renderOverlay(e, gi) {
  const v = pvMap.get(e.uid); if (!v) return;
  if (gi === undefined) gi = S.pages.indexOf(e);
  v.svg.setAttribute('viewBox', `0 0 ${e.w} ${e.h}`);
  v.ga.replaceChildren(...e.anns.map(mkAnnEl));
  const items = markItems(e, gi, S.pages.length);
  v.gm.replaceChildren(...items.map(it => svgEl('image', {
    href: assets.get(it.asset).url, x: it.cx - it.w / 2, y: it.cy - it.h / 2, width: it.w, height: it.h,
    preserveAspectRatio: 'none', opacity: it.opacity, transform: `rotate(${it.angle} ${it.cx} ${it.cy})`, 'pointer-events': 'none'
  })));
  drawTextView(e, v);
  drawLowConf(e, v);
  drawSel(e);
}
/* 文字辨識信心較低的字詞:橘色虛線框(只在畫面上,不會匯出);在辨識視窗可以關閉 */
const OCR_LOW_CONF = 85;
function lowConfItems(e) {
  const c = ocrCache.get(e.src + ':' + e.idx);
  if (!c || !c.ocr) return [];
  // 已經用改字框改掉的字詞不再標示
  const boxes = eraseBoxes(e), gone = it => { const x = (it.box.x0 + it.box.x1) / 2, y = (it.box.y0 + it.box.y1) / 2; return boxes.some(b => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1); };
  return c.items.filter(it => it.conf < OCR_LOW_CONF && it.str.trim() && !gone(it));
}
function drawLowConf(e, v) {
  const list = S.ocrMarkLow ? lowConfItems(e) : [], zz = zoomPx();
  v.go.replaceChildren(...list.map(it => {
    const r = svgEl('rect', { x: it.box.x0 - 1, y: it.box.y0 - 1, width: it.box.x1 - it.box.x0 + 2, height: it.box.y1 - it.box.y0 + 2, rx: 1.5,
      fill: 'rgba(255,153,0,.15)', stroke: '#e07b00', 'stroke-width': 1.2 / zz, 'stroke-dasharray': `${3 / zz} ${2 / zz}`, 'pointer-events': 'none' });
    r.appendChild(svgEl('title', {})).textContent = `辨識信心 ${Math.round(it.conf)}%:「${it.str}」`;
    return r;
  }));
}
function refreshAllOverlays() { S.pages.forEach((e, i) => renderOverlay(e, i)); }

function bbox(a) {
  switch (a.type) {
    case 'pen': {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < a.pts.length; i += 2) { x0 = Math.min(x0, a.pts[i]); x1 = Math.max(x1, a.pts[i]); y0 = Math.min(y0, a.pts[i + 1]); y1 = Math.max(y1, a.pts[i + 1]); }
      const p = a.width / 2; return { x: x0 - p, y: y0 - p, w: x1 - x0 + a.width, h: y1 - y0 + a.width };
    }
    case 'line': {
      const p = a.width / 2; const x = Math.min(a.x1, a.x2), y = Math.min(a.y1, a.y2);
      return { x: x - p, y: y - p, w: Math.abs(a.x2 - a.x1) + a.width, h: Math.abs(a.y2 - a.y1) + a.width };
    }
    default: return { x: a.x, y: a.y, w: a.w, h: a.h };
  }
}
const resizable = a => ['img', 'text', 'hl', 'redact', 'erase', 'crop'].includes(a.type);
function drawSel(e) {
  const v = pvMap.get(e.uid); if (!v) return;
  v.gs.replaceChildren();
  if (!S.selAnn || S.selAnn.uid !== e.uid) return;
  const a = e.anns.find(x => x.id === S.selAnn.id); if (!a) return;
  const b = bbox(a), zz = zoomPx(), pad = 2 / zz;
  v.gs.appendChild(svgEl('rect', { x: b.x - pad, y: b.y - pad, width: b.w + pad * 2, height: b.h + pad * 2, fill: 'none', stroke: '#2b47d9', 'stroke-width': 1.5 / zz, 'stroke-dasharray': `${5 / zz} ${3 / zz}`, 'pointer-events': 'none' }));
  if (resizable(a)) {
    const s = 9 / zz;
    v.gs.appendChild(svgEl('rect', { x: b.x + b.w - s / 2, y: b.y + b.h - s / 2, width: s, height: s, fill: '#fff', stroke: '#2b47d9', 'stroke-width': 1.5 / zz, 'pointer-events': 'none' }));
  }
}
function selAnnObj() {
  if (!S.selAnn) return null;
  const e = pageByUid(S.selAnn.uid); return e ? e.anns.find(a => a.id === S.selAnn.id) || null : null;
}
function selectAnn(u, id) { const prev = S.selAnn; S.selAnn = u ? { uid: u, id } : null; if (prev && prev.uid !== u) { const pe = pageByUid(prev.uid); if (pe) drawSel(pe); } const e = u && pageByUid(u); if (e) drawSel(e); syncProps(); }

