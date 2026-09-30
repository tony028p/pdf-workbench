/* =====================================================================
   選取文字:在頁面圖上疊一層透明文字,可用滑鼠框選、Ctrl+C 複製
   - 只在「選取文字」工具啟用時建立,不干擾其他工具的拖曳
   - 放在 .pvin 裡(基準座標、隨頁面一起 CSS 旋轉),每段文字依方向旋轉並水平縮放對齊原文
   - 塗黑範圍內的文字不放進來(與擷取文字相同的排除規則)
   - 複製時依版面分析重排(多欄順序、中文換行不加空格)
   ===================================================================== */
const tlMeasure = document.createElement('canvas').getContext('2d');
const TL_FONT = 'sans-serif';

function tlKey(e) {
  return zoomPx() + '|' + JSON.stringify(e.anns.filter(a => a.type === 'redact').map(redactBox)) + JSON.stringify(eraseBoxes(e));
}
function removeTextLayer(v) {
  v.tlTok = (v.tlTok || 0) + 1;
  if (v.tl) { v.tl.remove(); v.tl = null; v.tlKeyV = null; }
}
async function buildTextLayer(v) {
  const e = pageByUid(v.uid); if (!e) return;
  const key = tlKey(e);
  if (v.tl && v.tlKeyV === key) return;
  const tok = v.tlTok = (v.tlTok || 0) + 1;
  const raw = await rawPageText(e), rich = await richPageInfo(e);
  if (tok !== v.tlTok || S.tool !== 'seltext' || !pvMap.has(v.uid)) return;
  const zz = zoomPx(), reds = e.anns.filter(a => a.type === 'redact').map(redactBox);
  const kept = eraseItems(raw.items.filter(it => it.str.trim() && !reds.some(r => boxHit(it.box, r))), e);
  // 依閱讀順序排列(PDF 內部的繪製順序常與閱讀順序不同,拖曳選取會跳過字)
  const order = readingOrderLines(kept, e, rich.lines).flat();
  const div = document.createElement('div');
  div.className = 'tl';
  for (const it of order) {
    const fs = it.size * zz, span = document.createElement('span');
    span.textContent = it.str;
    // 用 PDF 內嵌的字型(pdf.js 畫頁面時已載入,名稱就是 fontName),字寬與原文一致,行尾才不會越選越偏
    const family = `"${it.font}", ${TL_FONT}`;
    tlMeasure.font = `${fs}px ${family}`;
    const natural = tlMeasure.measureText(it.str).width, k = natural > 0 ? it.width * zz / natural : 1;
    span.style.cssText = `left:${it.ox * zz}px;top:${it.oy * zz}px;font-size:${fs}px;font-family:${family.replace(/"/g, "'")};` +
      `transform:rotate(${it.angle}deg) translateY(${-it.asc * fs}px) scaleX(${k})`;
    span.__it = it;
    div.appendChild(span);
  }
  const eoc = document.createElement('div');   // 見下方「拖過頭」的處理
  eoc.className = 'eoc';
  div.appendChild(eoc);
  if (v.tl) v.tl.remove();
  v.tl = div; v.tlKeyV = key;
  v.inner.appendChild(div);
}
/* 依目前工具建立或移除所有可見頁面的文字層(塗黑或縮放改變時才重建) */
function syncTextLayers() {
  for (const v of pvMap.values()) {
    if (S.tool === 'seltext' && v.visible) buildTextLayer(v);
    else removeTextLayer(v);
  }
}

/* 複製:取出選取範圍內的文字片段(頭尾可能只選到一部分),依頁面做版面分析後再放進剪貼簿 */
function selectedTextFromLayers() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const inLayer = n => n && (n.nodeType === 1 ? n : n.parentElement)?.closest('.tl');
  if (!inLayer(range.startContainer) && !inLayer(range.endContainer) && !inLayer(range.commonAncestorContainer)) return null;
  const pages = [];
  for (const e of S.pages) {
    const v = pvMap.get(e.uid); if (!v || !v.tl) continue;
    const items = [];
    for (const span of v.tl.children) {
      if (!span.__it || !sel.containsNode(span, true)) continue;
      const it = span.__it, node = span.firstChild;
      let a = 0, b = it.str.length;
      if (range.startContainer === node || range.startContainer === span) a = range.startContainer === node ? range.startOffset : 0;
      if (range.endContainer === node || range.endContainer === span) b = range.endContainer === node ? range.endOffset : b;
      if (b <= a) continue;
      const f0 = a / it.str.length, f1 = b / it.str.length;
      items.push({ ...it, str: it.str.slice(a, b), ox: it.ox + it.ux * it.width * f0, oy: it.oy + it.uy * it.width * f0, width: it.width * (f1 - f0) });
    }
    const rich = richCache.get(e.src + ':' + e.idx);   // 有框線表格需要線段;沒算過就只偵測無框線表格
    if (items.length) pages.push(layoutPageItems(items, e, rich ? rich.lines : []).map(p => p.text).join('\n\n'));
  }
  return pages.length ? pages.join('\n\n') : null;
}
/* 拖過頭:滑鼠移到文字外的空白處時,瀏覽器會把選取終點算到文字層開頭,整個選取就不見了。
   做法同 pdf.js:拖曳選字期間顯示一個鋪滿文字層的空白區塊(.eoc,在文字底下),
   並一直把它移到目前選取終點那段文字的旁邊,空白處的終點就會停在最後選到的字。 */
pagesEl.addEventListener('pointerdown', ev => {
  if (S.tool !== 'seltext' || ev.button !== 0) return;
  const span = ev.target.closest('.tl > span');
  if (span) span.parentElement.classList.add('selecting');
});
document.addEventListener('pointerup', () => $$('#pages .tl.selecting').forEach(t => t.classList.remove('selecting')));
document.addEventListener('selectionchange', () => {
  if (S.tool !== 'seltext') return;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.focusNode) return;
  const el = sel.focusNode.nodeType === 3 ? sel.focusNode.parentElement : sel.focusNode;
  const tl = el && el.closest('.tl.selecting');
  if (!tl || el.tagName !== 'SPAN') return;
  const pos = sel.anchorNode.compareDocumentPosition(sel.focusNode);
  const forward = sel.anchorNode === sel.focusNode ? sel.anchorOffset <= sel.focusOffset : !(pos & Node.DOCUMENT_POSITION_PRECEDING);
  const eoc = tl.querySelector('.eoc');
  tl.insertBefore(eoc, forward ? el.nextSibling : el);
});
document.addEventListener('copy', ev => {
  if (S.tool !== 'seltext') return;
  const text = selectedTextFromLayers();
  if (text == null) return;
  ev.clipboardData.setData('text/plain', text);
  ev.preventDefault();
});
