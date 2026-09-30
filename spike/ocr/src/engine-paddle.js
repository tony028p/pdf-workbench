// PaddleOCR(PP-OCRv5 mobile)引擎,以 onnxruntime-web(WASM、單執行緒)執行。OcrEngine 介面見 docs/ROADMAP.md §4.1。
// 前後處理依 PaddleOCR 3.x 的預設參數自行實作:
//   偵測 DB:thresh 0.3、box_thresh 0.6、unclip_ratio 1.5、min_size 3
//   辨識:高 48、寬依比例(至少 320)、(x/255 - 0.5) / 0.5、CTC 貪婪解碼(0 = blank)
// 離線做法:ort 的 WASM 以 env.wasm.wasmBinary 直接傳入,Emscripten 膠水模組(.mjs)用 Blob URL 動態 import。
const PaddleEngine = {
  name: 'PaddleOCR',
  det: null, rec: null, chars: null,

  async init(onProgress = () => {}) {
    onProgress('解碼 onnxruntime');
    ort.env.wasm.numThreads = 1;              // file:// 沒有 SharedArrayBuffer,只能單執行緒
    ort.env.wasm.wasmBinary = await embedBytes('ort-wasm');
    ort.env.wasm.wasmPaths = { mjs: await embedBlobURL('ort-mjs', 'text/javascript') };
    onProgress('載入偵測模型');
    this.det = await ort.InferenceSession.create(await embedBytes('det'), { executionProviders: ['wasm'] });
    onProgress('載入辨識模型');
    this.rec = await ort.InferenceSession.create(await embedBytes('rec'), { executionProviders: ['wasm'] });
    const dict = (await embedText('dict')).split('\n');
    this.chars = ['', ...dict, ' '];          // 0 = CTC blank;最後補空白(use_space_char)
  },

  // opts.detMaxSide:偵測時長邊縮到這個大小以內(文字偵測不需要 300 dpi;辨識仍從原圖裁切)
  // opts.unclip:文字框外擴比例(PaddleOCR 預設 1.5);opts.sharpen:辨識前銳化(0 = 不做,數字為強度)
  async recognize(canvas, { detMaxSide = 1600, unclip = 1.5, sharpen = 0, timing } = {}) {
    const t0 = performance.now();
    const boxes = await this.detect(canvas, detMaxSide, unclip);
    const t1 = performance.now();
    const words = [], lines = [];
    for (const box of boxes) {
      const line = await this.recognizeBox(canvas, box, sharpen);
      if (!line) continue;
      lines.push(line);
      words.push(...line.words);
    }
    if (timing) Object.assign(timing, { det: t1 - t0, rec: performance.now() - t1, boxes: boxes.length });
    return { words, lines, text: lines.map(l => l.str).join('\n') };
  },

  async detect(canvas, detMaxSide, unclip = 1.5) {
    const W = canvas.width, H = canvas.height;
    const s = Math.min(1, detMaxSide / Math.max(W, H));
    const dw = Math.max(32, Math.round(W * s / 32) * 32), dh = Math.max(32, Math.round(H * s / 32) * 32);
    const c = document.createElement('canvas');
    c.width = dw; c.height = dh;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, dw, dh);
    const px = ctx.getImageData(0, 0, dw, dh).data;
    // PaddleOCR 以 BGR 讀圖,再依序套 mean/std
    const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225], N = dw * dh;
    const x = new Float32Array(3 * N);
    for (let i = 0; i < N; i++) {
      const b = px[i * 4 + 2], g = px[i * 4 + 1], r = px[i * 4];
      x[i] = (b / 255 - mean[0]) / std[0];
      x[N + i] = (g / 255 - mean[1]) / std[1];
      x[2 * N + i] = (r / 255 - mean[2]) / std[2];
    }
    const out = await this.det.run({ [this.det.inputNames[0]]: new ort.Tensor('float32', x, [1, 3, dh, dw]) });
    const prob = out[this.det.outputNames[0]].data;
    return dbPostprocess(prob, dw, dh, W / dw, H / dh, { unclip });
  },

  async recognizeBox(canvas, box, sharpen = 0) {
    let { cx, cy, w, h, angle } = box;
    let vertical = false;
    if (h >= w * 1.5) { vertical = true; [w, h] = [h, w]; angle -= Math.PI / 2; }  // 直書:轉 90° 後辨識
    const k = 48 / h;
    const cw = Math.max(1, Math.round(w * k)), inW = Math.max(320, cw);
    const c = document.createElement('canvas');
    c.width = cw; c.height = 48;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cw, 48);
    ctx.translate(cw / 2, 24);
    ctx.scale(k, k);
    ctx.rotate(-angle);
    ctx.translate(-cx, -cy);
    ctx.drawImage(canvas, 0, 0);
    const px = ctx.getImageData(0, 0, cw, 48).data;
    if (sharpen) unsharp(px, cw, 48, sharpen);
    const x = new Float32Array(3 * 48 * inW);           // 右側補 0(正規化後的中間灰)
    for (let yy = 0; yy < 48; yy++) for (let xx = 0; xx < cw; xx++) {
      const i = (yy * cw + xx) * 4, o = yy * inW + xx;
      x[o] = (px[i + 2] / 255 - 0.5) / 0.5;
      x[48 * inW + o] = (px[i + 1] / 255 - 0.5) / 0.5;
      x[2 * 48 * inW + o] = (px[i] / 255 - 0.5) / 0.5;
    }
    const out = await this.rec.run({ [this.rec.inputNames[0]]: new ort.Tensor('float32', x, [1, 3, 48, inW]) });
    const t = out[this.rec.outputNames[0]];
    const [, T, C] = t.dims, p = t.data;
    // CTC 貪婪解碼,記下每個字出現的時間步,換算成字的位置
    const hits = [];
    let prev = -1;
    for (let i = 0; i < T; i++) {
      let best = 0, bp = -1;
      for (let j = 0, o = i * C; j < C; j++) if (p[o + j] > bp) { bp = p[o + j]; best = j; }
      if (best !== 0 && best !== prev) hits.push({ c: this.chars[best], t0: i, t1: i, conf: bp });
      else if (best !== 0 && best === prev) { const hh = hits[hits.length - 1]; hh.t1 = i; hh.conf = Math.max(hh.conf, bp); }
      prev = best;
    }
    if (!hits.length) return null;
    const step = inW / T;                                  // 一個時間步對應的輸入寬度(px)
    // 字的左右界:與前後字的中點(第一/最後一個字延伸到裁切邊緣)
    const mid = hits.map(hh => (hh.t0 + hh.t1 + 1) / 2 * step);
    const cells = hits.map((hh, i) => ({
      c: hh.c, conf: hh.conf,
      a: i ? (mid[i - 1] + mid[i]) / 2 : 0,
      b: i < hits.length - 1 ? (mid[i] + mid[i + 1]) / 2 : cw,
    }));
    // 裁切圖座標 (u, v) → 原圖座標
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const toSrc = (u, v) => {
      const du = (u - cw / 2) / k, dv = (v - 24) / k;
      return [cx + du * cos - dv * sin, cy + du * sin + dv * cos];
    };
    const bboxOf = (a, b) => {
      const pts = [toSrc(a, 0), toSrc(b, 0), toSrc(a, 48), toSrc(b, 48)];
      const xs = pts.map(q => q[0]), ys = pts.map(q => q[1]);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    };
    // 組成字詞:CJK 等非拉丁字元一字一詞;連續的拉丁字母/數字合成一詞;空白斷詞
    const words = [];
    let cur = null;
    const latin = ch => /[\p{Script=Latin}\p{N}\-.,'’%\/:&@_]/u.test(ch) && !/[　-鿿＀-￯]/.test(ch);
    for (const cell of cells) {
      if (cell.c === ' ' || cell.c === '　') { cur = null; continue; }
      if (cur && latin(cell.c) && latin(cur.last)) {
        cur.str += cell.c; cur.b = cell.b; cur.confs.push(cell.conf); cur.last = cell.c;
      } else {
        cur = { str: cell.c, a: cell.a, b: cell.b, confs: [cell.conf], last: cell.c };
        words.push(cur);
      }
    }
    const outWords = words.map(wd => ({
      str: wd.str, bbox: bboxOf(wd.a, wd.b),
      conf: 100 * wd.confs.reduce((s, v) => s + v, 0) / wd.confs.length,
    }));
    const str = cells.map(cc => cc.c).join('').trim();
    return { str, bbox: bboxOf(0, cw), vertical, conf: 100 * hits.reduce((s, v) => s + v.conf, 0) / hits.length, words: outWords };
  },

  async terminate() {
    await this.det?.release?.();
    await this.rec?.release?.();
    this.det = this.rec = null;
  },
};

// 反銳化遮罩(灰階):g + amount × (g − 模糊);模糊用兩次 3×3 平均近似高斯
function unsharp(px, w, h, amount) {
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]) / 3;
  let a = g, b = new Float32Array(w * h);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy >= 0 && yy < h && xx >= 0 && xx < w) { s += a[yy * w + xx]; n++; }
      }
      b[y * w + x] = s / n;
    }
    [a, b] = [b, pass === 0 ? new Float32Array(w * h) : b];
  }
  for (let i = 0; i < w * h; i++) {
    const v = Math.max(0, Math.min(255, g[i] + amount * (g[i] - a[i])));
    px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v;
  }
}

// DB 後處理:二值化 → 連通區域 → 以主成分方向求旋轉外框 → 分數過濾 → 外擴(unclip)
// 回傳原圖座標的旋轉矩形 { cx, cy, w, h, angle }(angle 為沿文字方向的弧度)
function dbPostprocess(prob, dw, dh, sx, sy, { thresh = 0.3, boxThresh = 0.6, unclip = 1.5, minSize = 3 } = {}) {
  const N = dw * dh, label = new Int32Array(N), stack = new Int32Array(N);
  const boxes = [];
  let nextLabel = 0;
  for (let s0 = 0; s0 < N; s0++) {
    if (label[s0] || prob[s0] <= thresh) continue;
    nextLabel++;
    let sp = 0, n = 0, sumP = 0, mx = 0, my = 0, sxx = 0, syy = 0, sxy = 0;
    const pts = [];
    stack[sp++] = s0; label[s0] = nextLabel;
    while (sp) {
      const i = stack[--sp], px = i % dw, py = (i - px) / dw;
      pts.push(px, py);
      n++; sumP += prob[i];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const qx = px + dx, qy = py + dy;
        if ((dx || dy) && qx >= 0 && qy >= 0 && qx < dw && qy < dh) {
          const j = qy * dw + qx;
          if (!label[j] && prob[j] > thresh) { label[j] = nextLabel; stack[sp++] = j; }
        }
      }
    }
    if (n < minSize * minSize || sumP / n < boxThresh) continue;
    for (let k = 0; k < pts.length; k += 2) { mx += pts[k]; my += pts[k + 1]; }
    mx /= n; my /= n;
    for (let k = 0; k < pts.length; k += 2) {
      const ax = pts[k] - mx, ay = pts[k + 1] - my;
      sxx += ax * ax; syy += ay * ay; sxy += ax * ay;
    }
    let angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    // 接近正方形(單字)時主軸方向不穩定,限制在 ±45° 內,讓方框維持直立
    if (angle > Math.PI / 4) angle -= Math.PI / 2;
    if (angle < -Math.PI / 4) angle += Math.PI / 2;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let k = 0; k < pts.length; k += 2) {
      const ax = pts[k] - mx, ay = pts[k + 1] - my;
      const u = ax * cos + ay * sin, v = -ax * sin + ay * cos;
      if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    let w = u1 - u0 + 1, h = v1 - v0 + 1;
    if (Math.min(w, h) < minSize) continue;
    const d = w * h * unclip / (2 * (w + h));
    const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
    const ccx = mx + cu * cos - cv * sin, ccy = my + cu * sin + cv * cos;
    w += 2 * d; h += 2 * d;
    // 縮放回原圖(sx 與 sy 幾乎相同,取平均換算長寬)
    const sm = (sx + sy) / 2;
    boxes.push({ cx: (ccx + 0.5) * sx, cy: (ccy + 0.5) * sy, w: w * sm, h: h * sm, angle });
  }
  // 由上而下、由左而右
  boxes.sort((a, b) => (Math.abs(a.cy - b.cy) < Math.min(a.h, b.h) / 2 ? a.cx - b.cx : a.cy - b.cy));
  return boxes;
}
