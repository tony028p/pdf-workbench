/* =====================================================================
   改字:匯出 PDF 時,把改字框(type 'erase')範圍內的原文字從內容串流刪掉(不是只蓋底色)
   - 字形中心落在框內的字才刪;同一段文字的其他字留在原位(刪掉的字換成 TJ 的位移量)
   - 字寬用 pdf.js 已解析好的字形(getOperatorList 的 showText:含 CID 字型、標準 14 字型、Type3),
     依出現順序和內容串流的文字指令一一對應,並用字碼(originalCharCode)核對;
     整頁對不上時這一頁不動,回報「只能蓋住」
   - 表單 XObject 裡的文字:複製一份改過的表單給這一頁(其他頁仍用原本的)
   ===================================================================== */

/* 字串運算元 → 位元組(字面字串要處理跳脫與換行,十六進位字串補齊奇數位) */
function csStrBytes(b, tok) {
  if (tok.t === 'hex') {
    let hex = latin1(b, tok.s, tok.e).replace(/[^0-9a-fA-F]/g, '');
    if (hex.length % 2) hex += '0';
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  const out = [];
  for (let i = tok.s; i < tok.e; i++) {
    let c = b[i];
    if (c === 13) { out.push(10); if (b[i + 1] === 10) i++; continue; }   // 字串裡沒有跳脫的換行一律是 \n
    if (c !== 92) { out.push(c); continue; }
    c = b[++i];
    if (c === 110) out.push(10); else if (c === 114) out.push(13); else if (c === 116) out.push(9);
    else if (c === 98) out.push(8); else if (c === 102) out.push(12);
    else if (c === 13) { if (b[i + 1] === 10) i++; }    // 反斜線 + 換行:接續下一行,不算字元
    else if (c === 10) { /* 同上 */ }
    else if (c >= 48 && c <= 55) {
      let v = c - 48;
      for (let k = 0; k < 2 && b[i + 1] >= 48 && b[i + 1] <= 55; k++) v = v * 8 + b[++i] - 48;
      out.push(v & 255);
    } else if (c !== undefined) out.push(c);           // \( \) \\ 與其他字元
  }
  return Uint8Array.from(out);
}

/* pdf.js 的文字指令序列:[{ k:'show', glyphs, font } | { k:'begin' } | { k:'end' }](begin/end = 表單 XObject)
   與每個字型的 fontMatrix、直書與否;頁面註解的外觀(beginAnnotation 之後)不算 */
async function pdfjsTextOps(e) {
  const page = await sources.get(e.src).doc.getPage(e.idx + 1);
  const ops = await page.getOperatorList(), O = pdfjsLib.OPS, list = [], stack = [];
  let font = null;
  for (let i = 0; i < ops.fnArray.length; i++) {
    const f = ops.fnArray[i], a = ops.argsArray[i];
    if (f === O.beginAnnotation) break;
    if (f === O.save) stack.push(font);
    else if (f === O.restore) { if (stack.length) font = stack.pop(); }
    else if (f === O.setFont) font = a[0];
    else if (f === O.paintFormXObjectBegin) { stack.push(font); list.push({ k: 'begin' }); }
    else if (f === O.paintFormXObjectEnd) { if (stack.length) font = stack.pop(); list.push({ k: 'end' }); }
    else if (f === O.showText) list.push({ k: 'show', glyphs: a[0] || [], font });
  }
  const fonts = new Map();
  for (const it of list) {
    if (it.k !== 'show' || fonts.has(it.font)) continue;
    let d = null;
    try { d = it.font && page.commonObjs.get(it.font); } catch (_) { /* 字型沒有載入 */ }
    fonts.set(it.font, d ? { fm0: d.fontMatrix ? d.fontMatrix[0] : 0.001, vertical: !!d.vertical } : null);
  }
  return { list, fonts };
}

const rtNum = t => t && t.t === 'num' ? t.v : 0;
const rtFmt = v => (Math.round(v * 1000) / 1000).toString();
const rtHex = u8 => Array.from(u8, x => x.toString(16).padStart(2, '0')).join('');
const rtApply = (M, x, y) => [x * M[0] + y * M[2] + M[4], x * M[1] + y * M[3] + M[5]];
const rtInside = (C, p) => C.rects.some(r => p[0] >= r.x0 && p[0] <= r.x1 && p[1] >= r.y0 && p[1] <= r.y1);

/* 一個文字指令:回傳 { edit: 取代的指令文字 | null, dx: 文字空間的位移(null = 算不出來) } */
function rtShow(C, b, op, ent, ts, tm, ctm) {
  const info = C.fonts.get(ent.font), glyphs = ent.glyphs, afs = Math.abs(ts.fs), dir = ts.fs < 0 ? -1 : 1;
  const arg = op.op === 'TJ' ? (op.args[0] && op.args[0].t === 'arr' ? op.args[0].items : []) : [op.args[op.args.length - 1]];
  // 運算元與 pdf.js 字形對應:數字對數字,字串依字碼切開(一個字碼 1–4 個位元組)
  const units = [];
  let gi = 0, ok = !!info && !info.vertical && afs > 0;
  for (const t of arg) {
    if (!ok || !t) break;
    if (t.t === 'num') { if (typeof glyphs[gi] === 'number') { units.push({ num: t.v }); gi++; } else ok = false; continue; }
    if (t.t !== 'str' && t.t !== 'hex') continue;
    const by = csStrBytes(b, t);
    for (let p = 0; p < by.length && ok;) {
      const g = glyphs[gi];
      if (!g || typeof g !== 'object') { ok = false; break; }
      let len = 0;
      for (let L = 1; L <= 4 && p + L <= by.length && !len; L++) {
        let v = 0;
        for (let k = 0; k < L; k++) v = v * 256 + by[p + k];
        if (v === g.originalCharCode) len = L;
      }
      if (!len) { ok = false; break; }
      units.push({ code: by.subarray(p, p + len), g });
      p += len; gi++;
    }
  }
  if (gi !== glyphs.length) ok = false;
  const M = mat(tm, ctm);
  if (!ok) {
    // 算不出每個字的位置:起點在框附近就回報「只能蓋住」
    const o = rtApply(M, 0, ts.Ts), near = afs * 4;
    if (C.rects.some(r => o[0] >= r.x0 - near && o[0] <= r.x1 + near && o[1] >= r.y0 - near && o[1] <= r.y1 + near)) C.missed++;
    return { edit: null, dx: null };
  }
  let x = 0, hit = false;
  const keep = [];
  for (const u of units) {
    if (u.num !== undefined) { x -= u.num * afs / 1000; keep.push(u); continue; }
    const w = (+u.g.width || 0) * info.fm0 * afs, adv = w + ((u.g.isSpace ? ts.Tw : 0) + ts.Tc) * dir;
    const c = rtApply(M, (x + w / 2) * ts.Th * dir, ts.Ts + 0.3 * ts.fs);
    if (rtInside(C, c)) { hit = true; keep.push({ num: -adv * 1000 / afs }); }   // 刪掉的字換成同樣寬度的位移
    else keep.push(u);
    x += adv;
  }
  const dx = x * ts.Th * dir;
  if (!hit) return { edit: null, dx };
  let s = '[', hex = '', pend = 0, has = false;
  const flushHex = () => { if (hex) { s += '<' + hex + '>'; hex = ''; } };
  const flushNum = () => { if (has) { s += ' ' + rtFmt(pend) + ' '; pend = 0; has = false; } };
  for (const u of keep) {
    if (u.code) { flushNum(); hex += rtHex(u.code); }
    else { flushHex(); pend += u.num; has = true; }
  }
  flushHex(); flushNum();
  return { edit: s + '] TJ', dx };
}

/* 走一遍內容串流。回傳 { edits: 這個串流要改的位元組範圍, xrep: Map(XObject 名稱 → 改過的表單) } */
function rtWalk(C, bytes, res, ctm0, ts0, depth) {
  const { PDFName } = PDFLib, edits = [], xrep = new Map(), uses = new Map();
  const xobjs = dictGet(C.lib, res, 'XObject'), stack = [];
  let ctm = ctm0.slice(), ts = { ...ts0 }, tm = [1, 0, 0, 1, 0, 0], tlm = tm, lost = false;
  for (const op of lexContent(bytes)) {
    if (C.fail) break;
    const a = op.args;
    switch (op.op) {
      case 'q': stack.push([ctm.slice(), { ...ts }]); break;
      case 'Q': if (stack.length) [ctm, ts] = stack.pop(); break;
      case 'cm': ctm = mat(nums(a), ctm); break;
      case 'BT': tm = tlm = [1, 0, 0, 1, 0, 0]; lost = false; break;
      case 'Tf': ts.font = true; ts.fs = a[1] && a[1].t === 'num' ? a[1].v : ts.fs; break;
      case 'Tc': ts.Tc = rtNum(a[0]); break;
      case 'Tw': ts.Tw = rtNum(a[0]); break;
      case 'Tz': ts.Th = rtNum(a[0]) / 100; break;
      case 'TL': ts.TL = rtNum(a[0]); break;
      case 'Ts': ts.Ts = rtNum(a[0]); break;
      case 'Td': case 'TD': {
        const [tx, ty] = nums(a);
        if (op.op === 'TD') ts.TL = -ty;
        tlm = mat([1, 0, 0, 1, tx, ty], tlm); tm = tlm; lost = false; break;
      }
      case 'Tm': tm = tlm = nums(a); lost = false; break;
      case 'T*': tlm = mat([1, 0, 0, 1, 0, -ts.TL], tlm); tm = tlm; lost = false; break;
      case 'Tj': case 'TJ': case "'": case '"': {
        let pre = '';
        if (op.op === '"') { ts.Tw = rtNum(a[0]); ts.Tc = rtNum(a[1]); pre = `${rtFmt(ts.Tw)} Tw ${rtFmt(ts.Tc)} Tc `; }
        if (op.op === "'" || op.op === '"') { tlm = mat([1, 0, 0, 1, 0, -ts.TL], tlm); tm = tlm; lost = false; pre += 'T* '; }
        if (!ts.font) break;                         // 還沒有 Tf:pdf.js 也略過這個指令
        const ent = C.cur.list[C.cur.i++];
        if (!ent || ent.k !== 'show') { C.fail = true; break; }
        if (lost) { C.missed++; break; }              // 前一段字的寬度算不出來,不知道這段在哪裡
        const r = rtShow(C, bytes, op, ent, ts, tm, ctm);
        if (r.dx === null) { lost = true; break; }
        tm = mat([1, 0, 0, 1, r.dx, 0], tm);
        if (r.edit) edits.push({ start: op.start, end: op.end, text: pre + r.edit });
        break;
      }
      case 'Do': {
        const name = a[0] && a[0].t === 'name' ? a[0].v : null;
        const ref = name && xobjs && xobjs.get(PDFName.of(name)), x = wmLookup(C.lib, ref);
        if (!x || !x.dict || nameStr(x.dict.get(PDFName.of('Subtype'))) !== 'Form') break;
        const nx = C.cur.list[C.cur.i];
        if (!nx || nx.k !== 'begin') break;           // pdf.js 沒有畫這個表單
        C.cur.i++;
        const fb = depth < 6 ? wmStreamBytes(x) : null;
        let sub = null;
        if (fb) {
          const fm = x.dict.get(PDFName.of('Matrix'));
          const fmat = fm instanceof PDFLib.PDFArray ? fm.asArray().map(v => v.asNumber ? v.asNumber() : 0) : [1, 0, 0, 1, 0, 0];
          sub = rtWalk(C, fb, dictGet(C.lib, x.dict, 'Resources') || res, mat(fmat, ctm), ts, depth + 1);
        } else {
          // 無法解碼的表單:跳過 pdf.js 裡對應的指令,裡面有字就回報
          let d = 1, text = false;
          while (C.cur.i < C.cur.list.length) {
            const k = C.cur.list[C.cur.i].k;
            if (k === 'end' && d === 1) break;
            C.cur.i++;
            if (k === 'begin') d++; else if (k === 'end') d--; else text = true;
          }
          if (text) C.missed++;
        }
        const end = C.cur.list[C.cur.i++];
        if (!end || end.k !== 'end') { C.fail = true; break; }
        if (!sub) break;
        // 同一個表單畫了好幾次、要刪的不一樣:無法只改其中一次,維持原樣並回報
        const key = JSON.stringify(sub.edits) + '|' + [...sub.xrep.keys()].join(',');
        if (uses.has(name)) {
          if (uses.get(name) !== null && uses.get(name) !== key) { xrep.delete(name); uses.set(name, null); C.missed++; }
          break;
        }
        uses.set(name, key);
        if (sub.edits.length || sub.xrep.size) xrep.set(name, rtNewForm(C, x, fb, sub, dictGet(C.lib, x.dict, 'Resources') || res));
        break;
      }
    }
  }
  return { edits, xrep };
}

/* 改過的表單 XObject:新的串流,字典沿用原本的(資源裡的子表單也換成改過的) */
function rtNewForm(C, x, fb, sub, res) {
  const { PDFName } = PDFLib, ctx = C.lib.context;
  const s = ctx.flateStream(sub.edits.length ? spliceBytes(fb, sub.edits) : fb);
  const skip = new Set(['Length', 'Filter', 'DecodeParms'].map(k => PDFName.of(k)));
  for (const [k, v] of x.dict.entries()) if (!skip.has(k)) s.dict.set(k, v);
  if (sub.xrep.size) s.dict.set(PDFName.of('Resources'), rtResources(C, res, sub.xrep));
  return ctx.register(s);
}
/* 資源字典的副本,XObject 換成改過的(原本的字典可能被其他頁或其他表單共用,不直接修改) */
function rtResources(C, res, xrep) {
  const { PDFName } = PDFLib, ctx = C.lib.context;
  const copy = res ? res.clone(ctx) : ctx.obj({}), xo = dictGet(C.lib, res, 'XObject');
  const own = xo ? xo.clone(ctx) : ctx.obj({});
  for (const [n, ref] of xrep) own.set(PDFName.of(n), ref);
  copy.set(PDFName.of('XObject'), own);
  return copy;
}

/* 匯出時處理一頁:page 是輸出檔裡複製好的頁面(還沒畫標註),mapPt 把基準座標換成這一頁的 PDF 座標。
   回傳無法從檔案刪除(只蓋底色)的地方數量 */
async function eraseOriginalText(out, page, e, mapPt) {
  const boxes = e.anns.filter(a => a.type === 'erase');
  if (!boxes.length) return 0;
  const { PDFName } = PDFLib, node = page.node;
  const rects = boxes.map(a => {
    const pts = [[a.x, a.y], [a.x + a.w, a.y], [a.x, a.y + a.h], [a.x + a.w, a.y + a.h]].map(([x, y]) => mapPt(x, y));
    return { x0: Math.min(...pts.map(p => p[0])), y0: Math.min(...pts.map(p => p[1])), x1: Math.max(...pts.map(p => p[0])), y1: Math.max(...pts.map(p => p[1])) };
  });
  const bytes = pageContentBytes(out, node);
  if (!bytes) return boxes.length;
  const { list, fonts } = await pdfjsTextOps(e);
  const res = wmLookup(out, node.getInheritableAttribute(PDFName.of('Resources')));
  const C = { lib: out, cur: { list, i: 0 }, fonts, rects, missed: 0, fail: false };
  const r = rtWalk(C, bytes, res, [1, 0, 0, 1, 0, 0], { font: false, fs: 0, Tc: 0, Tw: 0, Th: 1, TL: 0, Ts: 0 }, 0);
  if (C.fail || C.cur.i !== list.length) return boxes.length;   // 和 pdf.js 對不上:整頁不動
  if (r.edits.length) node.set(PDFName.of('Contents'), out.context.register(out.context.flateStream(spliceBytes(bytes, r.edits))));
  if (r.xrep.size) node.set(PDFName.of('Resources'), rtResources(C, res, r.xrep));
  return C.missed;
}
