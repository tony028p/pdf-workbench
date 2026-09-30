/* =====================================================================
   表格匯出 Excel(.xlsx):每個偵測到的表格一個工作表
   - 自己產生最小的 SpreadsheetML(與 Word 匯出相同做法),用既有的 makeZip 打包,不需額外函式庫
   - 數字存成真正的數值並保留原本的顯示格式:千分位、小數位數、百分比、負號/括號負數、正號、貨幣符號
     (例如「(4,321,000.50)」→ -4321000.5,格式 #,##0.00;(#,##0.00));開頭是 0 的代號(00123)維持文字
   - 合併儲存格、粗體、底色(深色底用白字)、對齊、欄寬、格內換行
   - 表格來自文字擷取的表格偵測(含 OCR 結果),塗黑範圍內的文字已排除
   ===================================================================== */
const XLSX_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const XLSX_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/* 文字 → { value, fmt }(是數字時);否則 null */
function parseNumberCell(text) {
  const s = text.trim().replace(/−/g, '-');
  const m = s.match(/^(NT\$|US\$|HK\$|\$|¥|€|£)?(\s*)([+-])?(\()?(NT\$|US\$|HK\$|\$|¥|€|£)?(\s*)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(\))?(%)?$/);
  if (!m) return null;
  const [, cur1, sp1, sign, open, cur2, sp2, int, dec, close, pct] = m;
  if (!!open !== !!close || (cur1 && cur2) || (open && sign)) return null;
  if (/^0\d/.test(int) && !dec) return null;                 // 00123 之類的代號維持文字
  let value = parseFloat(int.replace(/,/g, '') + (dec || ''));
  if (sign === '-' || open) value = -value;
  if (pct) value /= 100;
  const cur = cur1 || cur2, grouped = int.includes(',');
  let pos = (grouped ? '#,##0' : '0') + (dec ? '.' + '0'.repeat(dec.length - 1) : '') + (pct ? '%' : '');
  if (cur) pos = `"${cur}${cur1 ? sp1 : sp2}"` + pos;
  const fmt = open ? `${pos};(${pos})` : sign === '+' ? `+${pos};-${pos};0` : pos;
  return { value, fmt };
}

const colName = c => { let s = ''; for (c++; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + (c - 1) % 26) + s; return s; };
const displayWidth = s => [...s].reduce((w, ch) => w + (isCJK(ch) ? 2 : 1), 0);

/* 樣式表:依用到的組合動態產生 cellXfs */
function xlsxStyles() {
  const fmts = [], fonts = ['<font><sz val="11"/><name val="Calibri"/></font>'], fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'], xfKey = new Map([['', 0]]);
  const fontOf = (bold, white) => { if (!bold && !white) return 0; const k = `<font>${bold ? '<b/>' : ''}<sz val="11"/>${white ? '<color rgb="FFFFFFFF"/>' : ''}<name val="Calibri"/></font>`; let i = fonts.indexOf(k); if (i < 0) { fonts.push(k); i = fonts.length - 1; } return i; };
  const fillOf = hex => { if (!hex) return 0; const k = `<fill><patternFill patternType="solid"><fgColor rgb="FF${hex}"/><bgColor indexed="64"/></patternFill></fill>`; let i = fills.indexOf(k); if (i < 0) { fills.push(k); i = fills.length - 1; } return i; };
  const fmtOf = code => { if (!code) return 0; let i = fmts.indexOf(code); if (i < 0) { fmts.push(code); i = fmts.length - 1; } return 164 + i; };
  return {
    id({ fmt, bold, fill, border, align, wrap }) {
      const key = [fmt, bold, fill, border, align, wrap].join('|');
      if (xfKey.has(key)) return xfKey.get(key);
      const numFmtId = fmtOf(fmt), fontId = fontOf(bold, darkFill(fill)), fillId = fillOf(fill), borderId = border ? 1 : 0;
      const al = (align && align !== 'left') || wrap ? `<alignment${align && align !== 'left' ? ` horizontal="${align}"` : ''} vertical="top"${wrap ? ' wrapText="1"' : ''}/>` : '';
      xfs.push(`<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"` +
        `${numFmtId ? ' applyNumberFormat="1"' : ''}${fontId ? ' applyFont="1"' : ''}${fillId ? ' applyFill="1"' : ''}${borderId ? ' applyBorder="1"' : ''}${al ? ' applyAlignment="1">' + al + '</xf>' : '/>'}`);
      xfKey.set(key, xfs.length - 1);
      return xfs.length - 1;
    },
    xml() {
      const thin = '<left style="thin"><color rgb="FF808080"/></left><right style="thin"><color rgb="FF808080"/></right><top style="thin"><color rgb="FF808080"/></top><bottom style="thin"><color rgb="FF808080"/></bottom><diagonal/>';
      return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="${XLSX_NS}">` +
        (fmts.length ? `<numFmts count="${fmts.length}">${fmts.map((f, i) => `<numFmt numFmtId="${164 + i}" formatCode="${xmlEsc(f)}"/>`).join('')}</numFmts>` : '') +
        `<fonts count="${fonts.length}">${fonts.join('')}</fonts><fills count="${fills.length}">${fills.join('')}</fills>` +
        `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border>${thin}</border></borders>` +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>` +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
    },
  };
}

/* 一個表格 → 工作表 XML */
function sheetXml(t, styles) {
  const rows = [], merges = [], widths = t.cols.map(c => c.w / 5.25);   // 欄寬:pt → Excel 字元寬(約)
  t.cells.forEach((row, r) => {
    const cells = [];
    row.forEach((cell, c) => {
      const ref = colName(c) + (r + 1);
      if (cell.hidden || cell.empty) {
        // 合併範圍內的格子沿用擁有者的框線與底色,Excel 才會把整個合併格畫出來
        const own = cell.hidden ? t.cells[cell.ownerR][cell.ownerC] : null;
        if (t.ruled || (own && own.fill)) cells.push(`<c r="${ref}" s="${styles.id({ border: t.ruled, fill: own && own.fill })}"/>`);
        return;
      }
      const text = cell.paras.map(segs => segs.map(g => g.text).join('')).join('\n');
      const bold = cell.paras.length > 0 && cell.paras.every(segs => segs.every(g => !g.text.trim() || g.st.bold));
      const num = !text.includes('\n') && parseNumberCell(text);
      const style = { fmt: num && num.fmt, bold, fill: cell.fill, border: t.ruled, align: num ? (cell.align === 'center' ? 'center' : 'right') : cell.align, wrap: text.includes('\n') };
      if (text.trim()) {
        const lines = text.split('\n'), wide = Math.max(...lines.map(displayWidth)) + 2;
        if ((cell.colspan || 1) === 1) widths[c] = Math.max(widths[c], Math.min(60, wide));
      }
      const s = styles.id(style);
      if (num) cells.push(`<c r="${ref}" s="${s}"><v>${num.value}</v></c>`);
      else if (text.trim()) cells.push(`<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(text)}</t></is></c>`);
      else if (s) cells.push(`<c r="${ref}" s="${s}"/>`);
      if ((cell.colspan || 1) > 1 || (cell.rowspan || 1) > 1) merges.push(`${ref}:${colName(c + (cell.colspan || 1) - 1)}${r + (cell.rowspan || 1)}`);
    });
    rows.push(`<row r="${r + 1}">${cells.join('')}</row>`);
  });
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.max(6, Math.round(w * 10) / 10)}" customWidth="1"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${XLSX_NS}" xmlns:r="${XLSX_REL}">` +
    `<cols>${cols}</cols><sheetData>${rows.join('')}</sheetData>` +
    (merges.length ? `<mergeCells count="${merges.length}">${merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '') +
    '</worksheet>';
}

/* 工作表名稱:最多 31 字、不可含 []:*?/\、不可重複 */
function sheetName(base, used) {
  let n = base.replace(/[\[\]:*?\/\\]/g, ' ').slice(0, 31), k = 2;
  while (used.has(n)) n = `${base.slice(0, 27)} (${k++})`;
  used.add(n);
  return n;
}

async function buildXlsx(list, { onProgress } = {}) {
  const tables = [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (onProgress) onProgress(`找表格 ${i + 1} / ${list.length}…`);
    const [pt, rich] = [await pageText(e), await richPageInfo(e)];
    const found = pt.paras.filter(p => p.table).map(p => tableEntry(p, rich.fonts).table);
    const n = S.pages.indexOf(e) + 1;
    found.forEach((t, k) => tables.push({ t, name: found.length > 1 ? `第${n}頁 表${k + 1}` : `第${n}頁` }));
  }
  if (!tables.length) throw new Error('選取的頁面沒有偵測到表格');
  const styles = xlsxStyles(), used = new Set();
  const sheets = tables.map(({ t, name }, i) => ({ name: sheetName(name, used), xml: sheetXml(t, styles), file: `xl/worksheets/sheet${i + 1}.xml` }));
  const enc = s => new TextEncoder().encode(s);
  const files = [
    { name: '[Content_Types].xml', data: enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      sheets.map(s => `<Override PartName="/${s.file}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>') },
    { name: '_rels/.rels', data: enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${XLSX_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    { name: 'xl/workbook.xml', data: enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="${XLSX_NS}" xmlns:r="${XLSX_REL}"><sheets>` +
      sheets.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>') },
    { name: 'xl/_rels/workbook.xml.rels', data: enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="${XLSX_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${sheets.length + 1}" Type="${XLSX_REL}/styles" Target="styles.xml"/></Relationships>`) },
    ...sheets.map(s => ({ name: s.file, data: enc(s.xml) })),
    { name: 'xl/styles.xml', data: enc(styles.xml()) },
  ];
  return { blob: new Blob([makeZip(files)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), sheets: sheets.length };
}
