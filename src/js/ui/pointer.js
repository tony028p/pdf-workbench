/* =====================================================================
   指標互動:繪製、選取、移動、縮放
   ===================================================================== */
let drag = null;
const distSeg = (px, py, x1, y1, x2, y2) => {
  const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0; t = clamp(t, 0, 1);
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
};
function hitAnn(a, p, tol) {
  if (a.type === 'pen') {
    const r = Math.max(a.width / 2, tol);
    if (a.pts.length === 2) return Math.hypot(p[0] - a.pts[0], p[1] - a.pts[1]) <= r;
    for (let i = 0; i + 3 < a.pts.length; i += 2) if (distSeg(p[0], p[1], a.pts[i], a.pts[i + 1], a.pts[i + 2], a.pts[i + 3]) <= r) return true;
    return false;
  }
  if (a.type === 'line') return distSeg(p[0], p[1], a.x1, a.y1, a.x2, a.y2) <= Math.max(a.width / 2, tol);
  if (a.type === 'crop') {             // 裁切框只在邊線附近可以點選,框內還能選到其他標註
    const t = tol * 2, inX = p[0] >= a.x - t && p[0] <= a.x + a.w + t, inY = p[1] >= a.y - t && p[1] <= a.y + a.h + t;
    return (inY && (Math.abs(p[0] - a.x) <= t || Math.abs(p[0] - a.x - a.w) <= t)) || (inX && (Math.abs(p[1] - a.y) <= t || Math.abs(p[1] - a.y - a.h) <= t));
  }
  const b = bbox(a);
  return p[0] >= b.x - tol && p[0] <= b.x + b.w + tol && p[1] >= b.y - tol && p[1] <= b.y + b.h + tol;
}
function evBase(ev, pvEl, e) {
  const r = pvEl.getBoundingClientRect(), zz = zoomPx();
  return dispToBase((ev.clientX - r.left) / zz, (ev.clientY - r.top) / zz, e);
}
const newAnnId = () => 'n' + (S.nextId++);

pagesEl.addEventListener('pointerdown', ev => {
  if (ev.button !== 0) return;
  const pvEl = ev.target.closest('.pv'); if (!pvEl) return;
  const e = pageByUid(pvEl.dataset.uid); if (!e) return;
  setCurrent(e.uid);
  const p = evBase(ev, pvEl, e), zz = zoomPx(), tool = S.tool;
  const start = () => { pagesEl.setPointerCapture(ev.pointerId); ev.preventDefault(); };

  if (tool === 'select') {
    const cur = selAnnObj();
    if (cur && S.selAnn.uid === e.uid && resizable(cur)) {
      const b = bbox(cur);
      if (Math.hypot(p[0] - (b.x + b.w), p[1] - (b.y + b.h)) <= 12 / zz) {
        checkpoint();
        drag = { mode: 'resize', e, a: cur, pvEl, w0: cur.w, h0: cur.h, size0: cur.size, moved: false };
        return start();
      }
    }
    let hit = null;
    for (let i = e.anns.length - 1; i >= 0; i--) if (hitAnn(e.anns[i], p, 5 / zz)) { hit = e.anns[i]; break; }
    if (hit) {
      selectAnn(e.uid, hit.id);
      checkpoint();
      drag = { mode: 'move', e, a: hit, pvEl, last: p, moved: false };
      start();
    } else selectAnn(null);
    return;
  }
  if (tool === 'seltext') return;   // 交給瀏覽器原生的文字選取
  if (tool === 'form') return;      // 交給欄位的輸入框
  if (tool === 'text') { ev.preventDefault(); return void addTextAt(e, p); }
  if (tool === 'retext') { drag = { mode: 'pick', e, pvEl, p0: p, el: null }; return start(); }   // ui/retext.js
  if (tool === 'image' || tool === 'sign') {
    ev.preventDefault();
    if (!S.pending) { if (tool === 'image') $('#imgIn').click(); return; }
    return void placePending(e, p);
  }
  // 繪製類
  checkpoint();
  let a;
  if (tool === 'pen') a = { id: newAnnId(), type: 'pen', pts: [p[0], p[1]], color: S.colors.pen, width: S.width };
  else if (tool === 'line') a = { id: newAnnId(), type: 'line', x1: p[0], y1: p[1], x2: p[0], y2: p[1], color: S.colors.line, width: S.width };
  else a = { id: newAnnId(), type: tool, x: p[0], y: p[1], w: 0, h: 0, color: S.colors[tool] };
  e.anns.push(a);
  const v = pvMap.get(e.uid); const el = mkAnnEl(a); v.ga.appendChild(el);
  drag = { mode: 'draw', e, a, el, pvEl, p0: p };
  start();
});

pagesEl.addEventListener('pointermove', ev => {
  if (!drag) { if (S.tool === 'retext') retextHover(ev); return; }
  const { e, a, pvEl } = drag;
  const p = evBase(ev, pvEl, e);
  const v = pvMap.get(e.uid);
  if (drag.mode === 'pick') return retextDragMove(drag, p);
  if (drag.mode === 'draw') {
    if (a.type === 'pen') {
      const n = a.pts.length;
      if (Math.hypot(p[0] - a.pts[n - 2], p[1] - a.pts[n - 1]) >= 0.6) a.pts.push(p[0], p[1]);
    } else if (a.type === 'line') {
      let x = p[0], y = p[1];
      if (ev.shiftKey) {
        const dx = x - a.x1, dy = y - a.y1, ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), l = Math.hypot(dx, dy);
        x = a.x1 + Math.cos(ang) * l; y = a.y1 + Math.sin(ang) * l;
      }
      a.x2 = x; a.y2 = y;
    } else {
      a.x = Math.min(drag.p0[0], p[0]); a.y = Math.min(drag.p0[1], p[1]);
      a.w = Math.abs(p[0] - drag.p0[0]); a.h = Math.abs(p[1] - drag.p0[1]);
    }
    updAnnEl(drag.el, a);
  } else if (drag.mode === 'move') {
    const dx = p[0] - drag.last[0], dy = p[1] - drag.last[1];
    if (!drag.moved && Math.hypot(dx, dy) * zoomPx() < 2) return;
    drag.moved = true; drag.last = p;
    if (a.type === 'pen') for (let i = 0; i < a.pts.length; i += 2) { a.pts[i] += dx; a.pts[i + 1] += dy; }
    else if (a.type === 'line') { a.x1 += dx; a.x2 += dx; a.y1 += dy; a.y2 += dy; }
    else { a.x += dx; a.y += dy; }
    const el = v.ga.querySelector(`[data-aid="${a.id}"]`); if (el) updAnnEl(el, a);
    drawSel(e);
  } else if (drag.mode === 'resize') {
    drag.moved = true;
    if (a.type === 'img' || a.type === 'text') {
      const ratio = drag.h0 / drag.w0;
      const w = Math.max(12, p[0] - a.x); a.w = w; a.h = w * ratio;
      if (a.type === 'text') a.size = Math.max(4, drag.size0 * w / drag.w0);
    } else { a.w = Math.max(3, p[0] - a.x); a.h = Math.max(3, p[1] - a.y); }
    const el = v.ga.querySelector(`[data-aid="${a.id}"]`); if (el) updAnnEl(el, a);
    drawSel(e);
  }
});
function endDrag() {
  if (!drag) return;
  const d = drag; drag = null;
  if (d.mode === 'pick') return void retextDragEnd(d);
  const { e, a } = d;
  if (d.mode === 'draw') {
    if (a.type === 'pen' && a.pts.length === 2) a.pts.push(a.pts[0], a.pts[1]);   // 單點也能成為一個圓點
    const tiny = (a.type === 'hl' || a.type === 'redact' || a.type === 'crop') ? (a.w < 2 || a.h < 2) : (a.type === 'line' ? Math.hypot(a.x2 - a.x1, a.y2 - a.y1) < 2 : false);
    if (tiny) { e.anns = e.anns.filter(x => x !== a); history.pop(); renderOverlay(e); updateButtons(); return; }
    if (a.type === 'crop') {             // 每頁只有一個裁切框:新的取代舊的;畫完切到選取工具方便調整
      e.anns = e.anns.filter(x => x.type !== 'crop' || x === a);
      setTool('select'); renderOverlay(e); selectAnn(e.uid, a.id);
    }
    if (a.type === 'hl' || a.type === 'redact' || a.type === 'line') { /* 保持畫圖工具,方便連續標註 */ }
    refreshThumbClasses(); updateButtons();
  } else if (d.mode === 'move') {
    if (!d.moved) history.pop();
    updateButtons();
  } else if (d.mode === 'resize') {
    if (a.type === 'text') { const t = renderTextAsset(a.text, a); a.asset = t.id; a.w = t.w; a.h = t.h; renderOverlay(e); }
    updateButtons();
  }
  if (S.showText && (a.type === 'redact' || a.type === 'erase')) drawTextView(e);   // 顯示文字層跟著塗黑、改字框更新
}
pagesEl.addEventListener('pointerup', endDrag);
pagesEl.addEventListener('pointercancel', endDrag);
pagesEl.addEventListener('dblclick', ev => {
  if (S.tool !== 'select') return;
  // 指標被 pagesEl 擷取後,事件目標會變成 pagesEl,所以改用座標找出頁面
  const pvEl = document.elementsFromPoint(ev.clientX, ev.clientY).map(x => x.closest && x.closest('.pv')).find(Boolean);
  if (!pvEl) return;
  const e = pageByUid(pvEl.dataset.uid), p = evBase(ev, pvEl, e);
  for (let i = e.anns.length - 1; i >= 0; i--) {
    const a = e.anns[i];
    if (a.type === 'text' && hitAnn(a, p, 4 / zoomPx())) { editText(e, a); return; }
  }
});

function placePending(e, p) {
  const as = assets.get(S.pending); if (!as) return;
  const isSign = S.pendingKind === 'sign';
  const w = isSign ? Math.min(150, e.w * 0.5) : Math.max(40, Math.min(as.w * 0.75, e.w * 0.45));
  const h = w * as.h / as.w;
  const x = clamp(p[0] - w / 2, 0, Math.max(0, e.w - w)), y = clamp(p[1] - h / 2, 0, Math.max(0, e.h - h));
  checkpoint();
  const a = { id: newAnnId(), type: 'img', asset: as.id, x, y, w, h };
  e.anns.push(a);
  S.pending = null;
  setTool('select');
  renderOverlay(e); selectAnn(e.uid, a.id); refreshThumbClasses(); updateButtons();
}


/* 觸控:選取工具時,手指按在標註(或縮放把手)上就擋下捲動,讓 pointer 事件移動或縮放標註;按在空白處照常捲動 */
pagesEl.addEventListener('touchstart', ev => {
  if (S.tool !== 'select' || ev.touches.length !== 1) return;
  const pvEl = ev.target.closest('.pv'); if (!pvEl) return;
  const e = pageByUid(pvEl.dataset.uid); if (!e) return;
  const p = evBase(ev.touches[0], pvEl, e), zz = zoomPx(), cur = selAnnObj();
  let hit = e.anns.some(a => hitAnn(a, p, 5 / zz));
  if (!hit && cur && S.selAnn.uid === e.uid && resizable(cur)) {
    const b = bbox(cur);
    hit = Math.hypot(p[0] - (b.x + b.w), p[1] - (b.y + b.h)) <= 12 / zz;
  }
  if (hit) ev.preventDefault();
}, { passive: false });
