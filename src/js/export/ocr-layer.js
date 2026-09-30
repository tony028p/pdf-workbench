/* =====================================================================
   可搜尋 PDF:把 OCR 結果寫成隱形文字層(ROADMAP §4.6)
   - 保留原本的掃描影像,疊上 text render mode 3(不顯示)的文字:可以搜尋、選取、複製
   - 字型用 Tesseract 的 GlyphLessFont 做法:Type0 / Identity-H,所有字碼都對到同一個空白字形,
     ToUnicode 直接對應 UTF-16 → 不需要內嵌任何中文字型,整份文件只多約 1 KB
   - 每個字詞用 Tm 放到原位(含旋轉),再用 Tz 水平縮放,讓字寬與原圖的字詞一致
   - 塗黑範圍內的字詞不寫入(與擷取文字相同的排除規則)
   ===================================================================== */
// Tesseract 的 tessdata/pdf.ttf(Apache-2.0,572 bytes):兩個字形,GID 1 寬 0.5 em
const GLYPHLESS_TTF_B64 = 'AAEAAAAKAIAAAwAgT1MvMlbeyJQAAAEoAAAAYGNtYXAACgA0AAABkAAAAB5nbHlmFSJBJAAAAbgAAAAYaGVhZAt48WUAAACsAAAANmhoZWEMAgQCAAAA5AAAACRobXR4BAAAAAAAAYgAAAAIbG9jYQAMAAAAAAGwAAAABm1heHAABAAFAAABCAAAACBuYW1l8usW2gAAAdAAAABLcG9zdAABAAEAAAIcAAAAIAABAAAAAQAAsJRxEF8PPPUEBwgAAAAAAM+a/G4AAAAA1MOn8gAAAAAEAAgAAAAAEAACAAAAAAAAAAEAAAgA//8AAAQAAAAAAAQAAAEAAAAAAAAAAAAAAAAAAAACAAEAAAACAAQAAQAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAwAAAZAABQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUAAQABAAAAAAAAAAAAAAAAAAAAAAAAAAAAR09PRwBAAAAAAAAB//8AAAABAAGAAAAAAAAAAAAAAAAAAAABAAAAAAAABAAAAAAAAAIAAQAAAAAAFAADAAAAAAAUAAYACgAAAAAAAAAAAAAAAAAMAAAAAQAAAAAEAAgAAAMAADEhESEEAPwACAAAAAADACoAAAADAAAABQAWAAAAAQAAAAAABQALABYAAwABBAkABQAWAAAAVgBlAHIAcwBpAG8AbgAgADEALgAwVmVyc2lvbiAxLjAAAAEAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAA=';

/* 每份輸出文件建立一次字型物件 */
function glyphlessFont(doc) {
  if (doc.__ocrFont) return doc.__ocrFont;
  const { PDFString } = PDFLib, ctx = doc.context;
  const ttf = b64ToU8(GLYPHLESS_TTF_B64);
  const fontFile = ctx.register(ctx.flateStream(ttf, { Length1: ttf.length }));
  const descriptor = ctx.register(ctx.obj({
    Type: 'FontDescriptor', FontName: 'GlyphLessFont', FontBBox: [0, 0, 500, 1000], Flags: 5, ItalicAngle: 0,
    Ascent: 1000, Descent: -1, CapHeight: 1000, StemV: 80, FontFile2: fontFile,
  }));
  const gids = new Uint8Array(65536 * 2);
  for (let i = 1; i < gids.length; i += 2) gids[i] = 1;          // 每個字碼(CID)都用 GID 1
  const cidFont = ctx.register(ctx.obj({
    Type: 'Font', Subtype: 'CIDFontType2', BaseFont: 'GlyphLessFont', DW: 500,
    CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 },
    FontDescriptor: descriptor, CIDToGIDMap: ctx.register(ctx.flateStream(gids)),
  }));
  const cmap = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n' +
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n' +
    '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n1 beginbfrange\n<0000> <FFFF> <0000>\nendbfrange\n' +
    'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n';
  doc.__ocrFont = ctx.register(ctx.obj({
    Type: 'Font', Subtype: 'Type0', BaseFont: 'GlyphLessFont', Encoding: 'Identity-H',
    DescendantFonts: [cidFont], ToUnicode: ctx.register(ctx.flateStream(cmap)),
  }));
  return doc.__ocrFont;
}

/* 要不要寫隱形文字層:辨識過,而且輸出的頁面上沒有可用的原始文字(掃描頁、亂碼頁,或整頁轉成影像的真塗黑頁) */
async function needsOcrLayer(e, flattened) {
  if (!ocrCache.has(e.src + ':' + e.idx)) return false;
  if (flattened) return true;
  const pdf = await pdfRawPageText(e);   // 與 pageText 的「掃描頁」「亂碼」判斷相同
  return (pdf.chars < 20 && pdf.hasImage) || (pdf.chars >= 10 && pdf.bad / pdf.chars > 0.3);
}

/* 把第 e 頁的辨識結果寫進 page。mapPt:基準座標 → 這一頁的 PDF 使用者空間座標(與畫標註相同) */
async function addOcrTextLayer(doc, page, e, mapPt) {
  const raw = ocrCache.get(e.src + ':' + e.idx);
  const reds = e.anns.filter(a => a.type === 'redact').map(redactBox);
  const kept = eraseItems(raw.items.filter(it => it.str.trim() && !reds.some(r => boxHit(it.box, r))), e);
  if (!kept.length) return;
  const L = PDFLib, ops = [L.pushGraphicsState(), L.beginText(), L.setTextRenderingMode(L.TextRenderingMode.Invisible)];
  const font = page.node.newFontDictionary('FOCR', glyphlessFont(doc));
  const hex = s => { let h = ''; for (let i = 0; i < s.length; i++) h += s.charCodeAt(i).toString(16).padStart(4, '0'); return h; };
  const proj = w => ({ str: w.str, x: w.ox * w.ux + w.oy * w.uy, w: w.width, size: w.size });
  for (const line of readingOrderLines(kept, e, (await richPageInfo(e)).lines)) {
    // 同一行裡不需要空格的相鄰字詞(例如一串中文字、「12.5%」與「，」)合成一段輸出:
    // 各自定位的話,讀取程式看到字與字之間的空隙會自己補空格(「營 運 報 告」)。需要空格的地方把空格接在段尾
    const runs = [];
    line.forEach((it, i) => {
      const prev = line[i - 1], space = prev ? joinInline(proj(prev), proj(it)) : ' ';
      const sameDir = prev && Math.abs(prev.ux - it.ux) < 0.01 && Math.abs(prev.uy - it.uy) < 0.01;
      if (prev && !space && sameDir) { const r = runs[runs.length - 1]; r.str += it.str; r.end = it; }
      else { if (prev && space) runs[runs.length - 1].str += ' '; runs.push({ str: it.str, start: it, end: it }); }
    });
    for (const r of runs) {
      const it = r.start, size = Math.max(...line.filter(w => w === r.start || w === r.end).map(w => w.size));
      // 段的寬度:起點到最後一個字詞的終點(沿文字方向)
      const width = (r.end.ox - it.ox) * it.ux + (r.end.oy - it.oy) * it.uy + r.end.width;
      // 字形範圍的底邊當基線:GlyphLessFont 的字身是基線往上 1 em,選取範圍剛好蓋住原圖的字
      const drop = -it.desc * size, bx = it.ox - it.uy * drop, by = it.oy + it.ux * drop;   // (-uy, ux) 是往字的下方
      const P0 = mapPt(bx, by), P1 = mapPt(bx + it.ux * width, by + it.uy * width);
      const len = Math.hypot(P1[0] - P0[0], P1[1] - P0[1]);
      if (!len) continue;
      const dx = (P1[0] - P0[0]) / len, dy = (P1[1] - P0[1]) / len, n = r.str.replace(/ $/, '').length;
      // 水平縮放:段內的字(不含段尾空格)剛好排滿原圖的寬度
      ops.push(L.setFontAndSize(font, size), L.setTextMatrix(dx, dy, -dy, dx, P0[0], P0[1]),
        L.setCharacterSqueeze(100 * len / (n * size * 0.5)), L.showText(L.PDFHexString.of(hex(r.str))));
    }
  }
  ops.push(L.endText(), L.popGraphicsState());
  page.pushOperators(...ops);
}
