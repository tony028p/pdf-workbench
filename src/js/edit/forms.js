/* =====================================================================
   表單填寫(AcroForm)
   - 欄位位置與類型由 pdf.js 的 getAnnotations 取得,換成基準座標,依「來源檔:頁索引」快取在 formWidgetCache
   - 填入的值存在來源檔上(sources 的 form.values:欄位名稱 → 值),不放進 S.pages;
     值改變後由 fillForm 用 pdf-lib 寫進 PDF 並替換來源檔,畫面、匯出、真塗黑都直接用填好的檔案
   - 外觀:只有 Latin-1 字元的文字用 Helvetica 產生;含中文時用內嵌的思源黑體(core/fonts.js)寫成真正的文字,
     字型缺字時才畫成圖片。欄位的值都以文字存在 /V,其他程式編輯時會用自己的字型重畫
   ===================================================================== */
const formWidgetCache = new Map();

/* 這一頁的表單欄位:[{ name, kind:'text'|'check'|'radio'|'combo'|'list', x, y, w, h(基準座標), value(檔案裡的值), on, options, … }] */
async function pageFormWidgets(e) {
  const key = e.src + ':' + e.idx;
  if (formWidgetCache.has(key)) return formWidgetCache.get(key);
  const src = sources.get(e.src), page = await src.doc.getPage(e.idx + 1), vp = page.getViewport({ scale: 1 });
  const anns = await page.getAnnotations({ intent: 'display' });
  const list = [];
  for (const a of anns) {
    if (a.subtype !== 'Widget' || !a.fieldName || a.hidden || a.pushButton || !['Tx', 'Btn', 'Ch'].includes(a.fieldType)) continue;
    const [x1, y1, x2, y2] = vp.convertToViewportRectangle(a.rect);
    const kind = a.fieldType === 'Tx' ? 'text' : a.fieldType === 'Ch' ? (a.combo ? 'combo' : 'list') : a.checkBox ? 'check' : a.radioButton ? 'radio' : '';
    if (!kind) continue;
    list.push({
      name: a.fieldName, kind, x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1),
      value: a.fieldValue, on: a.checkBox ? a.exportValue : a.buttonValue,
      options: (a.options || []).map(o => ({ value: o.exportValue, label: o.displayValue })),
      readOnly: !!a.readOnly, multiLine: !!a.multiLine, maxLen: a.maxLen || 0,
      fontSize: (a.defaultAppearanceData && a.defaultAppearanceData.fontSize) || 0, align: a.textAlignment || 0
    });
  }
  formWidgetCache.set(key, list);
  return list;
}

/* 欄位目前的值(使用者填的優先,否則是檔案裡原本的值);勾選框為 true/false,單選為選中的選項名稱 */
function formValue(srcId, w) {
  const s = sources.get(srcId), vals = s.form && s.form.values;
  if (vals && vals.has(w.name)) return vals.get(w.name);
  if (w.kind === 'check') return !!w.value && w.value !== 'Off';
  if (w.kind === 'radio') return w.value && w.value !== 'Off' ? w.value : null;
  if (Array.isArray(w.value)) return w.value[0] || '';
  return w.value || '';
}

const LATIN1_RE = /^[\x20-\x7e\xa0-\xff\r\n\t]*$/;

/* 把 values 寫進 PDF;回傳新的檔案 */
async function fillForm(bytes, values) {
  const { PDFDocument, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList, PDFName, PDFHexString, StandardFonts } = PDFLib;
  const lib = await PDFDocument.load(bytes, { updateMetadata: false });
  const form = lib.getForm();
  try { form.deleteXFA(); } catch (_) { /* 沒有 XFA */ }   // 有 XFA 時 Acrobat 會顯示 XFA 表單而不是這裡填的值
  let helv = null;
  const font = async () => helv || (helv = await lib.embedFont(StandardFonts.Helvetica));
  for (const [name, v] of values) {
    let f;
    try { f = form.getField(name); } catch (_) { continue; }
    try {
      if (f instanceof PDFTextField) {
        const ml = f.getMaxLength(), text = ml ? String(v).slice(0, ml) : String(v);
        f.setText(text || undefined);
        await fieldAppearance(lib, f, text, font);
      } else if (f instanceof PDFCheckBox) {
        if (v) f.check(); else f.uncheck();
      } else if (f instanceof PDFRadioGroup) {
        // 直接用外觀狀態名稱(與 pdf.js 的 buttonValue 相同),不經過 /Opt 的對照
        f.acroField.setValue(PDFName.of(v || 'Off'));
      } else if (f instanceof PDFDropdown || f instanceof PDFOptionList) {
        if (v) f.acroField.setValues([PDFHexString.fromText(v)]); else f.clear();
        const opt = f.acroField.getOptions().find(o => o.value.decodeText() === v);
        await fieldAppearance(lib, f, opt && opt.display ? opt.display.decodeText() : (v || ''), font);
      }
    } catch (err) { console.warn('填寫欄位失敗', name, err); }
  }
  return await lib.save({ updateFieldAppearances: false });
}

/* 產生欄位外觀:Latin-1 用 Helvetica(pdf-lib 內建的外觀),其他字元畫成圖片 */
async function fieldAppearance(lib, f, text, font) {
  if (LATIN1_RE.test(text)) { f.updateAppearances(await font()); return; }
  const { pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject, beginText, endText, setFontAndSize,
    setTextMatrix, showText, setFillingRgbColor, PDFName } = PDFLib;
  const da = f.acroField.getDefaultAppearance() || '', m = da.match(/([\d.]+)\s+Tf/);
  const col = da.match(/([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/) || da.match(/([\d.]+)\s+g(?![a-z])/);
  const rgb = col ? (col.length === 4 ? col.slice(1).map(Number) : [+col[1], +col[1], +col[1]]) : [0, 0, 0];
  const multi = f instanceof PDFLib.PDFTextField && f.isMultiline(), align = f.acroField.getQuadding() || 0;
  // 內嵌字型涵蓋每個字 → 真正的文字;否則畫成圖片(兩種排法相同)
  const real = sansCovers(text) ? await embedSans(lib) : null;
  const g = document.createElement('canvas').getContext('2d');
  const width = (s, size) => {
    if (real) return real.widthOfTextAtSize(s, size);
    g.font = `${size}px ${FONTS.sans}`;
    return g.measureText(s).width;
  };
  for (const w of f.acroField.getWidgets()) {
    const r = w.getRectangle(), pad = 2, avail = r.width - 2 * pad;
    let fs = m ? +m[1] : 0;
    if (!fs) fs = multi ? 12 : Math.max(4, Math.min(r.height * 0.7, 14));
    // 單行:太長就縮小字級;多行:逐字換行(中文不需要空格也能斷行)
    let lines = [text];
    if (multi) {
      lines = [];
      for (const para of text.split(/\r\n|\r|\n/)) {
        let cur = '';
        for (const ch of para) {
          if (cur && width(cur + ch, fs) > avail) { lines.push(cur); cur = ch; } else cur += ch;
        }
        lines.push(cur);
      }
    } else {
      const tw = width(text, fs);
      if (tw > avail) fs *= avail / tw;
    }
    // 每行的左邊與基線(pt,從欄位左上角算)
    const placed = lines.map((ln, i) => {
      const tw = width(ln, fs);
      return { ln, x: align === 1 ? (r.width - tw) / 2 : align === 2 ? r.width - pad - tw : pad, y: multi ? pad + fs * (i + 0.9) : (r.height + fs * 0.7) / 2 };
    });
    let ap;
    if (real) {
      const ops = [pushGraphicsState(), beginText(), setFontAndSize('F0', fs), setFillingRgbColor(...rgb)];
      for (const p of placed) if (p.ln) ops.push(setTextMatrix(1, 0, 0, 1, p.x, r.height - p.y), showText(real.encodeText(p.ln)));
      ops.push(endText(), popGraphicsState());
      ap = lib.context.formXObject(ops, { BBox: [0, 0, r.width, r.height], Resources: { Font: { F0: real.ref } } });
    } else {
      const K = 4, c = document.createElement('canvas');
      c.width = Math.max(1, Math.ceil(r.width * K)); c.height = Math.max(1, Math.ceil(r.height * K));
      const cg = c.getContext('2d');
      cg.font = `${fs * K}px ${FONTS.sans}`;
      cg.fillStyle = `rgb(${rgb.map(v => Math.round(v * 255)).join(',')})`; cg.textBaseline = 'alphabetic';
      for (const p of placed) cg.fillText(p.ln, p.x * K, p.y * K);
      const png = dataUrlToU8(c.toDataURL('image/png'));
      c.width = c.height = 1;
      const img = await lib.embedPng(png);
      ap = lib.context.formXObject(
        [pushGraphicsState(), concatTransformationMatrix(r.width, 0, 0, r.height, 0, 0), drawObject('Im0'), popGraphicsState()],
        { BBox: [0, 0, r.width, r.height], Resources: { XObject: { Im0: img.ref } } });
    }
    w.setNormalAppearance(lib.context.register(ap));
    w.dict.delete(PDFName.of('AS'));
  }
}

/* 填寫的值改變後寫進來源檔:同一個來源檔依序處理;連續改好幾個欄位時,排隊中的那一次會一起寫入 */
const formPending = new Map();
function setFormValue(srcId, name, value) {
  const s = sources.get(srcId);
  if (!s.form) s.form = { values: new Map(), dirty: false };
  s.form.values.set(name, value);
  s.form.dirty = true;
  const prev = formPending.get(srcId) || Promise.resolve();
  const next = prev.then(async () => {
    if (!s.form.dirty) return;
    s.form.dirty = false;
    await replaceSourceBytes(srcId, await fillForm(s.bytes, s.form.values), { keepText: true });
  }).catch(err => { console.error(err); toast('表單填寫失敗:' + (err.message || err), 7000); });
  formPending.set(srcId, next);
  return next;
}
/* 匯出前等所有填寫都寫進檔案 */
async function flushFormValues() { await Promise.all([...formPending.values()]); }
