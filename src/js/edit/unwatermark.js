/* =====================================================================
   移除 PDF 原有的浮水印
   偵測(detectWatermarks)只讀檔案,列出候選;使用者勾選後,removeWatermarks 從原始檔重新產生一份
   PDF:刪掉內容串流裡的繪圖指令、註解與不再使用的 XObject 資源(不是蓋白框),再替換來源檔。
   可以可靠辨認的:
     - 浮水印註解(/Subtype /Watermark)
     - 標記為浮水印的內容:/Artifact <</Subtype /Watermark>> BDC … EMC(Adobe Acrobat 等)、
       名稱含 Watermark/浮水印 的選用內容群組(/OC),以及 PieceInfo 標示為浮水印的表單 XObject
   用規則猜的(使用者確認後才移除):
     - 旋轉(非 90° 倍數)或半透明,而且淺色、字很大或半透明的文字
     - 旋轉且半透明的圖片,或半透明且面積夠大的圖片;內容全是上述文字/圖片的表單 XObject
   印在掃描影像裡的浮水印無法移除。
   ===================================================================== */
const WM_NAME_RE = /watermark|浮水印|水印/i;

const mat = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
const nums = args => args.map(a => a.t === 'num' ? a.v : 0);

function wmLookup(lib, obj, type) {
  if (!obj) return undefined;
  try { return type ? lib.context.lookup(obj, type) : lib.context.lookup(obj); } catch (_) { return undefined; }
}
const dictGet = (lib, d, key) => d ? wmLookup(lib, d.get(PDFLib.PDFName.of(key))) : undefined;
const nameStr = o => o && o.decodeText ? o.decodeText() : (o && o.asString ? o.asString().replace(/^\//, '') : '');

/* 串流解碼(FlateDecode 等);無法解碼就回傳 null(該頁不處理) */
function wmStreamBytes(stream) {
  try {
    if (stream instanceof PDFLib.PDFRawStream) return PDFLib.decodePDFRawStream(stream).decode();
    if (stream.getContents) return stream.getContents();
  } catch (_) { /* 不支援的壓縮格式 */ }
  return null;
}

function pageContentBytes(lib, node) {
  const c = wmLookup(lib, node.get(PDFLib.PDFName.of('Contents')));
  if (!c) return new Uint8Array(0);
  const streams = c instanceof PDFLib.PDFArray ? c.asArray().map(r => wmLookup(lib, r)) : [c];
  const parts = [];
  for (const s of streams) { const b = s && wmStreamBytes(s); if (!b) return null; parts.push(b, new Uint8Array([10])); }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/* 選用內容群組(OCG)或其成員字典的名稱是否像浮水印 */
function ocIsWatermark(lib, oc) {
  const d = wmLookup(lib, oc);
  if (!d || !d.get) return false;
  const name = dictGet(lib, d, 'Name');
  if (name && WM_NAME_RE.test(name.decodeText ? name.decodeText() : '')) return true;
  const ocgs = dictGet(lib, d, 'OCGs');
  if (ocgs) {
    const list = ocgs instanceof PDFLib.PDFArray ? ocgs.asArray() : [ocgs];
    return list.some(r => { const g = wmLookup(lib, r); const n = g && dictGet(lib, g, 'Name'); return n && WM_NAME_RE.test(n.decodeText ? n.decodeText() : ''); });
  }
  return false;
}
/* 表單 XObject 的 PieceInfo 標示為浮水印(Acrobat:/PieceInfo /ADBE_CompoundType /Private /Watermark) */
function formMarkedWatermark(lib, dict) {
  const pi = dictGet(lib, dict, 'PieceInfo');
  if (pi) {
    const s = String(pi);
    if (/Watermark/i.test(s)) return true;
    for (const [, v] of pi.entries()) if (/Watermark/i.test(String(wmLookup(lib, v)))) return true;
  }
  return ocIsWatermark(lib, dict.get(PDFLib.PDFName.of('OC')));
}

/* 走一遍內容串流,收集浮水印的指令範圍。
   out:{ marked:[{start,end}], text:[{key,start,end,edits,angle,origin}], image:[{key,op,name}], form:[{key,op,name,strong}], stats } */
function walkContent(lib, bytes, res, baseCtm, pageArea, depth = 0) {
  const ops = lexContent(bytes);
  const out = { marked: [], text: [], image: [], form: [], shows: 0, wmShows: 0, paints: 0, images: 0, wmImages: 0 };
  const extg = dictGet(lib, res, 'ExtGState'), props = dictGet(lib, res, 'Properties'), xobjs = dictGet(lib, res, 'XObject');
  let st = { ctm: baseCtm.slice(), ca: 1, light: false };
  const gstack = [];
  let tm = [1, 0, 0, 1, 0, 0], tlm = tm, fs = 12, font = '', tl = 0, inText = false, group = null;
  const marks = [];
  const flush = () => { if (group) { out.text.push(group); group = null; } };
  const isLight = vals => vals.length && vals.every(v => v >= 0.55) && !vals.every(v => v >= 0.97);
  for (const op of ops) {
    const a = op.args;
    switch (op.op) {
      case 'q': gstack.push({ ...st, ctm: st.ctm.slice() }); break;
      case 'Q': st = gstack.pop() || st; break;
      case 'cm': st.ctm = mat(nums(a), st.ctm); break;
      case 'gs': {
        const g = a[0] && a[0].t === 'name' && extg && wmLookup(lib, extg.get(PDFLib.PDFName.of(a[0].v)));
        const ca = g && dictGet(lib, g, 'ca');
        if (ca && ca.asNumber) st.ca = ca.asNumber();
        break;
      }
      case 'g': case 'rg': st.light = isLight(nums(a)); break;
      case 'k': { const [c, m, y, k] = nums(a); st.light = isLight([(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)]); break; }
      case 'sc': case 'scn': st.light = a.every(x => x.t === 'num') && isLight(nums(a)); break;
      case 'BT': inText = true; tm = tlm = [1, 0, 0, 1, 0, 0]; break;
      case 'ET': inText = false; flush(); break;
      case 'Tf': font = a[0] && a[0].v || ''; fs = a[1] ? a[1].v : fs; break;
      case 'TL': tl = a[0] ? a[0].v : tl; break;
      case 'Td': case 'TD': { const [tx, ty] = nums(a); if (op.op === 'TD') tl = -ty; tlm = mat([1, 0, 0, 1, tx, ty], tlm); tm = tlm; break; }
      case 'Tm': tm = tlm = nums(a); break;
      case 'T*': tlm = mat([1, 0, 0, 1, 0, -tl], tlm); tm = tlm; break;
      case 'Tj': case 'TJ': case "'": case '"': {
        if (op.op === "'" || op.op === '"') { tlm = mat([1, 0, 0, 1, 0, -tl], tlm); tm = tlm; }
        out.shows++;
        const M = mat(tm, st.ctm), angle = Math.atan2(M[1], M[0]) * 180 / Math.PI, size = fs * Math.hypot(M[2], M[3]);
        const off90 = Math.abs(angle - Math.round(angle / 90) * 90) > 5, transparent = st.ca < 0.99;
        const wm = (off90 && (transparent || st.light || size >= 24)) || (transparent && size >= 24);
        if (!wm) { flush(); break; }
        out.wmShows++;
        const raw = latin1(bytes, op.start, op.end);
        // ' 與 " 除了畫字還會換行(" 另外設定字距):刪除時保留這些效果
        const text = op.op === "'" ? 'T*' : op.op === '"' ? `${a[0] ? a[0].v : 0} Tw ${a[1] ? a[1].v : 0} Tc T*` : '';
        const edit = { start: op.start, end: op.end, text };
        if (group && Math.abs(group.angle - angle) < 2) { group.key += raw; group.edits.push(edit); }
        else { flush(); group = { key: 'T:' + font + ':' + Math.round(angle) + ':' + raw, edits: [edit], angle, size, origin: [M[4], M[5]], transparent, light: st.light }; }
        break;
      }
      case 'BMC': marks.push({ wm: false, start: op.start }); break;
      case 'BDC': {
        const tag = a[0] && a[0].v, p = a[1];
        let pd = null, wm = false;
        if (p && p.t === 'dict') pd = csDict(p);
        else if (p && p.t === 'name' && props) {
          const obj = wmLookup(lib, props.get(PDFLib.PDFName.of(p.v)));
          if (tag === 'OC') wm = ocIsWatermark(lib, obj);
          else if (obj && obj.get) { const sub = dictGet(lib, obj, 'Subtype'); wm = tag === 'Artifact' && sub && /Watermark/.test(nameStr(sub)); }
        }
        if (pd) wm = tag === 'Artifact' && pd.get('Subtype') && pd.get('Subtype').v === 'Watermark';
        marks.push({ wm, start: op.start });
        break;
      }
      case 'EMC': {
        const m = marks.pop();
        if (m && m.wm && !marks.some(x => x.wm)) out.marked.push({ start: m.start, end: op.end });
        break;
      }
      case 'f': case 'F': case 'f*': case 'S': case 's': case 'B': case 'B*': case 'b': case 'b*': case 'sh': out.paints++; break;
      case 'Do': {
        const name = a[0] && a[0].v, ref = xobjs && xobjs.get(PDFLib.PDFName.of(name)), x = wmLookup(lib, ref);
        if (!x || !x.dict) break;
        const sub = nameStr(x.dict.get(PDFLib.PDFName.of('Subtype'))), key = String(ref);
        if (sub === 'Image') {
          out.images++;
          const M = st.ctm, area = Math.abs(M[0] * M[3] - M[1] * M[2]), angle = Math.atan2(M[1], M[0]) * 180 / Math.PI;
          const rotated = Math.abs(angle - Math.round(angle / 90) * 90) > 5;
          const transparent = st.ca < 0.99 || !!x.dict.get(PDFLib.PDFName.of('SMask'));
          // 旋轉又半透明的圖片幾乎一定是浮水印(面積 1% 以上即可);只有半透明則要夠大(10%),避免誤判小圖示
          if (transparent && ((rotated && area >= 0.01 * pageArea) || (st.ca < 0.99 && area >= 0.1 * pageArea))) { out.wmImages++; out.image.push({ key: 'I:' + key, start: op.start, end: op.end, name, angle, transparent: st.ca < 0.99 }); }
        } else if (sub === 'Form') {
          if (formMarkedWatermark(lib, x.dict)) { out.form.push({ key: 'M:form', start: op.start, end: op.end, name, strong: true }); break; }
          if (depth >= 3) break;
          const fb = wmStreamBytes(x); if (!fb) break;
          const fm = x.dict.get(PDFLib.PDFName.of('Matrix')), fmat = fm instanceof PDFLib.PDFArray ? fm.asArray().map(v => v.asNumber ? v.asNumber() : 0) : [1, 0, 0, 1, 0, 0];
          const sub2 = walkContent(lib, fb, dictGet(lib, x.dict, 'Resources') || res, mat(fmat, st.ctm), pageArea, depth + 1);
          // 表單裡全是浮水印式的文字/圖片、沒有其他繪圖 → 整個表單當成浮水印
          const all = sub2.wmShows + sub2.wmImages > 0 && sub2.wmShows === sub2.shows && sub2.wmImages === sub2.images && sub2.paints === 0;
          if (all || sub2.marked.length) {
            const label = sub2.text[0] || null;
            out.form.push({ key: (all ? 'F:' : 'M:form:') + key, start: op.start, end: op.end, name, strong: !all,
              angle: label ? label.angle : 0, origin: label && label.origin, transparent: label ? label.transparent : false, light: label && label.light });
          }
        }
        break;
      }
    }
  }
  flush();
  return out;
}

/* 偵測整份文件。回傳 [{ id, kind:'mark'|'annot'|'text'|'image'|'form', strong, pages:[頁索引], sample:{ page, origin, angle } }]
   與 plan:Map(id → [{ page, edits, xobjNames, annots }]) */
async function detectWatermarks(bytes) {
  const lib = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
  const found = new Map(), plan = new Map();
  const add = (id, kind, strong, pageIdx, entry, sample) => {
    if (!found.has(id)) { found.set(id, { id, kind, strong, pages: [], sample }); plan.set(id, []); }
    const c = found.get(id);
    if (!c.pages.includes(pageIdx)) c.pages.push(pageIdx);
    plan.get(id).push({ page: pageIdx, ...entry });
  };
  lib.getPages().forEach((page, pi) => {
    const node = page.node, { width, height } = page.getSize();
    const annots = wmLookup(lib, node.get(PDFLib.PDFName.of('Annots')));
    if (annots instanceof PDFLib.PDFArray) annots.asArray().forEach((r, k) => {
      const an = wmLookup(lib, r);
      if (an && an.get && nameStr(an.get(PDFLib.PDFName.of('Subtype'))) === 'Watermark') add('annot', 'annot', true, pi, { edits: [], annots: [k] });
    });
    const bytes = pageContentBytes(lib, node);
    if (!bytes) return;
    const res = wmLookup(lib, node.getInheritableAttribute(PDFLib.PDFName.of('Resources')));
    const w = walkContent(lib, bytes, res, [1, 0, 0, 1, 0, 0], width * height);
    for (const m of w.marked) add('mark', 'mark', true, pi, { edits: [{ start: m.start, end: m.end, text: '' }] });
    for (const f of w.form) {
      if (f.strong) add('mark', 'mark', true, pi, { edits: [{ start: f.start, end: f.end, text: '' }], xobjNames: [f.name] });
      else add(f.key, 'form', false, pi, { edits: [{ start: f.start, end: f.end, text: '' }], xobjNames: [f.name] }, { page: pi, origin: f.origin, angle: f.angle, transparent: f.transparent, light: f.light });
    }
    for (const t of w.text) add(t.key, 'text', false, pi, { edits: t.edits }, { page: pi, origin: t.origin, angle: t.angle, transparent: t.transparent, light: t.light });
    for (const im of w.image) add(im.key, 'image', false, pi, { edits: [{ start: im.start, end: im.end, text: '' }], xobjNames: [im.name] }, { page: pi, angle: im.angle, transparent: im.transparent });
  });
  return { candidates: [...found.values()], plan };
}

/* 從原始檔產生移除後的 PDF(ids:要移除的候選) */
async function removeWatermarks(bytes, ids, plan) {
  const lib = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
  const pages = lib.getPages(), perPage = new Map();
  for (const id of ids) for (const ent of plan.get(id) || []) {
    const p = perPage.get(ent.page) || { edits: [], annots: new Set(), names: new Set() };
    p.edits.push(...ent.edits); (ent.annots || []).forEach(k => p.annots.add(k)); (ent.xobjNames || []).forEach(n => p.names.add(n));
    perPage.set(ent.page, p);
  }
  const { PDFName } = PDFLib;
  for (const [pi, p] of perPage) {
    const node = pages[pi].node;
    if (p.annots.size) {
      const annots = wmLookup(lib, node.get(PDFName.of('Annots')));
      const keep = annots.asArray().filter((_, k) => !p.annots.has(k));
      node.set(PDFName.of('Annots'), lib.context.obj(keep));
    }
    if (p.edits.length) {
      const next = spliceBytes(pageContentBytes(lib, node), p.edits);
      node.set(PDFName.of('Contents'), lib.context.register(lib.context.flateStream(next)));
      // 內容裡不再用到的 XObject 從這一頁的資源移除(表單/圖片物件不會被複製到匯出的檔案)
      if (p.names.size) {
        const used = new Set(lexContent(next).filter(o => o.op === 'Do' && o.args[0]).map(o => o.args[0].v));
        const res = wmLookup(lib, node.getInheritableAttribute(PDFName.of('Resources')));
        const xo = dictGet(lib, res, 'XObject');
        if (xo && res) {
          // 資源字典可能被多頁共用:複製一份給這一頁再刪,不影響其他頁
          const own = lib.context.obj({});
          for (const [k, v] of xo.entries()) if (!(p.names.has(nameStr(k)) && !used.has(nameStr(k)))) own.set(k, v);
          const resCopy = res.clone(lib.context);
          resCopy.set(PDFName.of('XObject'), own);
          node.set(PDFName.of('Resources'), resCopy);
        }
      }
    }
  }
  return await lib.save();
}
