/* =====================================================================
   PDF 內容串流(content stream)解析:把繪圖指令切成 { op, args, start, end }
   - start/end 是這個指令(含運算元)在串流中的位元組範圍,移除浮水印時直接刪掉或替換這段
   - 運算元:數字、名稱、字串(保留原始位元組範圍)、十六進位字串、陣列、字典
   - 內嵌影像 BI … ID <二進位> EI 整段當成一個 'BI' 指令
   ===================================================================== */
const CS_WS = c => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const CS_DELIM = c => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
const latin1 = (b, s, e) => { let out = ''; for (let i = s; i < e; i++) out += String.fromCharCode(b[i]); return out; };

function lexContent(b) {
  const n = b.length, ops = [], stack = [[]];
  let i = 0, argStart = -1;
  const push = (tok, start) => {
    if (stack.length === 1 && argStart < 0) argStart = start;
    stack[stack.length - 1].push(tok);
  };
  const open = start => { if (stack.length === 1 && argStart < 0) argStart = start; stack.push([]); };
  while (i < n) {
    const c = b[i];
    if (CS_WS(c)) { i++; continue; }
    if (c === 37) { while (i < n && b[i] !== 10 && b[i] !== 13) i++; continue; }   // 註解
    const start = i;
    if (c === 40) {                                    // (字串),可巢狀括號、反斜線跳脫
      let depth = 0, j = i;
      for (; j < n; j++) {
        const d = b[j];
        if (d === 92) { j++; continue; }
        if (d === 40) depth++;
        else if (d === 41 && --depth === 0) break;
      }
      push({ t: 'str', s: i + 1, e: j }, start); i = j + 1; continue;
    }
    if (c === 60 && b[i + 1] === 60) { open(start); i += 2; continue; }
    if (c === 62 && b[i + 1] === 62) { const items = stack.length > 1 ? stack.pop() : []; push({ t: 'dict', items }, start); i += 2; continue; }
    if (c === 60) { let j = i + 1; while (j < n && b[j] !== 62) j++; push({ t: 'hex', s: i + 1, e: j }, start); i = j + 1; continue; }
    if (c === 91) { open(start); i++; continue; }
    if (c === 93) { const items = stack.length > 1 ? stack.pop() : []; push({ t: 'arr', items }, start); i++; continue; }
    if (c === 47) { let j = i + 1; while (j < n && !CS_WS(b[j]) && !CS_DELIM(b[j])) j++; push({ t: 'name', v: latin1(b, i + 1, j) }, start); i = j; continue; }
    let j = i;
    while (j < n && !CS_WS(b[j]) && !CS_DELIM(b[j])) j++;
    if (j === i) { i++; continue; }                    // 多餘的分隔字元
    const w = latin1(b, i, j);
    i = j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) { push({ t: 'num', v: parseFloat(w) }, start); continue; }
    if (w === 'true' || w === 'false') { push({ t: 'bool', v: w === 'true' }, start); continue; }
    if (w === 'null') { push({ t: 'null' }, start); continue; }
    if (stack.length > 1) { push({ t: 'kw', v: w }, start); continue; }
    const op = { op: w, args: stack[0], start: argStart < 0 ? start : argStart, end: i };
    if (w === 'BI') { op.end = i = skipInlineImage(b, i); }
    ops.push(op);
    stack[0] = []; argStart = -1;
  }
  return ops;
}

/* 內嵌影像:BI 之後找「ID + 空白」,再找「空白 + EI + 空白/結尾」 */
function skipInlineImage(b, i) {
  const n = b.length;
  for (; i + 2 < n; i++) if (b[i] === 73 && b[i + 1] === 68 && CS_WS(b[i + 2]) && CS_WS(b[i - 1])) break;
  for (i += 3; i + 2 < n; i++) if (CS_WS(b[i]) && b[i + 1] === 69 && b[i + 2] === 73 && (i + 3 >= n || CS_WS(b[i + 3]))) return i + 3;
  return n;
}

/* 字典運算元 → Map(名稱 → 值 token) */
function csDict(tok) {
  const m = new Map();
  if (!tok || tok.t !== 'dict') return m;
  for (let k = 0; k + 1 < tok.items.length; k += 2) if (tok.items[k].t === 'name') m.set(tok.items[k].v, tok.items[k + 1]);
  return m;
}

/* 刪除或替換位元組範圍:edits = [{ start, end, text }](text 為替換內容,空字串 = 刪除) */
function spliceBytes(b, edits) {
  const sorted = edits.slice().sort((x, y) => x.start - y.start), parts = [];
  let pos = 0;
  for (const ed of sorted) {
    if (ed.start < pos) continue;                      // 重疊的範圍(外層已經刪掉)
    parts.push(b.subarray(pos, ed.start));
    if (ed.text) parts.push(new TextEncoder().encode(' ' + ed.text + ' '));
    pos = ed.end;
  }
  parts.push(b.subarray(pos));
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
