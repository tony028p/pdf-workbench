/* =====================================================================
   匯出 Word(.docx):自己產生最小的 OOXML,用既有的 makeZip 打包(不需要額外函式庫)
   - 可編輯:依版面分析重排成段落、標題、清單,保留粗體/斜體/字級/字型,
             圖片裁切後放在原位附近;重複的頁首頁尾與頁碼移出內文
   - 保留外觀:每頁整頁轉成一張圖(外觀一致,文字不可編輯)
   - 塗黑:文字走 pageText(已排除塗黑範圍);圖片一律從「依序燒入所有標註(含塗黑框)」
           的頁面圖裁切,不直接取用 PDF 內的圖片物件,所以塗黑一定會套用
   ===================================================================== */
const PT_TWIP = 20, PT_EMU = 12700;
const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const xmlEsc = s => String(s)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function docxFonts(st) {
  return { ea: st.kai ? '標楷體' : st.serif ? '新細明體' : '微軟正黑體', latin: st.serif ? 'Times New Roman' : 'Arial' };
}
function runXml(text, st) {
  const f = docxFonts(st);
  let rpr = `<w:rFonts w:ascii="${f.latin}" w:hAnsi="${f.latin}" w:eastAsia="${f.ea}" w:cs="${f.latin}"/>`;
  if (st.bold) rpr += '<w:b/><w:bCs/>';
  if (st.italic) rpr += '<w:i/><w:iCs/>';
  if (st.color) rpr += `<w:color w:val="${st.color}"/>`;
  if (st.sz) rpr += `<w:sz w:val="${st.sz}"/><w:szCs w:val="${st.sz}"/>`;
  return `<w:r><w:rPr>${rpr}</w:rPr><w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r>`;
}
function imageParaXml(rid, n, wPt, hPt, extraPPr = '') {
  const cx = Math.round(wPt * PT_EMU), cy = Math.round(hPt * PT_EMU);
  return `<w:p><w:pPr><w:spacing w:before="0" w:after="0"/>${extraPPr}</w:pPr><w:r><w:drawing>` +
    `<wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="圖片 ${n}"/>` +
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${n}" name="image${n}.jpeg"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
    `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}
function sectXml(pg, footer) {
  const w = Math.round(pg.w * PT_TWIP), h = Math.round(pg.h * PT_TWIP), m = pg.margins.map(v => Math.round(v * PT_TWIP));
  return `<w:sectPr>${footer ? '<w:footerReference w:type="default" r:id="rIdFooter"/>' : ''}` +
    `<w:pgSz w:w="${w}" w:h="${h}"${w > h ? ' w:orient="landscape"' : ''}/>` +
    `<w:pgMar w:top="${m[0]}" w:right="${m[1]}" w:bottom="${m[2]}" w:left="${m[3]}" w:header="${Math.min(m[0], 425)}" w:footer="${Math.min(m[2], 425)}" w:gutter="0"/></w:sectPr>`;
}
/* 在一頁最後一個段落的 pPr 放 sectPr = 分節(新頁);依規格 sectPr 必須是 pPr 的最後一個子元素 */
function withSect(pXml, sect) {
  if (pXml === '<w:p/>') pXml = '<w:p></w:p>';
  return pXml.includes('</w:pPr>') ? pXml.replace('</w:pPr>', sect + '</w:pPr>') : pXml.replace('<w:p>', `<w:p><w:pPr>${sect}</w:pPr>`);
}

/* 表格:有框線的畫框線,無框線的(例如目錄)不畫;合併儲存格用 gridSpan / vMerge */
function tableXml(b, contentW, bodySz) {
  const total = b.cols.reduce((s, c) => s + c.w, 0), k = total > contentW ? contentW / total : 1;
  const tw = b.cols.map(c => Math.max(200, Math.round(c.w * k * PT_TWIP)));
  const span = (c, n) => tw.slice(c, c + n).reduce((s, w) => s + w, 0);
  const line = side => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`;
  const borders = b.ruled ? `<w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(line).join('')}</w:tblBorders>` : '';
  const cellPara = (segs, c, indent, align, color) => {
    let ppr = '<w:spacing w:before="0" w:after="0"/>';
    if (indent > 0) ppr += `<w:ind w:left="${Math.round(indent * PT_TWIP)}"/>`;
    if (align === 'right' || align === 'center') ppr += `<w:jc w:val="${align}"/>`;
    const runs = segs.map(g => { const sz = halfPt(g.st.size); return runXml(g.text, { ...g.st, sz: sz === bodySz ? 0 : sz, color }); });
    return `<w:p><w:pPr>${ppr}</w:pPr>${mergeRuns(runs)}</w:p>`;
  };
  const rows = b.cells.map((row, r) => {
    const tcs = [];
    row.forEach((cell, c) => {
      if (cell.hidden) {
        if (cell.ownerR === r || cell.ownerC !== c) return;   // 同一列的橫向合併由 gridSpan 涵蓋
        const own = b.cells[cell.ownerR][cell.ownerC];         // 直向合併的延續格
        tcs.push(`<w:tc><w:tcPr><w:tcW w:w="${span(c, own.colspan)}" w:type="dxa"/>${own.colspan > 1 ? `<w:gridSpan w:val="${own.colspan}"/>` : ''}<w:vMerge/></w:tcPr><w:p/></w:tc>`);
        return;
      }
      const n = cell.colspan || 1;
      const tcpr = `<w:tcW w:w="${span(c, n)}" w:type="dxa"/>${n > 1 ? `<w:gridSpan w:val="${n}"/>` : ''}${cell.rowspan > 1 ? '<w:vMerge w:val="restart"/>' : ''}` +
        (cell.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${cell.fill}"/>` : '');
      const color = darkFill(cell.fill) ? 'FFFFFF' : null;
      const ps = cell.empty || !cell.paras.length ? '<w:p/>' : cell.paras.map(segs => cellPara(segs, c, cell.indent, cell.align, color)).join('');
      tcs.push(`<w:tc><w:tcPr>${tcpr}</w:tcPr>${ps}</w:tc>`);
    });
    return `<w:tr>${tcs.join('')}</w:tr>`;
  });
  return `<w:tbl><w:tblPr><w:tblW w:w="${tw.reduce((s, w) => s + w, 0)}" w:type="dxa"/>${borders}<w:tblLayout w:type="fixed"/>` +
    `<w:tblCellMar><w:left w:w="72" w:type="dxa"/><w:right w:w="72" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
    `<w:tblGrid>${tw.map(w => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${rows.join('')}</w:tbl>`;
}

/* ---------- 可編輯模式 ---------- */
async function docxEditable(list, { pageBreaks, onProgress }) {
  const doc = await analyzeDocument(list, { onProgress });
  const { bodySz, levelSz } = doc;
  const footer = S.mark.pn.on || doc.pageNumbers;   // 原文有頁碼或開了頁碼設定 → Word 頁尾放自動頁碼
  const media = [], body = [];
  let imgN = 0;
  doc.pages.forEach((pg, i) => {
    const xml = pg.blocks.flatMap((b, bi) => {
      if (b.type === 'table') {
        // 表格後面接表格、或表格是本頁最後一塊時,補一個空段落(相鄰表格會被 Word 合併;分節設定要放在段落裡)
        const next = pg.blocks[bi + 1];
        const t = tableXml(b, pg.contentW, bodySz);
        return !next || next.type === 'table' ? [t, '<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr></w:p>'] : [t];
      }
      if (b.type === 'img') {
        imgN++;
        media.push({ name: `word/media/image${imgN}.jpeg`, data: b.bytes, rid: `rIdImg${imgN}` });
        return imageParaXml(`rIdImg${imgN}`, imgN, b.w, b.h, b.center ? '<w:jc w:val="center"/>' : `<w:ind w:left="${Math.round(b.indent * PT_TWIP)}"/>`);
      }
      let ppr = b.level ? `<w:pStyle w:val="Heading${b.level}"/>` : b.list ? '<w:pStyle w:val="ListParagraph"/>' : '';
      if (b.center) ppr += '<w:jc w:val="center"/>';
      // 字級與樣式預設相同時省略;標題的粗體由標題樣式提供
      const runs = b.segs.map(g => {
        const sz = halfPt(g.st.size), base = b.level ? levelSz[b.level - 1] : bodySz;
        return runXml(g.text, { ...g.st, sz: sz === base ? 0 : sz, bold: b.level ? false : g.st.bold });
      });
      return `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${mergeRuns(runs)}</w:p>`;
    });
    if (!xml.length) xml.push('<w:p/>');
    if (pageBreaks && i < doc.pages.length - 1) xml[xml.length - 1] = withSect(xml[xml.length - 1], sectXml({ w: pg.dw, h: pg.dh, margins: pg.margins }, footer));
    body.push(...xml);
  });
  const last = doc.pages[pageBreaks ? doc.pages.length - 1 : 0];
  return packDocx(body.join('') + sectXml({ w: last.dw, h: last.dh, margins: last.margins }, footer), media, { bodySz, levelSz, footer });
}
/* 相鄰、樣式相同的 run 合併(減少 XML 體積) */
function mergeRuns(runs) {
  const out = [];
  for (const r of runs) {
    const m = r.match(/^<w:r><w:rPr>(.*?)<\/w:rPr><w:t xml:space="preserve">(.*)<\/w:t><\/w:r>$/s);
    const last = out[out.length - 1];
    if (m && last && last.rpr === m[1]) last.text += m[2];
    else out.push(m ? { rpr: m[1], text: m[2] } : { raw: r });
  }
  return out.map(o => o.raw || `<w:r><w:rPr>${o.rpr}</w:rPr><w:t xml:space="preserve">${o.text}</w:t></w:r>`).join('');
}

/* ---------- 保留外觀模式:每頁一張圖 ---------- */
async function docxImages(list, { onProgress }) {
  const bytes = await buildPdf(list, { flatten: true });   // 一律真塗黑
  const doc = await openWithPdfJs(bytes.slice());
  const media = [], body = [];
  let lastPage = null;
  for (let i = 1; i <= doc.numPages; i++) {
    if (onProgress) onProgress(`轉成圖片 ${i} / ${doc.numPages}…`);
    const page = await doc.getPage(i), vp0 = page.getViewport({ scale: 1 });
    const s = Math.min(150 / 72, 6000 / Math.max(vp0.width, vp0.height)), vp = page.getViewport({ scale: s });
    const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: g, viewport: vp }).promise;
    media.push({ name: `word/media/image${i}.jpeg`, data: dataUrlToU8(c.toDataURL('image/jpeg', 0.9)), rid: `rIdImg${i}` });
    c.width = c.height = 1;
    const pg = { w: vp0.width, h: vp0.height, margins: [0, 0, 0, 0] }, k = (vp0.height - 2) / vp0.height;   // 留一點空間,避免多出空白頁
    let p = imageParaXml(`rIdImg${i}`, i, vp0.width * k, vp0.height * k, '<w:jc w:val="center"/>');
    if (i < doc.numPages) p = withSect(p, sectXml(pg, false));
    else lastPage = pg;
    body.push(p);
  }
  doc.destroy();
  return packDocx(body.join('') + sectXml(lastPage, false), media, { bodySz: 24, levelSz: [32, 28, 26], footer: false });
}

/* ---------- 打包 ---------- */
function packDocx(bodyXml, media, { bodySz, levelSz, footer }) {
  const enc = s => new TextEncoder().encode(s);
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const heading = l => `<w:style w:type="paragraph" w:styleId="Heading${l}"><w:name w:val="heading ${l}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>` +
    `<w:pPr><w:keepNext/><w:spacing w:before="${l === 1 ? 360 : 240}" w:after="120"/><w:outlineLvl w:val="${l - 1}"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="${levelSz[l - 1]}"/><w:szCs w:val="${levelSz[l - 1]}"/></w:rPr></w:style>`;
  const styles = `<w:styles ${W_NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="新細明體" w:cs="Arial"/>` +
    `<w:sz w:val="${bodySz}"/><w:szCs w:val="${bodySz}"/><w:lang w:val="en-US" w:eastAsia="zh-TW"/></w:rPr></w:rPrDefault>` +
    `<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
    heading(1) + heading(2) + heading(3) +
    `<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="60"/><w:ind w:left="480" w:hanging="480"/></w:pPr></w:style>` +
    `</w:styles>`;
  const docRels = [`<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`]
    .concat(media.map(m => `<Relationship Id="${m.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${m.name.replace('word/', '')}"/>`))
    .concat(footer ? [`<Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>`] : []);
  const files = [
    ['[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
      `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
      (footer ? `<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>` : '') +
      `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
      `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`],
    ['_rels/.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
      `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`],
    ['docProps/core.xml', `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
      `<dc:title>${xmlEsc(S.baseName)}</dc:title><dc:creator>PDF 工作台</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created></cp:coreProperties>`],
    ['docProps/app.xml', `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>PDF 工作台</Application></Properties>`],
    ['word/_rels/document.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${docRels.join('')}</Relationships>`],
    ['word/styles.xml', styles],
    ['word/document.xml', `<w:document ${W_NS}><w:body>${bodyXml}</w:body></w:document>`],
  ];
  if (footer) files.push(['word/footer1.xml', `<w:ftr ${W_NS}><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>`]);
  const zip = makeZip(files.map(([name, xml]) => ({ name, data: enc(head + xml) })).concat(media.map(m => ({ name: m.name, data: m.data }))));
  return new Blob([zip], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

async function buildDocx(list, { mode = 'edit', pageBreaks = true, onProgress } = {}) {
  return mode === 'image' ? docxImages(list, { onProgress }) : docxEditable(list, { pageBreaks, onProgress });
}
