/* =====================================================================
   顯示文字層:在頁面上框出可以選取、搜尋的文字(滑鼠停在框上顯示內容)
   - 藍框:PDF 本身的文字;綠框:文字辨識的結果;紅框:疑似亂碼(私用區字元、替換字元)
   - 與擷取文字相同的內容:塗黑範圍與改字框內的字不算
   - 只在畫面上顯示,不會匯出;只讀取看得到的頁面
   ===================================================================== */
const tvGarbled = s => { const t = s.replace(/\s+/g, ''); return t.length > 0 && (t.match(PUA_RE) || []).length / t.length > 0.3; };

function drawTextView(e, v) {
  v = v || pvMap.get(e.uid);
  if (!v) return;
  const key = e.src + ':' + e.idx, raw = S.showText ? ocrCache.get(key) || textCache.get(key) : null;
  if (!raw) {
    v.gt.replaceChildren();
    if (S.showText && v.visible) rawPageText(e).then(() => { if (S.showText) drawTextView(e); }).catch(() => {});
    return;
  }
  const reds = e.anns.filter(a => a.type === 'redact').map(redactBox), zz = zoomPx();
  const items = eraseItems(raw.items.filter(it => it.str.trim() && !reds.some(r => boxHit(it.box, r))), e);
  v.gt.replaceChildren(...items.map(it => {
    const b = it.box, kind = tvGarbled(it.str) ? 'bad' : raw.ocr ? 'ocr' : 'pdf';
    const r = svgEl('rect', { x: b.x0, y: b.y0, width: b.x1 - b.x0, height: b.y1 - b.y0, class: 'tv ' + kind, 'stroke-width': 1 / zz });
    r.appendChild(svgEl('title', {})).textContent = it.str;
    return r;
  }));
}

$('#btnTextView').onclick = async () => {
  S.showText = !S.showText;
  $('#btnTextView').setAttribute('aria-pressed', S.showText);
  refreshAllOverlays();
  if (!S.showText || !S.pages.length) return;
  const e = curPage(), raw = await rawPageText(e);
  toast(raw.items.some(it => it.str.trim())
    ? '藍框是可以選取、搜尋的文字,綠框是文字辨識的結果,紅框疑似亂碼;滑鼠停在框上可以看到內容'
    : '這一頁沒有可以選取的文字(掃描頁可以先用「文字辨識」)', 5000);
};
