/* =====================================================================
   OCR worker(PaddleOCR PP-OCRv5 mobile,onnxruntime-web WASM 單執行緒)
   - build.py --ocr 把 ort.wasm.min.js 與這個檔案串成一個 Blob Worker;不在 src/js 內,不會進主程式
   - 前後處理依 PaddleOCR 預設參數(比較與取捨見 docs/OCR_SPIKE.md):
       偵測 DB:thresh 0.3、box_thresh 0.6、unclip 1.5、min_size 3;辨識:高 48、寬依比例(至少 320)
   - 訊息:
       → { type:'init', wasm, mjs, det, rec, dict }            ← { type:'ready' }
       → { type:'recognize', id, bitmap, opts }                 ← { type:'progress', id, done, total } …
                                                                ← { type:'result', id, lines } 或 { type:'error', id, message }
     lines:[{ str, conf, angle, box:{cx,cy,w,h}, words:[{ str, conf, quad:[[x,y]×4] }] }](輸入影像的像素座標)
       quad 依序為文字方向的左上、右上、右下、左下
   ===================================================================== */
let det = null, rec = null, chars = null;

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      ort.env.wasm.numThreads = 1;           // file:// 沒有 SharedArrayBuffer
      ort.env.wasm.wasmBinary = data.wasm;
      ort.env.wasm.wasmPaths = { mjs: URL.createObjectURL(new Blob([data.mjs], { type: 'text/javascript' })) };
      det = await ort.InferenceSession.create(data.det, { executionProviders: ['wasm'] });
      rec = await ort.InferenceSession.create(data.rec, { executionProviders: ['wasm'] });
      chars = ['', ...new TextDecoder().decode(data.dict).split('\n'), ' '];   // 0 = CTC blank;最後是空白
      self.postMessage({ type: 'ready' });
    } else if (data.type === 'recognize') {
      const lines = await recognize(data.bitmap, data.opts || {}, (done, total) => self.postMessage({ type: 'progress', id: data.id, done, total }));
      data.bitmap.close();
      self.postMessage({ type: 'result', id: data.id, lines });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: data.id, message: String(err && err.message || err) });
  }
};

async function recognize(bitmap, { detMaxSide = 1280 }, progress) {
  const boxes = await detect(bitmap, detMaxSide);
  const lines = [];
  for (let i = 0; i < boxes.length; i++) {
    const ln = await recognizeBox(bitmap, boxes[i]);
    if (ln) lines.push(ln);
    if (i % 8 === 7 || i === boxes.length - 1) progress(i + 1, boxes.length);
  }
  return lines;
}

async function detect(bitmap, detMaxSide) {
  const W = bitmap.width, H = bitmap.height;
  const s = Math.min(1, detMaxSide / Math.max(W, H));
  const dw = Math.max(32, Math.round(W * s / 32) * 32), dh = Math.max(32, Math.round(H * s / 32) * 32);
  const c = new OffscreenCanvas(dw, dh), g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bitmap, 0, 0, dw, dh);
  const px = g.getImageData(0, 0, dw, dh).data;
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225], N = dw * dh, x = new Float32Array(3 * N);
  for (let i = 0; i < N; i++) {           // PaddleOCR 以 BGR 讀圖,再依序套 mean/std
    x[i] = (px[i * 4 + 2] / 255 - mean[0]) / std[0];
    x[N + i] = (px[i * 4 + 1] / 255 - mean[1]) / std[1];
    x[2 * N + i] = (px[i * 4] / 255 - mean[2]) / std[2];
  }
  const out = await det.run({ [det.inputNames[0]]: new ort.Tensor('float32', x, [1, 3, dh, dw]) });
  return dbPostprocess(out[det.outputNames[0]].data, dw, dh, W / dw, H / dh);
}

async function recognizeBox(bitmap, box) {
  let { cx, cy, w, h, angle } = box;
  if (h >= w * 1.5) { [w, h] = [h, w]; angle -= Math.PI / 2; }   // 直書:轉 90° 後辨識
  const k = 48 / h, cw = Math.max(1, Math.round(w * k)), inW = Math.max(320, cw);
  const c = new OffscreenCanvas(cw, 48), g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, cw, 48);
  g.translate(cw / 2, 24); g.scale(k, k); g.rotate(-angle); g.translate(-cx, -cy);
  g.drawImage(bitmap, 0, 0);
  const px = g.getImageData(0, 0, cw, 48).data, x = new Float32Array(3 * 48 * inW);   // 右側補 0(正規化後的中間灰)
  for (let yy = 0; yy < 48; yy++) for (let xx = 0; xx < cw; xx++) {
    const i = (yy * cw + xx) * 4, o = yy * inW + xx;
    x[o] = px[i + 2] / 127.5 - 1; x[48 * inW + o] = px[i + 1] / 127.5 - 1; x[96 * inW + o] = px[i] / 127.5 - 1;
  }
  const out = await rec.run({ [rec.inputNames[0]]: new ort.Tensor('float32', x, [1, 3, 48, inW]) });
  const t = out[rec.outputNames[0]], [, T, C] = t.dims, p = t.data;
  // CTC 貪婪解碼,記下每個字出現的時間步
  const hits = [];
  let prev = -1;
  for (let i = 0; i < T; i++) {
    let best = 0, bp = -1;
    for (let j = 0, o = i * C; j < C; j++) if (p[o + j] > bp) { bp = p[o + j]; best = j; }
    if (best !== 0 && best !== prev) hits.push({ c: chars[best], t0: i, t1: i, conf: bp });
    else if (best !== 0) { const hh = hits[hits.length - 1]; hh.t1 = i; hh.conf = Math.max(hh.conf, bp); }
    prev = best;
  }
  if (!hits.length) return null;
  // 字的左右界:CTC 時間步只給字的大概中心。相鄰兩字中心之間最長的一段空白欄就是交界
  // (找不到空白才用中點);第一個與最後一個字收緊到筆跡。字詞之間的真實空白因此保留,版面分析才能補回空格
  const step = inW / T, mid = hits.map(hh => (hh.t0 + hh.t1 + 1) / 2 * step);
  const ink = inkColumns(px, cw);
  const cells = hits.map(hh => ({ c: hh.c, conf: hh.conf, a: 0, b: cw }));
  for (let i = 0; i + 1 < cells.length; i++) {
    const lo = Math.max(0, Math.round(mid[i])), hi = Math.min(cw - 1, Math.round(mid[i + 1]));
    let best = null;
    for (let x0 = lo; x0 <= hi;) {
      if (ink[x0]) { x0++; continue; }
      let x1 = x0; while (x1 + 1 <= hi && !ink[x1 + 1]) x1++;
      if (!best || x1 - x0 > best[1] - best[0]) best = [x0, x1];
      x0 = x1 + 1;
    }
    if (best) { cells[i].b = best[0]; cells[i + 1].a = best[1] + 1; }
    else cells[i].b = cells[i + 1].a = (mid[i] + mid[i + 1]) / 2;
  }
  if (cells.length) {
    const first = cells[0], last = cells[cells.length - 1];
    while (first.a < first.b - 1 && !ink[Math.floor(first.a)]) first.a++;
    while (last.b > last.a + 1 && !ink[Math.ceil(last.b) - 1]) last.b--;
  }
  normalizeNumbers(cells);
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const toSrc =(u, v) => { const du = (u - cw / 2) / k, dv = (v - 24) / k; return [cx + du * cos - dv * sin, cy + du * sin + dv * cos]; };
  // 字詞:中日韓文字一字一詞;連續的英數字母合成一詞;空白斷詞
  const latin = ch => /[A-Za-z0-9À-ɏ\-.,'’%\/:&@_#$+]/.test(ch);
  const words = [];
  let cur = null;
  for (const cell of cells) {
    if (cell.c === ' ' || cell.c === '　') { cur = null; continue; }
    if (cur && latin(cell.c) && latin(cur.last)) { cur.str += cell.c; cur.b = cell.b; cur.confs.push(cell.conf); cur.last = cell.c; }
    else { cur = { str: cell.c, a: cell.a, b: cell.b, confs: [cell.conf], last: cell.c }; words.push(cur); }
  }
  return {
    str: cells.map(cc => cc.c).join('').trim(), angle, box: { cx, cy, w, h },
    conf: 100 * hits.reduce((s, v) => s + v.conf, 0) / hits.length,
    words: words.map(wd => ({
      str: wd.str, conf: 100 * wd.confs.reduce((s, v) => s + v, 0) / wd.confs.length,
      quad: [toSrc(wd.a, 0), toSrc(wd.b, 0), toSrc(wd.b, 48), toSrc(wd.a, 48)],
    })),
  };
}

/* 每一欄有沒有筆跡(比亮暗的中間值暗;上下各略過 4px,避免碰到鄰行) */
function inkColumns(px, cw) {
  const gray = new Uint8Array(cw * 48), ink = new Uint8Array(cw);
  let lo = 255, hi = 0;
  for (let i = 0; i < cw * 48; i++) { const v = (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]) / 3; gray[i] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
  if (hi - lo < 40) return ink.fill(1);   // 對比太低:當成整條都有字,交界退回用中點
  const thr = (lo + hi) / 2;
  for (let x = 0; x < cw; x++) for (let y = 4; y < 44; y++) if (gray[y * cw + x] < thr) { ink[x] = 1; break; }
  return ink;
}

/* 數字:全形數字轉半形;數字之間的全形逗號、句點(模型在中文語境常輸出全形)轉成千分位逗號與小數點,
   例如 1，284．6 → 1,284.6。只改兩側都是數字的標點 */
function normalizeNumbers(cells) {
  const digit = c => c >= '0' && c <= '9';
  for (const cell of cells) if (cell.c >= '０' && cell.c <= '９') cell.c = String.fromCharCode(cell.c.charCodeAt(0) - 0xFEE0);
  for (let i = 1; i + 1 < cells.length; i++) {
    if (!digit(cells[i - 1].c) || !digit(cells[i + 1].c)) continue;
    // 千分位:後面剛好三位數字
    const three = [1, 2, 3].every(k => cells[i + k] && digit(cells[i + k].c)) && !(cells[i + 4] && digit(cells[i + 4].c));
    if (cells[i].c === '，' && three) cells[i].c = ',';
    else if (cells[i].c === '．' || cells[i].c === '·') cells[i].c = '.';   // 「。」與「、」可能是真的句讀(「共 3 頁。4 月…」「1、2」),不動
  }
}

/* DB 後處理:二值化 → 連通區域 → 以主成分方向求旋轉外框 → 分數過濾 → 外擴(unclip)
   回傳原圖座標的旋轉矩形 { cx, cy, w, h, angle }(angle 為沿文字方向的弧度) */
function dbPostprocess(prob, dw, dh, sx, sy, { thresh = 0.3, boxThresh = 0.6, unclip = 1.5, minSize = 3 } = {}) {
  const N = dw * dh, seen = new Uint8Array(N), stack = new Int32Array(N), boxes = [];
  for (let s0 = 0; s0 < N; s0++) {
    if (seen[s0] || prob[s0] <= thresh) continue;
    let sp = 0, n = 0, sumP = 0, mx = 0, my = 0, sxx = 0, syy = 0, sxy = 0;
    const pts = [];
    stack[sp++] = s0; seen[s0] = 1;
    while (sp) {
      const i = stack[--sp], px = i % dw, py = (i - px) / dw;
      pts.push(px, py); n++; sumP += prob[i];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const qx = px + dx, qy = py + dy;
        if ((dx || dy) && qx >= 0 && qy >= 0 && qx < dw && qy < dh) {
          const j = qy * dw + qx;
          if (!seen[j] && prob[j] > thresh) { seen[j] = 1; stack[sp++] = j; }
        }
      }
    }
    if (n < minSize * minSize || sumP / n < boxThresh) continue;
    for (let k = 0; k < pts.length; k += 2) { mx += pts[k]; my += pts[k + 1]; }
    mx /= n; my /= n;
    for (let k = 0; k < pts.length; k += 2) { const ax = pts[k] - mx, ay = pts[k + 1] - my; sxx += ax * ax; syy += ay * ay; sxy += ax * ay; }
    let angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    // 接近正方形(單字)時主軸方向不穩定,限制在 ±45° 內,讓方框維持直立
    if (angle > Math.PI / 4) angle -= Math.PI / 2;
    if (angle < -Math.PI / 4) angle += Math.PI / 2;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let k = 0; k < pts.length; k += 2) {
      const ax = pts[k] - mx, ay = pts[k + 1] - my, u = ax * cos + ay * sin, v = -ax * sin + ay * cos;
      if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    let w = u1 - u0 + 1, h = v1 - v0 + 1;
    if (Math.min(w, h) < minSize) continue;
    const d = w * h * unclip / (2 * (w + h)), cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
    w += 2 * d; h += 2 * d;
    const sm = (sx + sy) / 2;
    boxes.push({ cx: (mx + cu * cos - cv * sin + 0.5) * sx, cy: (my + cu * sin + cv * cos + 0.5) * sy, w: w * sm, h: h * sm, angle });
  }
  return boxes;
}
