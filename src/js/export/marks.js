/* =====================================================================
   浮水印與頁碼
   ===================================================================== */
const markCache = new Map();
function markAsset(text, size, color) {
  const key = JSON.stringify([text, size, color]);
  let a = markCache.get(key);
  if (!a) { a = renderTextAsset(text, { size, color, bold: false, font: 'sans' }); markCache.set(key, a); }
  return a;
}
function markItems(e, gi, total) {
  const items = [], m = S.mark, [dw, dh] = dispSize(e);
  const push = (as, dcx, dcy, w, h, angleDisp, opacity) => {
    const b = dispToBase(dcx, dcy, e);
    items.push({ asset: as.id, cx: b[0], cy: b[1], w, h, angle: angleDisp - e.r, opacity });
  };
  if (m.wm.on && m.wm.text.trim()) {
    const as = markAsset(m.wm.text, m.wm.size, m.wm.color), rad = Math.abs(m.wm.angle) * Math.PI / 180;
    let w = as.w, h = as.h;
    if (!m.wm.tile) {
      const bw = w * Math.abs(Math.cos(rad)) + h * Math.abs(Math.sin(rad)), bh = w * Math.abs(Math.sin(rad)) + h * Math.abs(Math.cos(rad));
      const k = Math.min(1, dw * 0.9 / bw, dh * 0.9 / bh);
      push(as, dw / 2, dh / 2, w * k, h * k, m.wm.angle, m.wm.opacity / 100);
    } else {
      const sx = Math.max(w, h) * 1.25, sy = Math.max(h * 3, w * 0.7);
      let row = 0;
      for (let y = sy / 2; y < dh + sy / 2; y += sy, row++) for (let x = (row % 2 ? sx : sx / 2); x < dw + sx / 2; x += sx * 1) push(as, x - (row % 2 ? sx / 2 : 0), y, w, h, m.wm.angle, m.wm.opacity / 100);
    }
  }
  if (m.pn.on) {
    const n = m.pn.start + gi, tot = total + m.pn.start - 1;
    const text = m.pn.fmt.replace('{n}', n).replace('{total}', tot);
    const as = markAsset(text, m.pn.size, m.pn.color), mg = m.pn.margin;
    const cx = m.pn.pos[1] === 'l' ? mg + as.w / 2 : m.pn.pos[1] === 'r' ? dw - mg - as.w / 2 : dw / 2;
    const cy = m.pn.pos[0] === 't' ? mg + as.h / 2 : dh - mg - as.h / 2;
    push(as, cx, cy, as.w, as.h, 0, 1);
  }
  return items;
}
function readMarkInputs() {
  const m = S.mark;
  m.wm = { on: $('#wmOn').checked, text: $('#wmText').value, size: clamp(+$('#wmSize').value || 72, 8, 300), color: $('#wmColor').value, opacity: +$('#wmOpacity').value, angle: +$('#wmAngle').value, tile: $('#wmTile').checked };
  m.pn = { on: $('#pnOn').checked, fmt: $('#pnFmt').value, pos: $('#pnPos').value, size: clamp(+$('#pnSize').value || 11, 6, 40), color: $('#pnColor').value, margin: clamp(+$('#pnMargin').value || 0, 0, 120), start: parseInt($('#pnStart').value) || 0 };
  $('#wmSub').inert = !m.wm.on; $('#wmSub').style.opacity = m.wm.on ? 1 : .45;
  $('#pnSub').inert = !m.pn.on; $('#pnSub').style.opacity = m.pn.on ? 1 : .45;
}
$$('#dlgMark input, #dlgMark select').forEach(el => el.addEventListener('input', () => { readMarkInputs(); refreshAllOverlays(); }));
$('#btnMark').onclick = () => { readMarkInputs(); $('#dlgMark').showModal(); };
$('#markOk').onclick = () => $('#dlgMark').close();

