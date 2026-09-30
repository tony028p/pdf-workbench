/* ---------- 簽名 ---------- */
function askSignature() {
  const dlg = $('#dlgSign'), pad = $('#sigpad');
  let strokes = [], cur = null, out = null, uploaded = null;
  const ink = () => $('input[name=sigink]:checked').value;
  const dpr = window.devicePixelRatio || 1;
  function redraw() {
    const g = pad.getContext('2d'); g.clearRect(0, 0, pad.width, pad.height);
    g.lineCap = g.lineJoin = 'round'; g.strokeStyle = ink(); g.lineWidth = 2.6 * dpr;
    for (const s of strokes) {
      g.beginPath();
      s.forEach(([x, y], i) => i ? g.lineTo(x * dpr, y * dpr) : g.moveTo(x * dpr, y * dpr));
      if (s.length === 1) g.lineTo(s[0][0] * dpr + 0.1, s[0][1] * dpr);
      g.stroke();
    }
  }
  const pos = ev => { const r = pad.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
  pad.onpointerdown = ev => { pad.setPointerCapture(ev.pointerId); cur = [pos(ev)]; strokes.push(cur); redraw(); };
  pad.onpointermove = ev => { if (!cur) return; cur.push(pos(ev)); redraw(); };
  pad.onpointerup = pad.onpointercancel = () => { cur = null; };
  $$('input[name=sigink]').forEach(r => r.onchange = redraw);
  $('#sigClear').onclick = () => { strokes = []; uploaded = null; redraw(); };
  $('#sigReuse').hidden = !S.lastSig;
  $('#sigReuse').onclick = () => { out = S.lastSig; dlg.close(); };
  $('#sigUpload').onclick = () => { $('#sigFileIn').value = ''; $('#sigFileIn').click(); };
  $('#sigFileIn').onchange = async ev => {
    const f = ev.target.files[0]; if (!f) return;
    try {
      const c = await fileToBitmapCanvas(f, 1400);
      const g = c.getContext('2d'), d = g.getImageData(0, 0, c.width, c.height), px = d.data;
      for (let i = 0; i < px.length; i += 4) {   // 去除白底
        const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        px[i + 3] = Math.min(px[i + 3], Math.round(clamp((235 - lum) / 95, 0, 1) * 255));
      }
      g.putImageData(d, 0, 0);
      const t = trimCanvas(c);
      if (!t) return toast('這張圖片找不到簽名內容');
      out = addAsset(dataUrlToU8(t.toDataURL('image/png')), 'image/png', t.width, t.height);
      dlg.close();
    } catch (err) { toast('無法讀取圖片:' + err.message); }
  };
  const pr = openModal(dlg, $('#sigOk'), $('#sigCancel'), () => {
    if (out) return out;
    if (!strokes.length) { toast('請先在框內簽名'); return undefined; }
    const K = 3;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    strokes.flat().forEach(([x, y]) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); });
    const m = 6, w = Math.ceil(x1 - x0 + m * 2), h = Math.ceil(y1 - y0 + m * 2);
    const c = document.createElement('canvas'); c.width = w * K; c.height = h * K;
    const g = c.getContext('2d'); g.lineCap = g.lineJoin = 'round'; g.strokeStyle = ink(); g.lineWidth = 2.6 * K;
    for (const s of strokes) {
      g.beginPath();
      s.forEach(([x, y], i) => { const X = (x - x0 + m) * K, Y = (y - y0 + m) * K; i ? g.lineTo(X, Y) : g.moveTo(X, Y); });
      if (s.length === 1) g.lineTo((s[0][0] - x0 + m) * K + 0.1, (s[0][1] - y0 + m) * K);
      g.stroke();
    }
    return addAsset(dataUrlToU8(c.toDataURL('image/png')), 'image/png', c.width, c.height);
  }).then(id => { if (id) S.lastSig = id; return id; });
  requestAnimationFrame(() => { pad.width = pad.clientWidth * dpr; pad.height = pad.clientHeight * dpr; redraw(); });
  return pr;
}
function trimCanvas(c) {
  const g = c.getContext('2d'), d = g.getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 24) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  if (x1 < 0) return null;
  const o = document.createElement('canvas'); o.width = x1 - x0 + 1; o.height = y1 - y0 + 1;
  o.getContext('2d').drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height);
  return o;
}

