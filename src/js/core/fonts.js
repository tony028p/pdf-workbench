/* =====================================================================
   內嵌字型:思源黑體 Noto Sans TC Regular(build.py 從 @fontsource 合併,約 1.2 萬字)
   - 畫面上的「黑體」用這個字型(FontFace),匯出時同一個字型以子集嵌入 PDF,
     所以新增的文字、表單的中文值可以寫成真正的文字(可選取、可搜尋),外觀與編輯畫面一致
   - 字型缺少的字(罕用字等)由 sansCovers 判斷,呼叫端改用原本的圖片方式
   ===================================================================== */
const EMBED_SANS = 'PDFWorkbench Sans';
FONTS.sans = `"${EMBED_SANS}",` + FONTS.sans;
let sansBytes, sansParsed = null, sansMid = null;
function sansFontBytes() {
  if (sansBytes === undefined) {
    const el = document.getElementById('font-sans');
    sansBytes = el ? b64ToU8(el.textContent.trim()) : null;
  }
  return sansBytes;
}
/* 畫面用的字型;新增或編輯文字前要等它載入,否則會先用系統字型畫 */
const fontsReady = (async () => {
  const b = sansFontBytes();
  if (!b) return;
  try { const ff = new FontFace(EMBED_SANS, b); await ff.load(); document.fonts.add(ff); }
  catch (err) { console.warn('內嵌字型載入失敗', err); sansBytes = null; }
})();
/* 字型涵蓋這段文字的每一個字(換行除外)才回傳 true。
   forceTextImages:測試用,設為 true 時一律走圖片方式,用來比對兩種方式的位置是否相同 */
let forceTextImages = false;
function sansCovers(text) {
  if (!sansFontBytes() || forceTextImages) return false;
  if (!sansParsed) sansParsed = fontkit.create(sansFontBytes());
  for (const ch of String(text)) {
    if (ch === '\n' || ch === '\r') continue;
    if (!sansParsed.hasGlyphForCodePoint(ch.codePointAt(0))) return false;
  }
  return true;
}
/* 把內嵌字型加進 pdf-lib 文件(子集,存檔時只放用到的字形);同一份文件只嵌入一次 */
const sansEmbeds = new WeakMap();
async function embedSans(lib) {
  if (!sansEmbeds.has(lib)) {
    lib.registerFontkit(fontkit);
    sansEmbeds.set(lib, lib.embedFont(sansFontBytes(), { subset: true }));
  }
  return sansEmbeds.get(lib);
}
/* canvas 的 textBaseline 'middle' 到字母基線的距離(以字級為單位,向下為正):
   畫面上的文字圖用 'middle' 對齊,寫成真文字時要換算成基線位置才會重疊 */
function sansMiddleToBaseline() {
  if (sansMid !== null) return sansMid;
  const g = document.createElement('canvas').getContext('2d');
  g.font = `1000px "${EMBED_SANS}"`;
  g.textBaseline = 'middle';
  const a = g.measureText('中').actualBoundingBoxAscent;
  g.textBaseline = 'alphabetic';
  const b = g.measureText('中').actualBoundingBoxAscent;
  return (sansMid = (b - a) / 1000);
}
