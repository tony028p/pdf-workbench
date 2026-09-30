/* =====================================================================
   簡轉繁:PP-OCRv5 在繁體文件上偶爾輸出簡體字(例如「这」「发」),辨識結果轉回台灣用字
   - 對照表由 build.py 從 OpenCC 產生(S2T_DATA):只含繁體裡不會出現的簡體字,
     「后、里、台、干、面」這類繁體也用的字不動,原本正確的繁體文字不會被改壞
   - 一對多的字依詞組決定(头发→頭髮、发展→發展),其餘用最常見的寫法
   - 轉換前後字數相同(OCR 每個字都有位置框)
   ===================================================================== */
let s2tMaps = null;
function s2tLoad() {
  if (s2tMaps || typeof S2T_DATA === 'undefined') return s2tMaps;
  const chars = new Map(), cs = [...S2T_DATA.chars];
  for (let i = 0; i + 1 < cs.length; i += 2) chars.set(cs[i], cs[i + 1]);
  const phrases = new Map(Object.entries(S2T_DATA.phrases));
  let maxLen = 1;
  for (const k of phrases.keys()) maxLen = Math.max(maxLen, [...k].length);
  return (s2tMaps = { chars, phrases, maxLen });
}
function s2t(text) {
  const m = s2tLoad();
  if (!m) return text;
  const cs = [...text];
  if (!cs.some(c => m.chars.has(c))) return text;
  const out = [];
  for (let i = 0; i < cs.length;) {
    let hit = null;
    for (let L = Math.min(m.maxLen, cs.length - i); L >= 2 && !hit; L--) {
      const v = m.phrases.get(cs.slice(i, i + L).join(''));
      if (v) hit = [...v];
    }
    if (hit) { out.push(...hit); i += hit.length; }
    else { out.push(m.chars.get(cs[i]) || cs[i]); i++; }
  }
  return out.join('');
}
/* OCR 的行與字詞一起轉換(詞組可能跨過一字一詞的中文字詞) */
function s2tOcrLines(lines) {
  for (const ln of lines) {
    const all = [...s2t(ln.words.map(w => w.str).join(''))];
    let k = 0;
    for (const w of ln.words) { const n = [...w.str].length; w.str = all.slice(k, k + n).join(''); k += n; }
    ln.str = s2t(ln.str);
  }
  return lines;
}
