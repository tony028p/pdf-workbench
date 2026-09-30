/* =====================================================================
   文字版面分析(純函式,不碰 DOM 與 pdf.js,方便單獨測試)
   輸入:已轉到「文字座標系」的文字片段(文字方向朝 +x、y 向下)
     { str, x, y(基線), w, size, top, bottom }
   輸出:依閱讀順序排列的段落 [{ text, lines: [...] }]
   步驟:分欄 → 分行 → 依欄與跨欄標題排出閱讀順序 → 分段 → 合併換行
   ===================================================================== */
const CJK_RE = /[⺀-鿿豈-﫿︰-﹏＀-￯　-〿぀-ヿ가-힯]/;
const isCJK = ch => !!ch && CJK_RE.test(ch);
const LIST_RE = /^\s*([•●○■□◆◇▪◦‧・\-–—*]\s|\d{1,3}[.)、]\s*|[(（]\d{1,3}[)）]|[一二三四五六七八九十]{1,3}[、.]|[(（][一二三四五六七八九十]{1,3}[)）])/;
const FW_PUNCT_RE = /[\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]/;
const END_PUNCT_RE = /[。！？!?:：.;；」』）)]$/;

const median = arr => {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/* 同一行內兩段文字之間要不要補空格 */
function joinInline(prev, cur) {
  const a = prev.str, b = cur.str;
  const gap = cur.x - (prev.x + prev.w), em = Math.max(1, Math.min(prev.size, cur.size));
  if (/\s$/.test(a) || /^\s/.test(b)) return '';
  if (isCJK(a[a.length - 1]) && isCJK(b[0])) return gap > em ? ' ' : '';
  // 全形標點旁不加空格(OCR 的字框只包住筆跡,全形逗號、句號與前一個字之間看起來有空隙)
  if (FW_PUNCT_RE.test(a[a.length - 1]) || FW_PUNCT_RE.test(b[0])) return gap > em ? ' ' : '';
  return gap > 0.2 * em ? ' ' : '';
}

/* 段落內的換行要怎麼接:中日韓文字直接相接、英文補空格、行尾連字號接回 */
function joinLines(a, b) {
  if (/[A-Za-z]-$/.test(a) && /^[a-z]/.test(b)) return a.slice(0, -1) + b;
  if (isCJK(a[a.length - 1]) || isCJK(b[0])) return a + b;
  return a + ' ' + b;
}

/* 把同一區域內的片段依基線分行 */
function buildLines(items) {
  const sorted = items.slice().sort((p, q) => p.y - q.y || p.x - q.x);
  const lines = [];
  let cur = null;
  for (const it of sorted) {
    if (cur && Math.abs(it.y - cur.y) <= 0.5 * Math.max(1, Math.min(it.size, cur.size))) {
      cur.items.push(it);
    } else {
      cur = { y: it.y, size: it.size, items: [it] };
      lines.push(cur);
    }
  }
  for (const ln of lines) {
    ln.items.sort((p, q) => p.x - q.x);
    // 假粗體:同一段文字重複畫兩次、位置只差一點點,只留一份
    ln.items = ln.items.filter((it, i, arr) => !(i && it.str === arr[i - 1].str && Math.abs(it.x - arr[i - 1].x) < 0.15 * it.size));
    let text = '';
    ln.items.forEach((it, i) => { text += (i ? joinInline(ln.items[i - 1], it) : '') + it.str; });
    ln.text = text.replace(/\s+$/, '').replace(/^\s+/, '');
    ln.x = ln.items[0].x;
    ln.right = Math.max(...ln.items.map(it => it.x + it.w));
    ln.size = median(ln.items.map(it => it.size));
  }
  return lines.filter(ln => ln.text);
}

/* 找欄間的垂直空白帶;回傳欄的分界 x(由左到右) */
function findColumnCuts(items, minX, maxX) {
  const W = maxX - minX;
  if (W <= 0) return [];
  const narrow = items.filter(it => it.w < 0.55 * W);
  if (narrow.length < 6) return [];
  // 每個位置被幾段文字佔用;欄距允許少數橫跨的文字(頁首聲明、跨欄標題),它們之後會當成跨欄處理
  const BIN = 2, n = Math.ceil(W / BIN) + 1, occ = new Uint16Array(n);
  for (const it of narrow) {
    const a = Math.max(0, Math.floor((it.x - minX) / BIN)), b = Math.min(n - 1, Math.ceil((it.x + it.w - minX) / BIN));
    for (let i = a; i <= b; i++) occ[i]++;
  }
  const tol = Math.max(1, Math.floor(0.04 * narrow.length)), busy = i => occ[i] > tol;
  const gaps = [];
  for (let i = 0; i < n; i++) {
    if (busy(i)) continue;
    let j = i; while (j + 1 < n && !busy(j + 1)) j++;
    const x0 = minX + i * BIN, x1 = minX + (j + 1) * BIN, mid = (x0 + x1) / 2;
    if (x1 - x0 >= Math.max(10, 0.02 * W) && mid > minX + 0.2 * W && mid < minX + 0.8 * W) gaps.push({ x0, x1, mid });
    i = j;
  }
  const cuts = [];
  for (const g of gaps.sort((p, q) => (q.x1 - q.x0) - (p.x1 - p.x0))) {
    const left = narrow.filter(it => it.x + it.w <= g.x0 + 1), right = narrow.filter(it => it.x >= g.x1 - 1);
    // 兩邊都要有一定數量的文字(側欄通常字少,例如正文旁的作者欄,所以門檻只要 10% 且至少 4 段)
    const need = Math.max(4, 0.1 * narrow.length);
    if (left.length < need || right.length < need) continue;
    // 左右兩邊要有重疊的高度範圍,才是並排的欄(而不是上下兩塊)
    const ly0 = Math.min(...left.map(it => it.top)), ly1 = Math.max(...left.map(it => it.bottom));
    const ry0 = Math.min(...right.map(it => it.top)), ry1 = Math.max(...right.map(it => it.bottom));
    const overlap = Math.min(ly1, ry1) - Math.max(ly0, ry0);
    if (overlap < 0.3 * Math.min(ly1 - ly0, ry1 - ry0)) continue;
    cuts.push(g.mid);
    if (cuts.length === 2) break;
  }
  return cuts.sort((a, b) => a - b);
}

/* 依閱讀順序排出行:每一欄由上而下、欄由左而右;跨欄的行(例如標題)會切開前後段落 */
function orderLines(items, minX, maxX) {
  const cuts = findColumnCuts(items, minX, maxX);
  if (!cuts.length) return [buildLines(items).map(ln => ({ ...ln, region: 0 }))];
  const bounds = [minX - 1e6, ...cuts, maxX + 1e6];
  const regionOf = it => {
    for (let c = 0; c < bounds.length - 1; c++) if (it.x >= bounds[c] - 1 && it.x + it.w <= bounds[c + 1] + 1) return c;
    return -1;   // 跨欄
  };
  // 同一行只要有一段跨過欄距(例如頁首聲明、跨欄標題),整行都當成跨欄,才不會被切成左中右三段
  const lineRegion = new Map();
  for (const ln of buildLines(items)) if (ln.items.some(it => regionOf(it) === -1)) for (const it of ln.items) lineRegion.set(it, -1);
  const byRegion = new Map();
  for (const it of items) { const r = lineRegion.has(it) ? -1 : regionOf(it); if (!byRegion.has(r)) byRegion.set(r, []); byRegion.get(r).push(it); }
  const cols = [];
  for (let c = 0; c < bounds.length - 1; c++) cols.push(buildLines(byRegion.get(c) || []).map(ln => ({ ...ln, region: c })));
  const spans = buildLines(byRegion.get(-1) || []).map(ln => ({ ...ln, region: -1 }));
  const chunks = [];
  let prevY = -Infinity;
  for (const s of [...spans, null]) {
    const y = s ? s.y : Infinity;
    for (const col of cols) {
      const part = col.filter(ln => ln.y > prevY && ln.y <= y && ln !== s);
      if (part.length) chunks.push(part);
    }
    if (s) chunks.push([s]);
    prevY = y;
  }
  return mergeSpanChunks(chunks);
}
/* 連續的跨欄行(例如全寬的段落)合併成同一塊,才能正確分段 */
function mergeSpanChunks(chunks) {
  const out = [];
  for (const ch of chunks) {
    const last = out[out.length - 1];
    if (last && ch[0].region === -1 && last[0].region === -1) last.push(...ch);
    else out.push(ch);
  }
  return out;
}

/* 這一行的第一個字(英文單字或一個中文字)有多寬 */
function firstWordWidth(ln) {
  const it = ln.items.find(i => i.str.trim());
  if (!it) return 0;
  const s = it.str.replace(/^\s+/, ''), m = s.match(/^[^\s]*?(?=\s|$)/), word = isCJK(s[0]) ? s[0] : (m ? m[0] : s);
  return it.w * word.length / Math.max(1, it.str.length);
}

/* 同一欄連續的行 → 段落
   cellRight:儲存格內文字可用的右界;下一行的第一個字其實放得進上一行卻換行了 → 刻意換行(例如格子裡逐行列出的項目),分段 */
function buildParagraphs(lines, cell = false, cellRight = null) {
  if (!lines.length) return [];
  const steps = [];
  for (let i = 1; i < lines.length; i++) { const d = lines[i].y - lines[i - 1].y; if (d > 0) steps.push(d); }
  // 一般行距:取相鄰行距的中位數,但最多字級的 1.5 倍(行數少、段落間距多時,中位數會被段落間距拉大)
  const sizeMed = median(lines.map(l => l.size));
  const lead = Math.min(median(steps) || sizeMed * 1.2, sizeMed * 1.5);
  const left = Math.min(...lines.map(l => l.x)), right = Math.max(...lines.map(l => l.right)), width = right - left;
  const paras = [];
  let cur = null;
  lines.forEach((ln, i) => {
    const prev = lines[i - 1];
    let brk = !prev;
    if (prev) {
      const dy = ln.y - prev.y, shortBy = right - prev.right;
      // 清單項目的縮排續行(比項目符號那一行更靠右)要接回同一項
      const listCont = cur && LIST_RE.test(cur.text) && !LIST_RE.test(ln.text) && ln.x > cur.lines[0].x + 0.5 * ln.size;
      brk = dy > 1.45 * lead + 0.5
        || dy < 0
        || Math.abs(ln.size - prev.size) > 0.2 * Math.max(ln.size, prev.size)
        || LIST_RE.test(ln.text)
        || (cell && cellRight != null && prev.right + 0.3 * prev.size + firstWordWidth(ln) < cellRight)
        // 表格儲存格裡的行常是置中或欄很窄,行長與縮排不代表分段
        || (!cell && !listCont && shortBy > 2 * prev.size && END_PUNCT_RE.test(prev.text))
        || (!cell && !listCont && shortBy > 0.35 * width)
        || (!cell && !listCont && ln.x > left + 1.5 * ln.size && prev.x <= left + 0.5 * prev.size);
    }
    if (brk) { cur = { lines: [], text: '' }; paras.push(cur); cur.text = ln.text; }
    else cur.text = joinLines(cur.text, ln.text);
    cur.lines.push(ln);
  });
  return paras;
}

/* 主要入口:片段 → 段落(依閱讀順序) */
function layoutText(items, minX, maxX, { cell = false, cellRight = null } = {}) {
  const usable = items.filter(it => it.str && it.str.trim());
  if (!usable.length) return [];
  if (cell) return buildParagraphs(buildLines(usable), true, cellRight);   // 儲存格:不再分欄
  return orderLines(usable, minX, maxX).flatMap(ch => buildParagraphs(ch));
}
